import type { ParsedDiffFile } from "./diff/parser.mjs";
import { evaluateProjectionCheck } from "./projection-check.mjs";
import { loadNativeRequirements, lowerNativeRequirements } from "./runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "./runtime/requirement-closure.mjs";
import { evaluateTrackedResourceClosure } from "./runtime/resource-closure.mjs";
import { createResourceResolver } from "./runtime/resource-resolver.mjs";
import {
  evaluateTransitionCauseClosure,
  type ResourceDeltaObservation,
  type TransitionObservationFact,
} from "./runtime/transition-closure.mjs";

type Diagnostic = { code: string; subject: string; detail?: string };
type Native = ReturnType<typeof loadNativeRequirements>;
type Lowered = ReturnType<typeof lowerNativeRequirements>;
type J1 = ReturnType<typeof evaluateTrackedResourceClosure>;

export interface CompilerSnapshotEntry {
  mode: string;
  type: "blob" | "commit";
  object: string;
  path: string;
}

export interface CompilerSnapshotObservation {
  revision: string;
  treeIdentity: string;
  entries: readonly CompilerSnapshotEntry[];
  readBytes: (path: string) => Buffer | null | undefined;
}

export interface CompilerTransitionObservation {
  files: readonly ParsedDiffFile[];
  resourceDeltas: readonly ResourceDeltaObservation[];
  observationFacts: readonly TransitionObservationFact[];
}

export interface CompilerInput {
  repository: string;
  base: CompilerSnapshotObservation;
  head: CompilerSnapshotObservation;
  transition: CompilerTransitionObservation;
}

interface CompilerState {
  revision: string;
  entries: readonly CompilerSnapshotEntry[];
  native: Native;
  requirements: Lowered["requirements"];
  lifecycle: Lowered["lifecycle"];
  resourceRelations: Lowered["resourceRelations"];
  compiledConstraints: Lowered["compiledConstraints"];
  j2: ReturnType<typeof evaluateRootedRequirements>;
  j1: J1;
}

function structuralRoots(native: Native) {
  return native.requirements
    .filter(item => !item.relations.some(relation => relation.predicate === "derives_from"))
    .map(item => item.semantic);
}

