import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { evaluateTransitionCauseClosure, resourceDeltasFromParsedDiff } from "../dist/runtime/transition-closure.mjs";
import { parseMachineDiff } from "../dist/diff/parser.mjs";

const repository = "netkeep80/repo-guard";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);

const artifact = (path, predicate = "implemented_by", key = null) => ({ path, predicate, key });
const link = (predicate, id, key = null) => ({ predicate, id, key });
function requirement(id, { parent = null, artifacts = [], links = [], extra = {}, path = null } = {}) {
  const relations = {};
  let n = 0;
  if (parent) relations.parent = { predicate: "derives_from", target: { kind: "requirement", id: parent } };
  for (const rel of links) relations[rel.key || `q${n++}`] = { predicate: rel.predicate, target: { kind: "requirement", id: rel.id } };
  for (const rel of artifacts) relations[rel.key || `a${n++}`] = { predicate: rel.predicate, target: { kind: "artifact", path: rel.path } };
  return { path: path || `requirements/${id}.json`, value: { id, ...extra, relations } };
}
function state(revision, sources, trackedPaths, { rootIds = ["ROOT"], resourceRelations = [] } = {}) {
  const byPath = new Map(sources.map((source) => [source.path, source.value]));
  const requirements = loadCanonicalRequirements({
    repository, revision, paths: sources.map((source) => source.path),
    readFile: (_, path) => byPath.has(path) ? JSON.stringify(byPath.get(path)) : null,
  });
  assert.equal(requirements.ok, true, JSON.stringify(requirements.errors));
  const trustedRoots = rootIds.map((id) => requirements.index[id].semantic);
  const j2 = evaluateRootedRequirements({ requirements, trustedRoots });
  assert.equal(j2.ok, true, JSON.stringify(j2));
  const tracked = [...trackedPaths];
  const resolver = createResourceResolver({
    repository, revision, requirements,
    readers: { [repository]: (sha, path) => {
      if (sha !== revision || !tracked.includes(path)) return null;
      return byPath.has(path) ? JSON.stringify(byPath.get(path)) : `exact:${revision}:${path}`;
    } },
  });
  const j1 = evaluateTrackedResourceClosure({ repository, revision, requirements, j2, trackedPaths: tracked, resourceRelations, resolver });
  return { revision, requirements, j2, j1, resourceRelations };
}
const sourcePaths = (sources) => sources.map((x) => x.path);
const tracked = (sources, ...paths) => [...sourcePaths(sources), ...paths];
const authority = (s) => ({ revision: s.revision, requirements: s.requirements, j2: s.j2 });
const receipt = (authorityBase, base, head, permissions) => ({ authorityBaseRevision: authorityBase.revision, baseRevision: base.revision, headRevision: head.revision, permissions });
const evidence = (authorityBase, base, head, key, status = "pass") => ({ authorityBaseRevision: authorityBase.revision, baseRevision: base.revision, headRevision: head.revision, key, status });
function evaluate(base, head, options = {}) {
  const trustedAuthorityBase = options.trustedAuthorityBase || authority(base);
  return evaluateTransitionCauseClosure({ repository, base, head, trustedAuthorityBase, ...options });
}
const green = (result, label) => assert.equal(result.ok, true, `${label}: ${result.reasons.join(" | ")}`);
const red = (result, fragment, label) => {
  assert.equal(result.ok, false, `${label}: unexpectedly GREEN`);
  assert.ok(result.reasons.some((reason) => reason.includes(fragment)), `${label}: missing ${fragment}; ${result.reasons.join(" | ")}`);
};
const why = (result, kind) => result.explanations.whyChanged.find((item) => item.kind === kind);

/* #700 S01-S22 — GREEN / recoverable */

