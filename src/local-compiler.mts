import { getExactDiffIdentity, listTrackedEntriesAtRef, readFileAtRef, runGit } from "./git.mjs";
import { loadNativeRequirements } from "./runtime/canonical-requirements.mjs";
import { lowerNativeRequirements } from "./runtime/pipeline.mjs";
import { evaluateRootedRequirements } from "./runtime/requirement-closure.mjs";
import { evaluateTrackedResourceClosure } from "./runtime/resource-closure.mjs";
import { createResourceResolver } from "./runtime/resource-resolver.mjs";

const sha40 = /^[0-9a-f]{40}$/;
const unique = (items: Iterable<string>) => [...new Set(items)].sort((a, b) => a.localeCompare(b, "en"));
type Diagnostic = { code: string; subject: string; detail?: string };

function resolveCommit(root: string, ref: string): string {
  // Do not permit revision syntax that changes the meaning of a path argument.
  if (!ref || ref.startsWith("-") || /[\s\x00-\x1f]/.test(ref)) throw new Error("invalid Git revision");
  const resolved = runGit(["rev-parse", "--verify", ref + "^{commit}"], { cwd: root }).trim();
  if (!sha40.test(resolved)) throw new Error("Git revision is not an exact SHA-1 commit");
  return resolved;
}

export function evaluateLocalCompiler(input: { root: string; repository: string; base: string; head: string }) {
  const diagnostics: Diagnostic[] = [];
  const snapshots = new Map<string, ReturnType<typeof loadNativeRequirements>>();
  const states = new Map<string, {
    entries: ReturnType<typeof listTrackedEntriesAtRef>;
    j1: ReturnType<typeof evaluateTrackedResourceClosure> | null;
    j2: ReturnType<typeof evaluateRootedRequirements>;
  }>();
  const open = (revision: string) => {
    if (states.has(revision)) return states.get(revision)!;
    const entries = listTrackedEntriesAtRef(revision, input.root);
    const paths = entries.map(e => e.path).filter(p => /^requirements\/.*\.rg\.(?:yaml|json)$/.test(p));
    const native = loadNativeRequirements({
      repository: input.repository, revision, paths,
      readFile: (sha, path) => readFileAtRef(sha, path, input.root),
    });
    snapshots.set(revision, native);
    const lowered = lowerNativeRequirements(native);
    const roots = lowered.requirements.requirements.filter(item => {
      const value = item.value as { relations?: Record<string, { predicate?: string }> };
      return !Object.values(value.relations || {}).some(relation => relation.predicate === "derives_from");
    }).map(item => item.semantic);
    const j2 = evaluateRootedRequirements({ requirements: lowered.requirements, trustedRoots: roots });
    const j1 = lowered.requirements.ok && j2.ok
      ? evaluateTrackedResourceClosure({
          repository: input.repository, revision, requirements: lowered.requirements, j2,
          trackedPaths: entries.map(e => e.path), resourceRelations: lowered.resourceRelations,
          resolver: createResourceResolver({
            repository: input.repository, revision, requirements: lowered.requirements,
            readers: { [input.repository]: (sha, path) => sha === revision ? readFileAtRef(sha, path, input.root) : null },
          }),
        })
      : null;
    for (const error of lowered.requirements.errors) diagnostics.push({ code: "invalid_requirement", subject: revision + ":" + error.path, detail: error.message });
    for (const error of j2.errors) diagnostics.push({ code: error.code, subject: revision + ":" + error.requirement, detail: error.target });
    for (const id of j2.unrooted) diagnostics.push({ code: "unrooted_requirement", subject: revision + ":" + id });
    if (j1) {
      for (const error of j1.errors) diagnostics.push({ code: error.code, subject: revision + ":" + error.path, detail: error.target });
      for (const path of j1.unjustified) diagnostics.push({ code: "unjustified_resource", subject: revision + ":" + path });
    }
    const state = { entries, j1, j2 };
    states.set(revision, state);
    return state;
  };
  const base = resolveCommit(input.root, input.base), head = resolveCommit(input.root, input.head);
  const before = open(base), after = open(head);
  const diff = getExactDiffIdentity(base, head, input.root);
  const headPaths = new Set(after.entries.map(e => e.path));
  const headOwners = after.j1?.owners || {};
  const native = snapshots.get(head)!;
  // Constraints needing independent observation/domain evidence cannot be silently treated as passed.
  for (const requirement of native.requirements) {
    for (const constraint of requirement.constraints) {
      if (constraint.metric || constraint.evidence) diagnostics.push({
        code: "unsupported_local_constraint", subject: requirement.id + ":" + constraint.id,
        detail: "deterministic metric/evidence execution is not implemented in C1 yet",
      });
    }
    for (const relation of requirement.relations) {
      if (relation.target.kind === "requirement" && !Object.hasOwn(native.index, relation.target.id))
        diagnostics.push({ code: "missing_requirement_target", subject: requirement.id, detail: relation.target.id });
    }
  }
  for (const file of diff) {
    const target = file.path;
    if (file.status === "deleted") {
      if (headPaths.has(target) || Object.hasOwn(headOwners, target))
        diagnostics.push({ code: "deleted_resource_still_required", subject: target });
    } else if (!headPaths.has(target) || !Object.hasOwn(headOwners, target)) {
      diagnostics.push({ code: "changed_resource_unjustified", subject: target });
    }
  }
  const result = {
    format: "repo-guard/local-compiler-v1", repository: input.repository, base, head,
    ok: diagnostics.length === 0 && !!before.j1?.ok && !!after.j1?.ok,
    j1: { base: before.j1?.ok ?? false, head: after.j1?.ok ?? false, tracked: after.entries.length, justified: after.j1?.justified.length ?? 0 },
    j2: { base: before.j2.ok, head: after.j2.ok, rooted: after.j2.rooted.length },
    j3: { changed: diff.length, ok: !diagnostics.some(d => d.code === "changed_resource_unjustified" || d.code === "deleted_resource_still_required") },
    diagnostics: diagnostics.sort((a, b) => a.code.localeCompare(b.code, "en") || a.subject.localeCompare(b.subject, "en")),
  };
  return result;
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
  let remote = "";
  try { remote = runGit(["config", "--get", "remote.origin.url"], { cwd: roots.repoRoot }).trim(); }
  catch { /* A local Git repository does not need a remote. */ }
  const match = remote.match(/(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const repository = match?.[1] || "local/repository";
  const report = evaluateLocalCompiler({ root: roots.repoRoot, repository, base, head });
  if (format === "json") console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`RepoGuard check: ${report.ok ? "GREEN" : "RED"}; BASE=${report.base}; HEAD=${report.head}`);
    console.log(`J1 ${report.j1.justified}/${report.j1.tracked}; J2 ${report.j2.rooted}; J3 changes ${report.j3.changed}; diagnostics ${report.diagnostics.length}`);
    if (format === "text") for (const item of report.diagnostics) console.log(`${item.code}: ${item.subject}${item.detail ? " (" + item.detail + ")" : ""}`);
  }
  return report.ok ? 0 : 1;
}
