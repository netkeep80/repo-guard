import { listTrackedEntriesAtRef, readFileAtRef, runGit } from "./git.mjs";
import { parseNameStatusZ } from "./diff/parser.mjs";
import { loadNativeRequirements } from "./runtime/canonical-requirements.mjs";
import { lowerNativeRequirements } from "./runtime/pipeline.mjs";
import { evaluateRootedRequirements } from "./runtime/requirement-closure.mjs";
import { evaluateTrackedResourceClosure } from "./runtime/resource-closure.mjs";
import { createResourceResolver } from "./runtime/resource-resolver.mjs";
import { evaluateTransitionCauseClosure, resourceDeltasFromParsedDiff, type TransitionObservationFact } from "./runtime/transition-closure.mjs";
import { evaluateProjectionCheck } from "./projection-check.mjs";

const sha40 = /^[0-9a-f]{40}$/;
type Diagnostic = { code: string; subject: string; detail?: string };
type Lowered = ReturnType<typeof lowerNativeRequirements>;
type J1 = ReturnType<typeof evaluateTrackedResourceClosure>;
interface LocalState {
  revision: string;
  entries: ReturnType<typeof listTrackedEntriesAtRef>;
  native: ReturnType<typeof loadNativeRequirements>;
  requirements: Lowered["requirements"];
  lifecycle: Lowered["lifecycle"];
  resourceRelations: Lowered["resourceRelations"];
  j2: ReturnType<typeof evaluateRootedRequirements>;
  j1: J1;
}

function resolveCommit(root: string, ref: string): string {
  if (!ref || ref.startsWith("-") || /[\s\x00-\x1f]/.test(ref)) throw new Error("invalid Git revision");
  const resolved = runGit(["rev-parse", "--verify", ref + "^{commit}"], { cwd: root }).trim();
  if (!sha40.test(resolved)) throw new Error("Git revision is not an exact SHA-1 commit");
  return resolved;
}

function structuralRoots(lowered: Lowered) {
  return lowered.requirements.requirements.filter(item => {
    const value = item.value as { relations?: Record<string, { predicate?: string }> };
    return !Object.values(value.relations || {}).some(relation => relation.predicate === "derives_from");
  }).map(item => item.semantic);
}

function parseChangedLinesZ(raw: string): Map<string, number> {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const result = new Map<string, number>();
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    const match = record?.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) throw new Error("malformed git --numstat -z record");
    const [, addedRaw, deletedRaw, inlinePath] = match;
    let path = inlinePath;
    if (path === "") {
      const before = fields[index++], after = fields[index++];
      if (before === undefined || after === undefined || after === "") throw new Error("malformed renamed git --numstat -z record");
      path = after;
    }
    if (addedRaw === "-" || deletedRaw === "-") continue;
    const value = Number(addedRaw) + Number(deletedRaw);
    if (!Number.isSafeInteger(value)) throw new Error("git changed_lines overflow");
    if (result.has(path)) throw new Error("duplicate git --numstat path " + path);
    result.set(path, value);
  }
  return result;
}

function localObservations(root: string, repository: string, base: string, head: string): TransitionObservationFact[] {
  const raw = runGit(["-c", "core.quotepath=false", "diff", "--numstat", "-z", "--find-renames", base, head], { cwd: root });
  return [...parseChangedLinesZ(raw)].sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, value]) => ({
    authorityBaseRevision: base,
    baseRevision: base,
    headRevision: head,
    path,
    metric: "changed_lines" as const,
    value,
    providerId: "local-git",
  }));
}