test("I5 S01 new Requirement + new implementation: exact independent Requirement authority, no cochange ceremony", () => {
  const baseSources = [requirement("ROOT")];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/new.ts")] })];
  const base = state(A, baseSources, tracked(baseSources));
  const head = state(B, headSources, tracked(headSources, "src/new.ts"));
  const a = authority(base);
  const result = evaluate(base, head, {
    workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: [{ kind: "add", path: "src/new.ts" }],
    trustedReceipts: [receipt(a, base, head, ["requirement:R1"])],
  });
  green(result, "S01");
});

test("I5 S02 new Requirement linked entirely to existing implementation needs no implementation ResourceDelta", () => {
  const baseSources = [requirement("ROOT", { artifacts: [artifact("src/shared.ts")] })];
  const headSources = [requirement("ROOT", { artifacts: [artifact("src/shared.ts")] }), requirement("R2", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] })];
  const base = state(A, baseSources, tracked(baseSources, "src/shared.ts"));
  const head = state(B, headSources, tracked(headSources, "src/shared.ts"));
  const a = authority(base);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R2"] }, trustedReceipts: [receipt(a, base, head, ["requirement:R2"])] });
  green(result, "S02");
  assert.equal(result.deltas.some((d) => d.kind.startsWith("resource_")), false);
});

test("I5 S03 existing Requirement bugfix is causal with RequirementDelta=0", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/f.ts")] })];
  const paths = tracked(sources, "src/f.ts"), base = state(A, sources, paths), head = state(B, sources, paths);
  const result = evaluate(base, head, { workIntent: { id: "bug", addresses: ["R1"] }, resourceDeltas: [{ kind: "modify", path: "src/f.ts" }] });
  green(result, "S03");
  assert.equal(result.deltas.some((d) => d.kind.startsWith("requirement_")), false);
});

test("I5 S04 pure refactor under unchanged Requirements is GREEN", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/f.ts")] })];
  const paths = tracked(sources, "src/f.ts"), base = state(A, sources, paths), head = state(B, sources, paths);
  green(evaluate(base, head, { workIntent: { id: "refactor", addresses: ["R1"] }, resourceDeltas: [{ kind: "modify", path: "src/f.ts" }] }), "S04");
});

test("I5 S05 Requirement semantic modification may have zero implementation delta", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", extra: { statement: "before" } })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", extra: { statement: "after" } })];
  const base = state(A, baseSources, tracked(baseSources)), head = state(B, headSources, tracked(headSources)), a = authority(base);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, trustedReceipts: [receipt(a, base, head, ["requirement:R1"])] });
  green(result, "S05");
  assert.equal(result.deltas.some((d) => d.kind.startsWith("resource_")), false);
});

test("I5 S06 removing a Requirement does not delete shared implementation", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] }), requirement("R2", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] })];
  const base = state(A, baseSources, tracked(baseSources, "src/shared.ts")), head = state(B, headSources, tracked(headSources, "src/shared.ts")), a = authority(base);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R2"] }, trustedReceipts: [receipt(a, base, head, ["requirement:R2"])] });
  green(result, "S06");
  assert.equal(result.deltas.some((d) => d.kind.startsWith("resource_")), false);
});

test("I5 S07 descriptive implementation replacement is causally GREEN in shadow without I6 cutover", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/old.ts")] })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/new.ts")] })];
  const base = state(A, baseSources, tracked(baseSources, "src/old.ts")), head = state(B, headSources, tracked(headSources, "src/new.ts"));
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: [{ kind: "delete", path: "src/old.ts" }, { kind: "add", path: "src/new.ts" }] });
  green(result, "S07");
  assert.ok(result.deltas.some((d) => d.kind === "relation_replace"));
});

test("I5 S08 Resource rename is explicit and does not become Requirement delete+add", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/old.ts")] })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/new.ts")] })];
  const base = state(A, baseSources, tracked(baseSources, "src/old.ts")), head = state(B, headSources, tracked(headSources, "src/new.ts"));
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: [{ kind: "rename", previousPath: "src/old.ts", path: "src/new.ts" }] });
  green(result, "S08");
  assert.ok(result.deltas.some((d) => d.kind === "resource_rename"));
  assert.equal(result.deltas.some((d) => d.kind === "requirement_add" || d.kind === "requirement_remove"), false);
});

