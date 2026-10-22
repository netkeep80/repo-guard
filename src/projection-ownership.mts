import {
  normalizeProjectionModel,
  type ProjectionModel,
  type ProjectionTarget,
} from "./projection-model.mjs";
import {
  readMarkdownNode,
  readOwnedMarkdownBlock,
  type MarkdownOwnedBlock,
} from "./markdown-structure.mjs";

export type ProjectionInventoryState = "live" | "retained" | "base";

export type ProjectionOwnershipConflictCode =
  | "invalid_projection"
  | "duplicate_projection_id"
  | "multiple_writers"
  | "live_retained_overlap"
  | "locator_alias"
  | "duplicate_block_id"
  | "locator_drift"
  | "insufficient_locator"
  | "unreadable_target"
  | "malformed_target"
  | "containment"
  | "managed_overlap"
  | "unknown_origin";

export interface ProjectionOwnershipConflict {
  code: ProjectionOwnershipConflictCode;
  subject: string;
  path?: string;
  detail?: string;
}

export interface ProjectionObservedCandidate {
  identity: string;
  path: string;
  target_key?: string;
  detail?: string;
}

export interface ProjectionOwnershipReport {
  ok: boolean;
  ownership_closed: false;
  coverage: {
    status: "incomplete";
    expected_from: "live-and-retained-declarations";
    observed_from: "live-retained-and-base-declarations";
    candidate_marker_detection: "caller-supplied-only";
    arbitrary_undeclared_marker_scan: false;
  };
  live_expected: string[];
  retained: string[];
  base: string[];
  observed: string[];
  missing: string[];
  orphan: string[];
  unknown_origin: string[];
  invalid_projections: string[];
  conflicts: ProjectionOwnershipConflict[];
}

export interface ProjectionOwnershipInput {
  live: readonly unknown[];
  retained?: readonly unknown[];
  base?: readonly unknown[];
  observedCandidates?: readonly ProjectionObservedCandidate[];
  readHead: (path: string) => unknown;
}

interface ModelEntry {
  state: ProjectionInventoryState;
  model: ProjectionModel;
}

interface TargetSpec {
  key: string;
  locator_key: string;
  path: string;
  target: ProjectionTarget;
  state: ProjectionInventoryState;
  projection_id: string;
}

interface ObservedRegion {
  key: string;
  path: string;
  start: number;
  end: number;
  state: ProjectionInventoryState;
  projection_id: string;
}

interface Observation {
  spec: TargetSpec;
  observed: boolean;
  region?: ObservedRegion;
}

function targetKey(target: ProjectionTarget): string {
  if (target.ownership === "generated") {
    return JSON.stringify({ kind: "whole_file", path: target.path });
  }
  if (target.locator?.kind === "markdown_owned_block") {
    return JSON.stringify({
      kind: "markdown_owned_block",
      path: target.path,
      anchor_id: target.locator.anchor_id,
      block_id: target.locator.block_id,
    });
  }
  return JSON.stringify({
    kind: "markdown_anchor",
    path: target.path,
    anchor_id: target.locator?.anchor_id ?? "",
  });
}

function locatorKey(target: ProjectionTarget): string {
  if (target.ownership === "generated") return targetKey(target);
  if (target.locator?.kind === "markdown_owned_block") {
    return JSON.stringify({
      kind: "markdown_owned_block",
      path: target.path,
      anchor_id: target.locator.anchor_id,
      block_id: target.locator.block_id,
      begin_marker: target.locator.begin_marker,
      end_marker: target.locator.end_marker,
    });
  }
  return targetKey(target);
}