export function evaluateLocalCompiler(input: { root: string; repository: string; base: string; head: string }) {
  const diagnostics: Diagnostic[] = [];
  const states = new Map<string, LocalState>();
  const open = (revision: string): LocalState => {
    const existing = states.get(revision);
    if (existing) return existing;
    const entries = listTrackedEntriesAtRef(revision, input.root);
    const paths = entries.map(entry => entry.path).filter(path => /^requirements\/.*\.rg\.(?:yaml|json)$/.test(path));
    const native = loadNativeRequirements({
      repository: input.repository,
      revision,
      paths,
      readFile: (sha, path) => sha === revision ? readFileAtRef(sha, path, input.root) : null,
    });
    const lowered = lowerNativeRequirements(native);
    const j2 = evaluateRootedRequirements({ requirements: lowered.requirements, trustedRoots: structuralRoots(lowered) });
    let j1: J1 = {
      ok: false,
      justified: [],
      unjustified: entries.map(entry => entry.path),
      errors: [{ code: "j2_not_rooted", path: "" }],
      explanations: {},
      owners: {},
    };
    if (lowered.requirements.ok && j2.ok) {
      const resolver = createResourceResolver({
        repository: input.repository,
        revision,
        requirements: lowered.requirements,
        readers: { [input.repository]: (sha, path) => sha === revision ? readFileAtRef(sha, path, input.root) : null },
      });
      j1 = evaluateTrackedResourceClosure({
        repository: input.repository,
        revision,
        requirements: lowered.requirements,
        j2,
        trackedPaths: entries.map(entry => entry.path),
        resourceRelations: lowered.resourceRelations,
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

    const state: LocalState = {
      revision,
      entries,
      native,
      requirements: lowered.requirements,
      lifecycle: lowered.lifecycle,
      resourceRelations: lowered.resourceRelations,
      j2,
      j1,
    };
    states.set(revision, state);
    return state;
  };

  const base = resolveCommit(input.root, input.base);
  const head = resolveCommit(input.root, input.head);
  const before = open(base);
  const after = open(head);
  const diff = parseNameStatusZ(runGit(
    ["-c", "core.quotepath=false", "diff", "--name-status", "-z", "--find-renames", base, head],
    { cwd: input.root },
  ));
  const projectionPath = ".repo-guard/projections.json";
  const baseProjectionPaths = new Set(before.entries.map((entry) => entry.path));
  const headProjectionPaths = new Set(after.entries.map((entry) => entry.path));
  const projectionReport = evaluateProjectionCheck({
    baseRaw: baseProjectionPaths.has(projectionPath)
      ? readFileAtRef(base, projectionPath, input.root)
      : null,
    headRaw: headProjectionPaths.has(projectionPath)
      ? readFileAtRef(head, projectionPath, input.root)
      : null,
    readHead: (path) =>
      headProjectionPaths.has(path) ? readFileAtRef(head, path, input.root) : null,
    facts: {
      readFile: (path) => readFileAtRef(head, path, input.root),
      diff: { files: { checked: diff } },
    },
    resolveRequirement: (id) => {
      // A partially populated native index is not authoritative on invalid snapshots.
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
    mode: "compiler",
    repository: input.repository,
    base: {
      revision: base,
      requirements: before.requirements,
      j2: before.j2,
      j1: before.j1,
      resourceRelations: before.resourceRelations,
    },
    head: {
      revision: head,
      requirements: after.requirements,
      j2: after.j2,
      j1: after.j1,
      resourceRelations: after.resourceRelations,
    },
    trustedAuthorityBase: {
      revision: base,
      requirements: before.requirements,
      j2: before.j2,
      j1: before.j1,
      resourceRelations: before.resourceRelations,
    },
    resourceDeltas: resourceDeltasFromParsedDiff(diff),
    baseLifecycle: before.lifecycle,
    headLifecycle: after.lifecycle,
    observationFacts: localObservations(input.root, input.repository, base, head),
    trustedEvidenceProviders: ["local-git"],
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
    base,
    head,
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
      changed: diff.length,
      ok: transition.ok,
      affectedRequirements: transition.affectedRequirements,
      deltas: transition.deltas,
      constraints: transition.explanations.constraints,
    },
    diagnostics,
    ...(projectionReport.present ? { projections: projectionReport } : {}),
  };
}

export function runLocalCheck(roots: { repoRoot: string }, args: string[]): number {
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const base = option("--base"), head = option("--head");
  if (!base || !head) throw new Error("check requires --base and --head");
  const format = option("--format") || "text";
  if (!["text", "json", "summary"].includes(format)) throw new Error("unsupported check format");

  const repository = "local/repository";
  const report = evaluateLocalCompiler({ root: roots.repoRoot, repository, base, head });

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`RepoGuard check: ${report.ok ? "GREEN" : "RED"}; BASE=${report.base}; HEAD=${report.head}`);
    console.log(`J1 ${report.j1.justified}/${report.j1.tracked}; J2 ${report.j2.rooted}; J3 changes ${report.j3.changed}; diagnostics ${report.diagnostics.length}`);
    if (report.projections) {
      const projections = report.projections;
      const current = projections.analyses.filter((item) => item.freshness === "CURRENT").length;
      const stale = projections.analyses.filter((item) => item.freshness === "STALE").length;
      const broken = projections.analyses.filter((item) => item.freshness === "BROKEN").length;
      console.log(
        `P current ${current}; stale ${stale}; broken ${broken}; ownership ${projections.ownership.ok ? "GREEN" : "RED"}; coverage ${projections.ownership.coverage.status}`,
      );
    }
    if (format === "text")
      for (const item of report.diagnostics)
        console.log(`${item.code}: ${item.subject}${item.detail ? " (" + item.detail + ")" : ""}`);
  }
  return report.ok ? 0 : 1;
}