test("I5 S09 shared Resource reports every affected Requirement but only addressed direct Requirement is a cause", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] }), requirement("R2", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] })];
  const paths = tracked(sources, "src/shared.ts"), base = state(A, sources, paths), head = state(B, sources, paths);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: [{ kind: "modify", path: "src/shared.ts" }] });
  green(result, "S09");
  const item = why(result, "resource_modify");
  assert.deepEqual(item.causes, ["R1"]);
  assert.deepEqual(item.affected, ["R1", "R2", "ROOT"]);
});

test("I5 S10 one Requirement may own many resources and verifier traces without verifier execution semantics", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/a.ts"), artifact("src/b.ts"), artifact("tests/a.mjs", "verified_by"), artifact("tests/b.mjs", "verified_by")] })];
  const paths = tracked(sources, "src/a.ts", "src/b.ts", "tests/a.mjs", "tests/b.mjs"), base = state(A, sources, paths), head = state(B, sources, paths);
  green(evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: [{ kind: "modify", path: "src/a.ts" }] }), "S10");
});

test("I5 S11 quality/constraint Requirement can causally reach architecture without direct code edge", () => {
  const sources = [requirement("ROOT"), requirement("RQ", { parent: "ROOT", artifacts: [artifact("docs/architecture.md", "documents")] })];
  const paths = tracked(sources, "docs/architecture.md"), base = state(A, sources, paths), head = state(B, sources, paths);
  green(evaluate(base, head, { workIntent: { id: "W", addresses: ["RQ"] }, resourceDeltas: [{ kind: "modify", path: "docs/architecture.md" }] }), "S11");
});

test("I5 S12 research Requirement + experiments may remain explicitly not accepted/current", () => {
  const baseSources = [requirement("ROOT")];
  const headSources = [requirement("ROOT"), requirement("R-RESEARCH", { parent: "ROOT", artifacts: [artifact("experiments/e.txt", "documents")] })];
  const base = state(A, baseSources, tracked(baseSources)), head = state(B, headSources, tracked(headSources, "experiments/e.txt")), a = authority(base);
  const result = evaluate(base, head, {
    workIntent: { id: "research", addresses: ["R-RESEARCH"] }, resourceDeltas: [{ kind: "add", path: "experiments/e.txt" }],
    baseLifecycle: {}, headLifecycle: { "R-RESEARCH": { accepted: false, current: false } },
    trustedReceipts: [receipt(a, base, head, ["requirement:R-RESEARCH"])],
  });
  green(result, "S12");
});

test("I5 S13 stacked local diff base is not trusted authority base", () => {
  const authSources = [requirement("ROOT"), requirement("R-PROC", { parent: "ROOT", extra: { transition: { deltaKinds: ["resource_modify"], paths: ["src/stack.ts"] } } })];
  const localSources = [...authSources, requirement("R-STACK", { parent: "ROOT", artifacts: [artifact("src/stack.ts")] })];
  const authState = state(A, authSources, tracked(authSources));
  const base = state(C, localSources, tracked(localSources, "src/stack.ts")), head = state(D, localSources, tracked(localSources, "src/stack.ts"));
  const a = authority(authState);
  const result = evaluate(base, head, {
    trustedAuthorityBase: a, workIntent: { id: "stack", addresses: ["R-PROC"] }, resourceDeltas: [{ kind: "modify", path: "src/stack.ts" }],
  });
  green(result, "S13");
  assert.deepEqual(why(result, "resource_modify").causes, ["R-PROC"]);
});

