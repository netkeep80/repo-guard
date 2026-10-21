import {
  readDurableDocumentIdentity,
  type FactReadContext,
} from "./document-facts.mjs";
import { strictCanonicalJson } from "./runtime/canonical-requirements.mjs";
import {
  analyzeProjectionCurrent,
  type ProjectionCurrentAnalysis,
  type ProjectionCurrentGeneratorIdentity,
  type ProjectionResolvedSources,
} from "./projection-analysis.mjs";
import {
  normalizeProjectionBuildRecordDetached,
  normalizeProjectionModel,
  type ProjectionBuildRecord,
  type ProjectionModel,
} from "./projection-model.mjs";
import {
  analyzeProjectionOwnership,
  type ProjectionOwnershipReport,
} from "./projection-ownership.mjs";

type JsonObject = Record<string, unknown>;

export interface ProjectionCheckLiveEntry {
  state: "live";
  model: ProjectionModel;
  build: ProjectionBuildRecord;
  current_generator: ProjectionCurrentGeneratorIdentity;
}

export interface ProjectionCheckRetainedEntry {
  state: "retained";
  model: ProjectionModel;
}

export type ProjectionCheckEntry =
  | ProjectionCheckLiveEntry
  | ProjectionCheckRetainedEntry;

export interface ProjectionCheckState {
  schema: "repo-guard/projection-check/v0";
  entries: ProjectionCheckEntry[];
  present: boolean;
}

export interface ProjectionCheckDiagnostic {
  code: string;
  subject: string;
  detail?: string;
}

export interface ProjectionCheckReport {
  ok: boolean;
  present: boolean;
  ownership: ProjectionOwnershipReport;
  analyses: ProjectionCurrentAnalysis[];
  diagnostics: ProjectionCheckDiagnostic[];
}

export interface ProjectionRequirementResolution {
  digest: string;
  path: string;
}

export type ProjectionRequirementResolver =
  (requirementId: string) => ProjectionRequirementResolution | null;

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(label + " must be an object");
  }
  return value as JsonObject;
}

function fields(value: JsonObject, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !set.has(key)).sort();
  if (unknown.length) fail(label + " contains unknown field(s): " + unknown.join(", "));
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(label + " must be a non-empty string");
  return value.trim();
}

function digest(value: unknown, label: string): string {
  const normalized = nonEmpty(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) fail(label + " must be a sha256 digest");
  return normalized;
}

function currentGenerator(value: unknown, label: string): ProjectionCurrentGeneratorIdentity {
  const input = object(value, label);
  fields(input, ["tool_identity", "configuration_digest"], label);
  return {
    tool_identity: nonEmpty(input.tool_identity, label + ".tool_identity"),
    configuration_digest: digest(
      input.configuration_digest,
      label + ".configuration_digest",
    ),
  };
}

function entry(value: unknown, index: number): ProjectionCheckEntry {
  const label = `ProjectionCheck.entries[${index}]`;
  const input = object(value, label);
  fields(input, ["state", "model", "build", "current_generator"], label);
  const model = normalizeProjectionModel(input.model);

  if (input.state === "retained") {
    if (input.build !== undefined || input.current_generator !== undefined) {
      fail(label + " retained entry must not define build/current_generator");
    }
    return { state: "retained", model };
  }

  if (input.state !== "live") {
    fail(label + '.state must be "live" or "retained"');
  }
  if (input.build === undefined || input.current_generator === undefined) {
    fail(label + " live entry requires build and current_generator");
  }
  return {
    state: "live",
    model,
    build: normalizeProjectionBuildRecordDetached(input.build),
    current_generator: currentGenerator(
      input.current_generator,
      label + ".current_generator",
    ),
  };
}

export function parseProjectionCheckState(
  raw: string | Buffer | null | undefined,
): ProjectionCheckState {
  if (raw === null || raw === undefined) {
    return {
      schema: "repo-guard/projection-check/v0",
      entries: [],
      present: false,
    };
  }
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const input = object(strictCanonicalJson(text), "ProjectionCheck");
  fields(input, ["schema", "entries"], "ProjectionCheck");
  if (input.schema !== "repo-guard/projection-check/v0") {
    fail('ProjectionCheck.schema must be "repo-guard/projection-check/v0"');
  }
  if (!Array.isArray(input.entries)) fail("ProjectionCheck.entries must be an array");
  const entries = input.entries.map(entry).sort(
    (left, right) =>
      left.model.id.localeCompare(right.model.id, "en")
      || left.state.localeCompare(right.state, "en"),
  );
  return {
    schema: "repo-guard/projection-check/v0",
    entries,
    present: true,
  };
}

function representationFormat(path: string): "json" | "yaml" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return null;
}