function normalizeEntries(
  values: readonly unknown[],
  state: ProjectionInventoryState,
  conflicts: ProjectionOwnershipConflict[],
): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const ids = new Set<string>();
  values.forEach((value, index) => {
    let model: ProjectionModel;
    try {
      model = normalizeProjectionModel(value);
    } catch (error) {
      conflicts.push({
        code: "invalid_projection",
        subject: `${state}[${index}]`,
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (ids.has(model.id)) {
      conflicts.push({
        code: "duplicate_projection_id",
        subject: `${state}:${model.id}`,
      });
      return;
    }
    ids.add(model.id);
    entries.push({ state, model });
  });
  return entries;
}

function specs(entries: readonly ModelEntry[]): TargetSpec[] {
  return entries.map(({ state, model }) => ({
    key: targetKey(model.target),
    locator_key: locatorKey(model.target),
    path: model.target.path,
    target: model.target,
    state,
    projection_id: model.id,
  }));
}

function readHeadText(
  input: ProjectionOwnershipInput,
  path: string,
  conflicts: ProjectionOwnershipConflict[],
  subject: string,
): string | null {
  let raw: unknown;
  try {
    raw = input.readHead(path);
  } catch (error) {
    conflicts.push({
      code: "unreadable_target",
      subject,
      path,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (raw === null || raw === undefined) return null;
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
}

function observeOwnedBlock(
  source: string,
  spec: TargetSpec,
  conflicts: ProjectionOwnershipConflict[],
): { observed: boolean; region?: ObservedRegion } {
  if (spec.target.ownership !== "hybrid" || spec.target.locator?.kind !== "markdown_owned_block") {
    return { observed: false };
  }
  const locator = spec.target.locator;
  const blockSpec = {
    blockId: locator.block_id,
    beginMarker: locator.begin_marker,
    endMarker: locator.end_marker,
  };

  let block: MarkdownOwnedBlock | null;
  try {
    block = readOwnedMarkdownBlock(source, blockSpec);
  } catch (error) {
    conflicts.push({
      code: "malformed_target",
      subject: spec.key,
      path: spec.path,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { observed: false };
  }

  let node;
  try {
    node = readMarkdownNode(source, locator.anchor_id, {
      transparentOwnedBlocks: [blockSpec],
    });
  } catch (error) {
    conflicts.push({
      code: "malformed_target",
      subject: spec.key,
      path: spec.path,
      detail: error instanceof Error ? error.message : String(error),
    });
    if (!block) return { observed: false };
    return {
      observed: true,
      region: {
        key: spec.key,
        path: spec.path,
        start: block.start,
        end: block.end,
        state: spec.state,
        projection_id: spec.projection_id,
      },
    };
  }

  if (!block) return { observed: false };
  if (block.start < node.start || block.end > node.end) {
    conflicts.push({
      code: "containment",
      subject: spec.key,
      path: spec.path,
      detail: `owned block "${locator.block_id}" is outside anchor "${locator.anchor_id}" node`,
    });
  }
  return {
    observed: true,
    region: {
      key: spec.key,
      path: spec.path,
      start: block.start,
      end: block.end,
      state: spec.state,
      projection_id: spec.projection_id,
    },
  };
}

function observeSpec(
  input: ProjectionOwnershipInput,
  spec: TargetSpec,
  conflicts: ProjectionOwnershipConflict[],
): { observed: boolean; region?: ObservedRegion } {
  const source = readHeadText(input, spec.path, conflicts, spec.key);
  if (source === null) return { observed: false };

  if (spec.target.ownership === "generated") {
    return {
      observed: true,
      region: {
        key: spec.key,
        path: spec.path,
        start: 0,
        end: source.length,
        state: spec.state,
        projection_id: spec.projection_id,
      },
    };
  }

  if (spec.target.locator?.kind === "markdown_owned_block") {
    return observeOwnedBlock(source, spec, conflicts);
  }

  conflicts.push({
    code: "insufficient_locator",
    subject: spec.key,
    path: spec.path,
    detail: "hybrid markdown_anchor is address-only and does not establish an owned writable region",
  });

  const anchorId = spec.target.locator?.anchor_id;
  if (!anchorId) return { observed: false };
  try {
    readMarkdownNode(source, anchorId);
    return { observed: false };
  } catch (error) {
    conflicts.push({
      code: "malformed_target",
      subject: spec.key,
      path: spec.path,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { observed: false };
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function pushDeclaredConflicts(
  allSpecs: readonly TargetSpec[],
  conflicts: ProjectionOwnershipConflict[],
): void {
  const active = allSpecs.filter((spec) => spec.state !== "base");
  const live = active.filter((spec) => spec.state === "live");
  const retained = active.filter((spec) => spec.state === "retained");

  const projectionStates = new Map<string, Set<string>>();
  for (const spec of active) {
    const states = projectionStates.get(spec.projection_id) || new Set<string>();
    states.add(spec.state);
    projectionStates.set(spec.projection_id, states);
  }
  for (const [projectionId, states] of projectionStates) {
    if (states.size > 1) {
      conflicts.push({
        code: "duplicate_projection_id",
        subject: projectionId,
        detail: [...states].sort().join(","),
      });
    }
  }

  const byTarget = new Map<string, TargetSpec[]>();
  for (const spec of active) {
    const values = byTarget.get(spec.key) || [];
    values.push(spec);
    byTarget.set(spec.key, values);
  }

  for (const [key, values] of byTarget) {
    const liveValues = values.filter((spec) => spec.state === "live");
    const liveWriters = sorted(liveValues.map((spec) => spec.projection_id));
    if (liveWriters.length > 1) {
      conflicts.push({
        code: "multiple_writers",
        subject: key,
        detail: liveWriters.join(","),
      });
    }

    if (liveValues.length && values.some((spec) => spec.state === "retained")) {
      conflicts.push({
        code: "live_retained_overlap",
        subject: key,
        path: values[0]?.path,
      });
    }

    const locatorVariants = sorted(values.map((spec) => spec.locator_key));
    if (locatorVariants.length > 1) {
      conflicts.push({
        code: "locator_alias",
        subject: key,
        path: values[0]?.path,
        detail: "same logical target is declared with multiple locator spellings",
      });
    }
  }

  const byBlockId = new Map<string, TargetSpec[]>();
  for (const spec of active) {
    if (
      spec.target.ownership !== "hybrid"
      || spec.target.locator?.kind !== "markdown_owned_block"
    ) continue;
    const blockKey = JSON.stringify({
      path: spec.path,
      block_id: spec.target.locator.block_id,
    });
    const values = byBlockId.get(blockKey) || [];
    values.push(spec);
    byBlockId.set(blockKey, values);
  }
  for (const [blockKey, values] of byBlockId) {
    const logicalTargets = sorted(values.map((spec) => spec.key));
    if (logicalTargets.length <= 1) continue;
    conflicts.push({
      code: "duplicate_block_id",
      subject: blockKey,
      path: values[0]?.path,
      detail: "stable block_id must be unique within one repository path",
    });
  }

  const byPath = new Map<string, TargetSpec[]>();
  for (const spec of active) {
    const values = byPath.get(spec.path) || [];
    values.push(spec);
    byPath.set(spec.path, values);
  }
  for (const [path, values] of byPath) {
    const wholeFile = values.filter((spec) => spec.target.ownership === "generated");
    if (!wholeFile.length || values.length === wholeFile.length) continue;
    conflicts.push({
      code: "managed_overlap",
      subject: path,
      path,
      detail: "whole-file ownership conflicts with a managed region on the same path",
    });
  }

  // Retention protects bytes even though it does not grant an active writer.
  void retained;
}

function pushObservedOverlap(
  regions: readonly ObservedRegion[],
  conflicts: ProjectionOwnershipConflict[],
): void {
  const protectedRegions = regions.filter((region) => region.state !== "base");
  const ordered = [...protectedRegions].sort(
    (left, right) =>
      left.path.localeCompare(right.path, "en")
      || left.start - right.start
      || left.end - right.end
      || left.key.localeCompare(right.key, "en")
      || left.projection_id.localeCompare(right.projection_id, "en"),
  );
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex]!;
      if (right.path !== left.path) break;
      if (right.start >= left.end) break;
      if (
        left.key === right.key
        && left.state === right.state
        && left.projection_id === right.projection_id
      ) {
        continue;
      }
      if (left.start < right.end && right.start < left.end) {
        conflicts.push({
          code: "managed_overlap",
          subject: `${left.key} <-> ${right.key}`,
          path: left.path,
          detail: `intervals [${left.start},${left.end}) and [${right.start},${right.end}) overlap`,
        });
      }
    }
  }
}

export function analyzeProjectionOwnership(
  input: ProjectionOwnershipInput,
): ProjectionOwnershipReport {
  const conflicts: ProjectionOwnershipConflict[] = [];
  const entries = [
    ...normalizeEntries(input.live, "live", conflicts),
    ...normalizeEntries(input.retained || [], "retained", conflicts),
    ...normalizeEntries(input.base || [], "base", conflicts),
  ];
  const allSpecs = specs(entries);
  pushDeclaredConflicts(allSpecs, conflicts);

  const liveExpected = sorted(
    allSpecs.filter((spec) => spec.state === "live").map((spec) => spec.key),
  );
  const retained = sorted(
    allSpecs.filter((spec) => spec.state === "retained").map((spec) => spec.key),
  );
  const base = sorted(
    allSpecs.filter((spec) => spec.state === "base").map((spec) => spec.key),
  );

  const observations: Observation[] = [];
  const regions: ObservedRegion[] = [];
  for (const spec of [...allSpecs].sort(
    (left, right) =>
      left.state.localeCompare(right.state, "en")
      || left.key.localeCompare(right.key, "en")
      || left.locator_key.localeCompare(right.locator_key, "en")
      || left.projection_id.localeCompare(right.projection_id, "en"),
  )) {
    const result = observeSpec(input, spec, conflicts);
    observations.push({ spec, ...result });
    if (result.region) regions.push(result.region);
  }
  pushObservedOverlap(regions, conflicts);

  const observedLive = new Set(
    observations
      .filter((item) => item.spec.state === "live" && item.observed)
      .map((item) => item.spec.key),
  );
  const observedRetained = new Set(
    observations
      .filter((item) => item.spec.state === "retained" && item.observed)
      .map((item) => item.spec.key),
  );
  const observedBase = new Set(
    observations
      .filter((item) => item.spec.state === "base" && item.observed)
      .map((item) => item.spec.key),
  );

  const currentObserved = new Set([...observedLive, ...observedRetained]);
  const observed = new Set([...currentObserved, ...observedBase]);
  const expected = new Set([...liveExpected, ...retained]);

  const missing = sorted([...expected].filter((key) => !currentObserved.has(key)));
  const orphan = sorted([...observedBase].filter((key) => !expected.has(key)));

  for (const key of missing) {
    if (observedBase.has(key)) {
      conflicts.push({
        code: "locator_drift",
        subject: key,
        detail: "BASE locator still resolves but current live/retained locator does not",
      });
    }
  }

  const knownKeys = new Set([...liveExpected, ...retained, ...base]);
  const unknownOrigin = sorted(
    (input.observedCandidates || [])
      .filter((candidate) => !candidate.target_key || !knownKeys.has(candidate.target_key))
      .map((candidate) => candidate.identity),
  );
  for (const candidate of input.observedCandidates || []) {
    if (candidate.target_key && knownKeys.has(candidate.target_key)) continue;
    conflicts.push({
      code: "unknown_origin",
      subject: candidate.identity,
      path: candidate.path,
      detail: candidate.detail || "managed-looking candidate has no live/retained/BASE ownership provenance",
    });
  }

  conflicts.sort(
    (left, right) =>
      left.code.localeCompare(right.code, "en")
      || left.subject.localeCompare(right.subject, "en")
      || (left.path || "").localeCompare(right.path || "", "en")
      || (left.detail || "").localeCompare(right.detail || "", "en"),
  );

  const activeSpecs = allSpecs.filter((spec) => spec.state !== "base");
  const invalidProjectionIds = new Set<string>();
  for (const conflict of conflicts) {
    for (const spec of activeSpecs) {
      if (
        conflict.subject === spec.projection_id
        || conflict.subject === spec.key
        || conflict.subject.includes(spec.key)
        || (conflict.path !== undefined && conflict.path === spec.path)
      ) {
        invalidProjectionIds.add(spec.projection_id);
      }
    }
  }

  return {
    ok: conflicts.length === 0 && missing.length === 0 && orphan.length === 0,
    ownership_closed: false,
    coverage: {
      status: "incomplete",
      expected_from: "live-and-retained-declarations",
      observed_from: "live-retained-and-base-declarations",
      candidate_marker_detection: "caller-supplied-only",
      arbitrary_undeclared_marker_scan: false,
    },
    live_expected: liveExpected,
    retained,
    base,
    observed: sorted(observed),
    missing,
    orphan,
    unknown_origin: unknownOrigin,
    invalid_projections: sorted(invalidProjectionIds),
    conflicts,
  };
}