test("I5 S14 discovered shared impact can be acknowledged by extending WorkIntent without recreating transition", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] }), requirement("R2", { parent: "ROOT", artifacts: [artifact("src/shared.ts")], extra: { transition: { paths: ["src/shared.ts"], requireAddressed: true } } })];
  const paths = tracked(sources, "src/shared.ts"), base = state(A, sources, paths), head = state(B, sources, paths);
  const common = { resourceDeltas: [{ kind: "modify", path: "src/shared.ts" }] };
  red(evaluate(base, head, { ...common, workIntent: { id: "W", addresses: ["R1"] } }), "unacknowledged_impact:R2", "S14 discovered impact");
  green(evaluate(base, head, { ...common, workIntent: { id: "W", addresses: ["R1", "R2"] } }), "S14 extended intent");
});

test("I5 S15 mechanical mass refactor uses exact DOMAIN/equivalence evidence, not fake per-file Requirements", () => {
  const sources = [requirement("ROOT"), requirement("R-MASS", { parent: "ROOT", artifacts: [artifact("src/a.ts"), artifact("src/b.ts")], extra: { transition: { deltaKinds: ["resource_modify"], evidenceKeys: ["domain:mass-equivalence"] } } })];
  const paths = tracked(sources, "src/a.ts", "src/b.ts"), base = state(A, sources, paths), head = state(B, sources, paths), a = authority(base);
  const options = { workIntent: { id: "mass", addresses: ["R-MASS"] }, resourceDeltas: [{ kind: "modify", path: "src/a.ts" }, { kind: "modify", path: "src/b.ts" }] };
  red(evaluate(base, head, options), "missing_evidence:domain:mass-equivalence", "S15 missing evidence");
  green(evaluate(base, head, { ...options, evidenceFacts: [evidence(a, base, head, "domain:mass-equivalence")] }), "S15 exact evidence");
});

test("I5 S16 dependency update is ordinary Resource modification with exact compatibility evidence", () => {
  const sources = [requirement("ROOT"), requirement("R-DEP", { parent: "ROOT", artifacts: [artifact("deps/upstream.lock")], extra: { transition: { paths: ["deps/upstream.lock"], evidenceKeys: ["observation:dependency-exact"] } } })];
  const paths = tracked(sources, "deps/upstream.lock"), base = state(A, sources, paths), head = state(B, sources, paths), a = authority(base);
  const options = { workIntent: { id: "dep", addresses: ["R-DEP"] }, resourceDeltas: [{ kind: "modify", path: "deps/upstream.lock" }] };
  green(evaluate(base, head, { ...options, evidenceFacts: [evidence(a, base, head, "observation:dependency-exact")] }), "S16");
});

test("I5 S17 generated artifact changes through I4 generates ownership plus exact freshness evidence", () => {
  const sources = [requirement("ROOT"), requirement("R-GEN", { parent: "ROOT", artifacts: [artifact("src/source.ts")], extra: { transition: { paths: ["dist/out.js"], evidenceKeys: ["domain:generation-fresh"] } } })];
  const paths = tracked(sources, "src/source.ts", "dist/out.js"), edges = [{ from: "src/source.ts", kind: "generates", to: "dist/out.js" }];
  const base = state(A, sources, paths, { resourceRelations: edges }), head = state(B, sources, paths, { resourceRelations: edges }), a = authority(base);
  const options = { workIntent: { id: "gen", addresses: ["R-GEN"] }, resourceDeltas: [{ kind: "modify", path: "src/source.ts" }, { kind: "modify", path: "dist/out.js" }] };
  green(evaluate(base, head, { ...options, evidenceFacts: [evidence(a, base, head, "domain:generation-fresh")] }), "S17");
});

test("I5 S18 stale authorization after rebase fails and recomputed exact authorization succeeds", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", extra: { statement: "a" } })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", extra: { statement: "b" } })];
  const base = state(A, baseSources, tracked(baseSources)), head = state(B, headSources, tracked(headSources)), a = authority(base);
  const stale = { authorityBaseRevision: A, baseRevision: A, headRevision: C, permissions: ["requirement:R1"] };
  red(evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, trustedReceipts: [stale] }), "missing_authority:requirement:R1", "S18 stale");
  green(evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, trustedReceipts: [receipt(a, base, head, ["requirement:R1"])] }), "S18 recomputed");
});