function resolveProjectionSources(
  model: ProjectionModel,
  input: {
    readHead: (path: string) => unknown;
    resolveRequirement?: ProjectionRequirementResolver;
  },
  diagnostics: ProjectionCheckDiagnostic[],
): ProjectionResolvedSources {
  const resolved: Record<string, { digest: string; path: string }> = Object.create(null);

  for (const source of model.sources) {
    if (source.kind !== "repository_subject") continue;

    if (source.subject.kind === "requirement") {
      const item = input.resolveRequirement?.(source.subject.id) || null;
      if (!item) {
        diagnostics.push({
          code: "projection_subject_unresolved",
          subject: model.id + ":source:" + source.id,
          detail: "Requirement " + source.subject.id + " is not available in the canonical native Requirement index",
        });
        continue;
      }
      resolved[source.id] = { digest: item.digest, path: item.path };
      continue;
    }

    if (source.subject.kind !== "relation") continue;
    const representation = source.representation;
    if (!representation) {
      diagnostics.push({
        code: "projection_subject_unresolved",
        subject: model.id + ":source:" + source.id,
        detail: "named Relation requires an exact repository representation",
      });
      continue;
    }

    const format = representationFormat(representation.path);
    if (!format) {
      diagnostics.push({
        code: "projection_subject_binding",
        subject: model.id + ":source:" + source.id,
        detail: "named Relation representation must be JSON or YAML so its logical id can be verified",
      });
      continue;
    }

    let raw: unknown;
    try {
      raw = input.readHead(representation.path);
    } catch (error) {
      diagnostics.push({
        code: "projection_subject_unresolved",
        subject: model.id + ":source:" + source.id,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (raw === null || raw === undefined) {
      diagnostics.push({
        code: "projection_subject_unresolved",
        subject: model.id + ":source:" + source.id,
        detail: "Relation representation is missing at exact HEAD",
      });
      continue;
    }

    try {
      const identity = readDurableDocumentIdentity(
        Buffer.isBuffer(raw) ? raw : String(raw),
        format,
        representation.pointer || "",
      );
      const value = identity.value;
      const id = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).id
        : undefined;
      if (id !== source.subject.id) {
        diagnostics.push({
          code: "projection_subject_binding",
          subject: model.id + ":source:" + source.id,
          detail: `Relation SubjectRef "${source.subject.id}" does not match represented record id "${String(id ?? "<missing>")}"`,
        });
        continue;
      }
      resolved[source.id] = {
        digest: identity.digest,
        path: representation.path,
      };
    } catch (error) {
      diagnostics.push({
        code: "projection_subject_unresolved",
        subject: model.id + ":source:" + source.id,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return resolved;
}

export function evaluateProjectionCheck(input: {
  baseRaw: string | Buffer | null | undefined;
  headRaw: string | Buffer | null | undefined;
  readHead: (path: string) => unknown;
  facts: FactReadContext;
  resolveRequirement?: ProjectionRequirementResolver;
}): ProjectionCheckReport {
  const diagnostics: ProjectionCheckDiagnostic[] = [];
  let base: ProjectionCheckState;
  let head: ProjectionCheckState;
  try {
    base = parseProjectionCheckState(input.baseRaw);
  } catch (error) {
    diagnostics.push({
      code: "projection_base_state_invalid",
      subject: ".repo-guard/projections.json",
      detail: error instanceof Error ? error.message : String(error),
    });
    base = {
      schema: "repo-guard/projection-check/v0",
      entries: [],
      present: true,
    };
  }
  try {
    head = parseProjectionCheckState(input.headRaw);
  } catch (error) {
    diagnostics.push({
      code: "projection_head_state_invalid",
      subject: ".repo-guard/projections.json",
      detail: error instanceof Error ? error.message : String(error),
    });
    head = {
      schema: "repo-guard/projection-check/v0",
      entries: [],
      present: true,
    };
  }

  const live = head.entries.filter(
    (item): item is ProjectionCheckLiveEntry => item.state === "live",
  );
  const retained = head.entries.filter(
    (item): item is ProjectionCheckRetainedEntry => item.state === "retained",
  );

  const ownership = analyzeProjectionOwnership({
    live: live.map((item) => item.model),
    retained: retained.map((item) => item.model),
    base: base.entries.map((item) => item.model),
    readHead: input.readHead,
  });

  for (const conflict of ownership.conflicts) {
    diagnostics.push({
      code: "projection_ownership_" + conflict.code,
      subject: conflict.subject,
      ...(conflict.detail ? { detail: conflict.detail } : {}),
    });
  }
  for (const key of ownership.missing) {
    diagnostics.push({ code: "projection_missing", subject: key });
  }
  for (const key of ownership.orphan) {
    diagnostics.push({ code: "projection_orphan", subject: key });
  }

  const invalidOwnership = new Set(ownership.invalid_projections);
  const analyses = live.map((item) => {
    const resolvedSources = resolveProjectionSources(item.model, input, diagnostics);
    const analysis = analyzeProjectionCurrent(
      item.model,
      item.build,
      input.facts,
      item.current_generator,
      resolvedSources,
    );
    if (!invalidOwnership.has(item.model.id)) return analysis;
    return {
      ...analysis,
      freshness: "BROKEN" as const,
      reasons: [...new Set([...analysis.reasons, "ownership_conflict"])].sort(),
    };
  }).sort((left, right) =>
    (left.projection_id || "").localeCompare(right.projection_id || "", "en")
  );

  for (const analysis of analyses) {
    if (analysis.freshness === "CURRENT") continue;
    diagnostics.push({
      code: "projection_" + analysis.freshness.toLowerCase(),
      subject: analysis.projection_id || "<invalid>",
      detail: analysis.reasons.join(","),
    });
  }

  diagnostics.sort((left, right) =>
    left.code.localeCompare(right.code, "en")
    || left.subject.localeCompare(right.subject, "en")
    || (left.detail || "").localeCompare(right.detail || "", "en")
  );

  return {
    ok: diagnostics.length === 0 && ownership.ok,
    present: base.present || head.present,
    ownership,
    analyses,
    diagnostics,
  };
}