export function evaluateCompiler(input: CompilerInput) {
  const diagnostics: Diagnostic[] = [];
  const states = new Map<string, CompilerState>();
  const snapshots = new Map<string, CompilerSnapshotObservation>();
  snapshots.set(input.base.revision, input.base);
  snapshots.set(input.head.revision, input.head);

  const open = (revision: string): CompilerState => {
    const existing = states.get(revision);
    if (existing) return existing;
    const snapshot = snapshots.get(revision);
    if (!snapshot) throw new Error("compiler snapshot is unavailable for exact revision " + revision);
    const trackedPaths = snapshot.entries.map(entry => entry.path);
    const tracked = new Set(trackedPaths);
    const readExact = (sha: string, path: string) =>
      sha === revision && tracked.has(path) ? snapshot.readBytes(path) : null;
    const paths = trackedPaths.filter(path => /^requirements\/.*\.rg\.(?:yaml|json)$/.test(path));
    const native = loadNativeRequirements({
      repository: input.repository,
      revision,
      paths,
      readFile: readExact,
    });
    const lowered = lowerNativeRequirements(native);
    const j2 = evaluateRootedRequirements({
      requirements: lowered.requirements,
      trustedRoots: structuralRoots(native),
      nativeRequirements: native.requirements,
    });
    let j1: J1 = {
      ok: false,
      justified: [],
      unjustified: snapshot.entries.map(entry => entry.path),
      errors: [{ code: "j2_not_rooted", path: "" }],
      explanations: {},
      owners: {},
      collections: [],
    };
    if (lowered.requirements.ok && j2.ok) {
      const resolver = createResourceResolver({
        repository: input.repository,
        revision,
        requirements: lowered.requirements,
        readers: { [input.repository]: readExact },
      });
      j1 = evaluateTrackedResourceClosure({
        repository: input.repository,
        revision,
        requirements: lowered.requirements,
        j2,
        trackedPaths,
        resourceRelations: lowered.resourceRelations,
        nativeRequirements: native.requirements,
        resolver,
      });
    }

    for (const error of lowered.requirements.errors)
      diagnostics.push({ code: "invalid_requirement", subject: revision + ":" + error.path, detail: error.message });
    for (const error of j2.errors)
      diagnostics.push({ code: error.code, subject: revision + ":" + error.requirement, detail: error.target });
    for (const id of j2.unrooted)
      diagnostics.push({ code: "unrooted_requirement", subject: revision + ":" + id });
    for (const error of j1.errors)
      diagnostics.push({ code: error.code, subject: revision + ":" + error.path, detail: error.target });
    for (const path of j1.unjustified)
      diagnostics.push({ code: "unjustified_resource", subject: revision + ":" + path });
    for (const requirement of native.requirements)
      for (const relation of requirement.relations)
        if (relation.target.kind === "requirement" && !Object.hasOwn(native.index, relation.target.id))
          diagnostics.push({ code: "missing_requirement_target", subject: revision + ":" + requirement.id, detail: relation.target.id });

    const state: CompilerState = {
      revision,
      entries: snapshot.entries,
      native,
      requirements: lowered.requirements,
      lifecycle: lowered.lifecycle,
      resourceRelations: lowered.resourceRelations,
      compiledConstraints: lowered.compiledConstraints,
      j2,
      j1,
    };
    states.set(revision, state);
    return state;
  };

  const before = open(input.base.revision);
  const after = open(input.head.revision);
  const projectionPath = ".repo-guard/projections.json";
  const baseProjectionPaths = new Set(before.entries.map((entry) => entry.path));
  const headProjectionPaths = new Set(after.entries.map((entry) => entry.path));
  const projectionReport = evaluateProjectionCheck({
    baseRaw: baseProjectionPaths.has(projectionPath)
      ? input.base.readBytes(projectionPath)
      : null,
    headRaw: headProjectionPaths.has(projectionPath)
      ? input.head.readBytes(projectionPath)
      : null,
    readHead: (path) =>
      headProjectionPaths.has(path) ? input.head.readBytes(path) : null,
    facts: {
      readFile: (path) => input.head.readBytes(path),
      diff: { files: { checked: [...input.transition.files] } },
    },
    resolveRequirement: (id) => {
      if (!after.native.ok) return null;
      const requirement = after.native.index[id];
      return requirement
        ? {
            digest: requirement.semantic.digest,
            path: requirement.source.path,
          }
        : null;
    },
  });
  if (projectionReport.present) {
    for (const diagnostic of projectionReport.diagnostics) {
      diagnostics.push({
        code: diagnostic.code,
        subject: diagnostic.subject,
        ...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
      });
    }
  }

  const transition = evaluateTransitionCauseClosure({
    repository: input.repository,
    base: {
      revision: input.base.revision,
      requirements: before.requirements,
      nativeRequirements: before.native.requirements,
      compiledConstraints: before.compiledConstraints,
      j2: before.j2,
      j1: before.j1,
      resourceRelations: before.resourceRelations,
    },
    head: {
      revision: input.head.revision,
      requirements: after.requirements,
      nativeRequirements: after.native.requirements,
      compiledConstraints: after.compiledConstraints,
      j2: after.j2,
      j1: after.j1,
      resourceRelations: after.resourceRelations,
    },
    trustedAuthorityBase: {
      revision: input.base.revision,
      requirements: before.requirements,
      nativeRequirements: before.native.requirements,
      compiledConstraints: before.compiledConstraints,
      j2: before.j2,
      j1: before.j1,
      resourceRelations: before.resourceRelations,
    },
    resourceDeltas: input.transition.resourceDeltas,
    baseLifecycle: before.lifecycle,
    headLifecycle: after.lifecycle,
    observationFacts: input.transition.observationFacts,
  });
  for (const reason of transition.reasons)
    diagnostics.push({ code: "j3", subject: reason });

  diagnostics.sort((a, b) =>
    a.code.localeCompare(b.code, "en") ||
    a.subject.localeCompare(b.subject, "en") ||
    (a.detail || "").localeCompare(b.detail || "", "en"));

  return {
    format: "repo-guard/local-compiler-v1",
    repository: input.repository,
    base: input.base.revision,
    head: input.head.revision,
    ok:
      diagnostics.length === 0
      && before.j1.ok
      && after.j1.ok
      && transition.ok
      && (!projectionReport.present || projectionReport.ok),
    j1: {
      base: before.j1.ok,
      head: after.j1.ok,
      tracked: after.entries.length,
      justified: after.j1.justified.length,
    },
    j2: {
      base: before.j2.ok,
      head: after.j2.ok,
      rooted: after.j2.rooted.length,
    },
    j3: {
      changed: input.transition.files.length,
      ok: transition.ok,
      affectedRequirements: transition.affectedRequirements,
      deltas: transition.deltas,
      constraints: transition.explanations.constraints,
    },
    diagnostics,
    ...(projectionReport.present ? { projections: projectionReport } : {}),
  };
}