test("I5 S19 cross-repository exact dependency update needs only local transition plus exact observation evidence", () => {
  const sources = [requirement("ROOT"), requirement("R-X", { parent: "ROOT", artifacts: [artifact("deps/external.pin")], extra: { transition: { paths: ["deps/external.pin"], evidenceKeys: ["observation:external-revision-resolved"] } } })];
  const paths = tracked(sources, "deps/external.pin"), base = state(A, sources, paths), head = state(B, sources, paths), a = authority(base);
  const options = { workIntent: { id: "external", addresses: ["R-X"] }, resourceDeltas: [{ kind: "modify", path: "deps/external.pin" }] };
  green(evaluate(base, head, { ...options, evidenceFacts: [evidence(a, base, head, "observation:external-revision-resolved")] }), "S19");
});

test("I5 S20 orphan cleanup requires explicit rooted transition cause; UNJUSTIFIED is not auto-delete", () => {
  const plain = [requirement("ROOT")];
  const plainBase = state(A, plain, tracked(plain, "tmp/orphan.txt")), plainHead = state(B, plain, tracked(plain));
  assert.equal(plainBase.j1.ok, false);
  const common = { resourceDeltas: [{ kind: "delete", path: "tmp/orphan.txt" }], workIntent: { id: "cleanup", addresses: ["ROOT"] } };
  red(evaluate(plainBase, plainHead, common), "no_cause:resource_delete", "S20 no auto-delete");

  const governed = [requirement("ROOT", { extra: { transition: { deltaKinds: ["resource_delete"], paths: ["tmp/orphan.txt"] } } })];
  const base = state(A, governed, tracked(governed, "tmp/orphan.txt")), head = state(B, governed, tracked(governed));
  green(evaluate(base, head, common), "S20 rooted cleanup cause");
});

test("I5 S21 security-sensitive work may use external WorkIntent but protected resource still needs independent exact TRUST", () => {
  const sources = [requirement("ROOT"), requirement("R-SEC", { parent: "ROOT", artifacts: [artifact(".github/workflows/trusted.yml")] })];
  const paths = tracked(sources, ".github/workflows/trusted.yml"), base = state(A, sources, paths), head = state(B, sources, paths), a = authority(base);
  const result = evaluate(base, head, {
    workIntent: { id: "external-secret-work", source: "external", addresses: ["R-SEC"] }, resourceDeltas: [{ kind: "modify", path: ".github/workflows/trusted.yml" }],
    protectedResources: [".github/workflows/trusted.yml"], trustedReceipts: [receipt(a, base, head, ["resource:.github/workflows/trusted.yml"])],
  });
  green(result, "S21");
});

test("I5 S22 closed WorkIntent state is provenance only; durable exact receipt remains independently meaningful", () => {
  const sources = [requirement("ROOT"), requirement("R-SEC", { parent: "ROOT", artifacts: [artifact(".github/workflows/trusted.yml")] })];
  const paths = tracked(sources, ".github/workflows/trusted.yml"), base = state(A, sources, paths), head = state(B, sources, paths), a = authority(base);
  const result = evaluate(base, head, {
    workIntent: { id: "42", source: "github_issue", state: "closed", addresses: ["R-SEC"] }, resourceDeltas: [{ kind: "modify", path: ".github/workflows/trusted.yml" }],
    protectedResources: [".github/workflows/trusted.yml"], trustedReceipts: [receipt(a, base, head, ["resource:.github/workflows/trusted.yml"])],
  });
  green(result, "S22");
});

/* #700 R23-R32 — adversarial falsifiers */

test("I5 R23 candidate cannot invent a new Requirement solely to justify unrelated garbage", () => {
  const baseSources = [requirement("ROOT")];
  const headSources = [requirement("ROOT"), requirement("EVIL", { parent: "ROOT", artifacts: [artifact("src/garbage.ts")] })];
  const base = state(A, baseSources, tracked(baseSources)), head = state(B, headSources, tracked(headSources, "src/garbage.ts"));
  const result = evaluate(base, head, { workIntent: { id: "candidate", addresses: ["EVIL"] }, resourceDeltas: [{ kind: "add", path: "src/garbage.ts" }] });
  red(result, "missing_authority:requirement:EVIL", "R23");
});

test("I5 R24 candidate cannot weaken its governing Requirement to authorize protected change", () => {
  const baseSources = [requirement("ROOT"), requirement("R-GUARD", { parent: "ROOT", artifacts: [artifact("src/f.ts")], extra: { constraint: "strict" } })];
  const headSources = [requirement("ROOT"), requirement("R-GUARD", { parent: "ROOT", artifacts: [artifact("src/f.ts")], extra: { constraint: "weak" } })];
  const base = state(A, baseSources, tracked(baseSources, "src/f.ts")), head = state(B, headSources, tracked(headSources, "src/f.ts"));
  red(evaluate(base, head, { workIntent: { id: "candidate", addresses: ["R-GUARD"] }, resourceDeltas: [{ kind: "modify", path: "src/f.ts" }] }), "missing_authority:requirement:R-GUARD", "R24");
});

test("I5 R25 candidate cannot mark itself CURRENT/accepted without independent authority", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT" })];
  const base = state(A, sources, tracked(sources)), head = state(B, sources, tracked(sources));
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, baseLifecycle: { R1: { current: false } }, headLifecycle: { R1: { current: true } } });
  red(result, "missing_authority:lifecycle:R1:current", "R25");
});

test("I5 R26 candidate cannot change trusted workflow/provider identity through ordinary project cause", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact(".github/workflows/trusted.yml")] })];
  const paths = tracked(sources, ".github/workflows/trusted.yml"), base = state(A, sources, paths), head = state(B, sources, paths);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: [{ kind: "modify", path: ".github/workflows/trusted.yml" }], protectedResources: [".github/workflows/trusted.yml"] });
  red(result, "missing_authority:resource:.github/workflows/trusted.yml", "R26");
});

test("I5 R27 stale exact authorization cannot survive a base/head change", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", extra: { x: 1 } })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", extra: { x: 2 } })];
  const base = state(A, baseSources, tracked(baseSources)), head = state(B, headSources, tracked(headSources));
  const stale = { authorityBaseRevision: A, baseRevision: C, headRevision: D, permissions: ["requirement:R1"] };
  red(evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, trustedReceipts: [stale] }), "missing_authority:requirement:R1", "R27");
});

test("I5 R28 retained historical/evidence Resource cannot be deleted merely because work calls it cleanup", () => {
  const sources = [requirement("ROOT", { artifacts: [artifact("docs/evidence.md", "documents")], extra: { transition: { deltaKinds: ["resource_delete"], paths: ["docs/evidence.md"] } } })];
  const base = state(A, sources, tracked(sources, "docs/evidence.md")), headSources = [requirement("ROOT")], head = state(B, headSources, tracked(headSources)), a = authority(base);
  const result = evaluate(base, head, {
    workIntent: { id: "cleanup", addresses: ["ROOT"] }, resourceDeltas: [{ kind: "delete", path: "docs/evidence.md" }], protectedResources: ["docs/evidence.md"],
  });
  red(result, "missing_authority:resource:docs/evidence.md", "R28");
});

test("I5 R29 shared Resource cannot ignore another Requirement when an applicable BASE obligation requires acknowledgement", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] }), requirement("R2", { parent: "ROOT", artifacts: [artifact("src/shared.ts")], extra: { transition: { paths: ["src/shared.ts"], requireAddressed: true } } })];
  const paths = tracked(sources, "src/shared.ts"), base = state(A, sources, paths), head = state(B, sources, paths);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: [{ kind: "modify", path: "src/shared.ts" }] });
  red(result, "unacknowledged_impact:R2", "R29");
});

test("I5 R30 verified_by trace alone never means exact verifier execution/PASS", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/f.ts"), artifact("tests/t.mjs", "verified_by")], extra: { transition: { paths: ["src/f.ts"], evidenceKeys: ["execution:tests/t.mjs"] } } })];
  const paths = tracked(sources, "src/f.ts", "tests/t.mjs"), base = state(A, sources, paths), head = state(B, sources, paths), a = authority(base);
  const options = { workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: [{ kind: "modify", path: "src/f.ts" }] };
  red(evaluate(base, head, options), "missing_evidence:execution:tests/t.mjs", "R30 trace only");
  green(evaluate(base, head, { ...options, evidenceFacts: [evidence(a, base, head, "execution:tests/t.mjs")] }), "R30 exact execution recovery");
});

test("I5 R31 no Requirement-scoped budget means no hidden global line-limit blocker in J3", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/f.ts")] })];
  const paths = tracked(sources, "src/f.ts"), base = state(A, sources, paths), head = state(B, sources, paths);
  green(evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"], legacyGlobalBudget: 1, observedLines: 99999 }, resourceDeltas: [{ kind: "modify", path: "src/f.ts" }] }), "R31 no global budget semantic");
});

test("I5 R32 Requirement change never mechanically forces all linked resources to change", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/a.ts"), artifact("src/b.ts")], extra: { statement: "a" } })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/a.ts"), artifact("src/b.ts")], extra: { statement: "b" } })];
  const paths = tracked(baseSources, "src/a.ts", "src/b.ts"), base = state(A, baseSources, paths), head = state(B, headSources, tracked(headSources, "src/a.ts", "src/b.ts")), a = authority(base);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, trustedReceipts: [receipt(a, base, head, ["requirement:R1"])] });
  green(result, "R32 candidate architecture");
  assert.equal(result.deltas.some((d) => d.kind.startsWith("resource_")), false);
});

/* Additional acceptance falsifiers from #717 */

test("I5 root ancestor and reverse impact never become universal causes", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/f.ts")] })];
  const paths = tracked(sources, "src/f.ts"), base = state(A, sources, paths), head = state(B, sources, paths);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["ROOT"] }, resourceDeltas: [{ kind: "modify", path: "src/f.ts" }] });
  red(result, "no_cause:resource_modify", "root not cause");
  const item = why(result, "resource_modify");
  assert.deepEqual(item.causalCandidates, ["R1"]);
  assert.deepEqual(item.affected, ["R1", "ROOT"]);
});

test("I5 candidate WorkIntent cannot self-authorize RequirementDelta", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", extra: { x: 1 } })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", extra: { x: 2 } })];
  const base = state(A, baseSources, tracked(baseSources)), head = state(B, headSources, tracked(headSources));
  red(evaluate(base, head, { workIntent: { id: "candidate", addresses: ["R1"], trusted: true } }), "missing_authority:requirement:R1", "WorkIntent not TRUST");
});

test("I5 exact Git T observation becomes explicit Resource type-change delta", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("bin/tool")] })];
  const paths = tracked(sources, "bin/tool"), base = state(A, sources, paths), head = state(B, sources, paths);
  const observed = parseMachineDiff(["diff --git a/bin/tool b/bin/tool", "old mode 100644", "new mode 120000"].join("\n"), "T\0bin/tool\0");
  assert.equal(observed[0].gitStatus, "T");
  const deltas = resourceDeltasFromParsedDiff(observed);
  assert.deepEqual(deltas, [{ kind: "type_change", path: "bin/tool" }]);
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] }, resourceDeltas: deltas });
  green(result, "type change");
  assert.ok(result.deltas.some((d) => d.kind === "resource_type_change"));
});

test("I5 source relocation preserves Requirement identity as relocation, not add/remove", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", path: "requirements/R1.json" })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", path: "requirements/core/R1.json" })];
  const base = state(A, baseSources, tracked(baseSources)), head = state(B, headSources, tracked(headSources));
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1"] } });
  green(result, "source relocation");
  assert.ok(result.deltas.some((d) => d.kind === "requirement_relocate"));
  assert.equal(result.deltas.some((d) => d.kind === "requirement_add" || d.kind === "requirement_remove"), false);
});

test("I5 BASE∪HEAD reverse impact prevents relation removal from hiding an affected Requirement", () => {
  const baseSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] }), requirement("R2", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] })];
  const headSources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] }), requirement("R2", { parent: "ROOT" })];
  const paths = tracked(baseSources, "src/shared.ts"), base = state(A, baseSources, paths), head = state(B, headSources, tracked(headSources, "src/shared.ts"));
  const result = evaluate(base, head, { workIntent: { id: "W", addresses: ["R1", "R2"] }, resourceDeltas: [{ kind: "modify", path: "src/shared.ts" }] });
  green(result, "BASE∪HEAD impact");
  assert.ok(why(result, "resource_modify").affected.includes("R2"));
});

test("I5 deterministic explanations are invariant to WorkIntent address order", () => {
  const sources = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] }), requirement("R2", { parent: "ROOT", artifacts: [artifact("src/shared.ts")] })];
  const paths = tracked(sources, "src/shared.ts"), base = state(A, sources, paths), head = state(B, sources, paths);
  const common = { resourceDeltas: [{ kind: "modify", path: "src/shared.ts" }] };
  const x = evaluate(base, head, { ...common, workIntent: { id: "W", addresses: ["R2", "R1"] } });
  const y = evaluate(base, head, { ...common, workIntent: { id: "W", addresses: ["R1", "R2"] } });
  assert.deepEqual(x, y);
});

test("I5 malformed authored relation is fail-closed at transition boundary", () => {
  const source = { path: "requirements/ROOT.json", value: { id: "ROOT", relations: { bad: { predicate: "implemented_by", target: { kind: "artifact", path: "../escape" } } } } };
  const requirements = loadCanonicalRequirements({ repository, revision: A, paths: [source.path], readFile: () => JSON.stringify(source.value) });
  const j2 = evaluateRootedRequirements({ requirements, trustedRoots: [requirements.index.ROOT.semantic] });
  const fake = { revision: A, requirements, j2, j1: { ok: true, owners: {} }, resourceRelations: [] };
  const head = { ...fake, revision: B, requirements: loadCanonicalRequirements({ repository, revision: B, paths: [source.path], readFile: () => JSON.stringify(source.value) }) };
  head.j2 = evaluateRootedRequirements({ requirements: head.requirements, trustedRoots: [head.requirements.index.ROOT.semantic] });
  const result = evaluateTransitionCauseClosure({ repository, base: fake, head, trustedAuthorityBase: authority(fake), workIntent: { id: "W", addresses: ["ROOT"] } });
  red(result, "invalid_relation:ROOT:bad", "malformed relation");
});

test("I5 remains non-authoritative behind I0 shadow seam; legacy v3 blocking report is unchanged", async () => {
  const { runPolicyPipeline, runPolicyPipelineShadow } = await import("../dist/runtime/pipeline.mjs");
  const input = {
    mode: "check-diff", repositoryRoot: "/tmp/i5-shadow", repositoryIdentity: repository,
    policy: { policy_format_version: "0.3.0", repository_kind: "tooling", paths: { forbidden: [], governance_paths: [], canonical_docs: [], operational_paths: [] }, diff_rules: { max_new_files: 10, max_new_docs: 10, max_net_added_lines: 100 }, content_rules: [], cochange_rules: [] },
    changeIntent: null, changeIntentSource: "none", enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText: "", trackedFiles: [], readFile: () => null,
  };
  const legacy = runPolicyPipeline(input, { quiet: true });
  const shadow = runPolicyPipelineShadow(input, { quiet: true }, () => ({ ok: false, reasons: ["J3:no_cause:synthetic"] }));
  assert.deepEqual(shadow.legacy, legacy);
  assert.equal(shadow.comparison.candidate.ok, false);
  assert.equal(shadow.comparison.identical, false);
});
