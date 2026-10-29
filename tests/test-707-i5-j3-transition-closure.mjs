import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { evaluateTransitionCauseClosure } from "../dist/runtime/transition-closure.mjs";

const repository = "netkeep80/repo-guard";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
const artifact = (path, predicate = "implemented_by") => ({ predicate, target: { kind: "artifact", path } });
function requirement(id, { parent = null, artifacts = [], extra = {} } = {}) {
  const relations = {};
  if (parent) relations.parent = { predicate: "derives_from", target: { kind: "requirement", id: parent } };
  artifacts.forEach((rel, index) => { relations["a" + index] = artifact(rel.path, rel.predicate); });
  return { path: `requirements/${id}.json`, value: { id, ...extra, relations } };
}
function state(revision, sources, files = [], rootIds = ["ROOT"]) {
  const byPath = new Map(sources.map(source => [source.path, source.value]));
  const requirements = loadCanonicalRequirements({
    repository, revision, paths: sources.map(source => source.path),
    readFile: (_, path) => byPath.has(path) ? JSON.stringify(byPath.get(path)) : null,
  });
  assert.equal(requirements.ok, true, JSON.stringify(requirements.errors));
  const j2 = evaluateRootedRequirements({ requirements, trustedRoots: rootIds.map(id => requirements.index[id].semantic) });
  assert.equal(j2.ok, true, JSON.stringify(j2));
  const trackedPaths = [...sources.map(source => source.path), ...files];
  const resolver = createResourceResolver({
    repository, revision, requirements,
    readers: { [repository]: (sha, path) => sha === revision && trackedPaths.includes(path)
      ? (byPath.has(path) ? JSON.stringify(byPath.get(path)) : "exact:" + revision + ":" + path) : null },
  });
  const j1 = evaluateTrackedResourceClosure({ repository, revision, requirements, j2, trackedPaths, resourceRelations: [], resolver });
  assert.equal(j1.ok, true, JSON.stringify(j1));
  return { revision, requirements, j2, j1, resourceRelations: [] };
}
const authority = state => ({ revision: state.revision, requirements: state.requirements, j2: state.j2, j1: state.j1, resourceRelations: state.resourceRelations });
const evaluate = (base, head, options = {}) => evaluateTransitionCauseClosure({
  repository, base, head, trustedAuthorityBase: options.trustedAuthorityBase || authority(base),
  resourceDeltas: options.resourceDeltas || [], baseLifecycle: options.baseLifecycle || {}, headLifecycle: options.headLifecycle || {},
});
const green = (result, label) => assert.equal(result.ok, true, label + ": " + result.reasons.join(" | "));
const red = (result, fragment, label) => {
  assert.equal(result.ok, false, label + " unexpectedly GREEN");
  assert.ok(result.reasons.some(reason => reason.includes(fragment)), label + " missing " + fragment + ": " + result.reasons.join(" | "));
};

test("J3 compiler: new rooted Requirement and implementation are causally GREEN without external authority", () => {
  const before = [requirement("ROOT")];
  const after = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [{ path: "src/new.ts" }] })];
  const base = state(A, before), head = state(B, after, ["src/new.ts"]);
  green(evaluate(base, head, { resourceDeltas: [{ kind: "add", path: "src/new.ts" }] }), "add");
});

test("J3 compiler: unchanged Requirement directly causes implementation modification", () => {
  const docs = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [{ path: "src/a.ts" }] })];
  const base = state(A, docs, ["src/a.ts"]), head = state(B, docs, ["src/a.ts"]);
  const result = evaluate(base, head, { resourceDeltas: [{ kind: "modify", path: "src/a.ts" }] });
  green(result, "modify");
  const delta = result.explanations.whyChanged.find(item => item.kind === "resource_modify");
  assert.deepEqual(delta.causes, ["R1"]);
});

test("J3 compiler: shared Resource keeps all direct causal owners", () => {
  const docs = [requirement("ROOT"),
    requirement("R1", { parent: "ROOT", artifacts: [{ path: "src/shared.ts" }] }),
    requirement("R2", { parent: "ROOT", artifacts: [{ path: "src/shared.ts" }] })];
  const base = state(A, docs, ["src/shared.ts"]), head = state(B, docs, ["src/shared.ts"]);
  const result = evaluate(base, head, { resourceDeltas: [{ kind: "modify", path: "src/shared.ts" }] });
  green(result, "shared");
  const delta = result.explanations.whyChanged.find(item => item.kind === "resource_modify");
  assert.deepEqual(delta.causes, ["R1", "R2"]);
});

test("J3 compiler: exact rename is a Resource transition, not Requirement delete/add", () => {
  const before = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [{ path: "src/old.ts" }] })];
  const after = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [{ path: "src/new.ts" }] })];
  const base = state(A, before, ["src/old.ts"]), head = state(B, after, ["src/new.ts"]);
  const result = evaluate(base, head, { resourceDeltas: [{ kind: "rename", previousPath: "src/old.ts", path: "src/new.ts" }] });
  green(result, "rename");
  assert.ok(result.deltas.some(delta => delta.kind === "resource_rename"));
  assert.equal(result.deltas.some(delta => delta.kind === "requirement_add" || delta.kind === "requirement_remove"), false);
});

test("J3 compiler: repository transition rule contributes a versioned causal candidate", () => {
  const accepted = [requirement("ROOT"), requirement("R-PROC", { parent: "ROOT", extra: { transition: { deltaKinds: ["resource_modify"], paths: ["src/stack.ts"] } } })];
  const local = [...accepted, requirement("R-STACK", { parent: "ROOT", artifacts: [{ path: "src/stack.ts" }] })];
  const acceptedState = state(A, accepted), base = state(C, local, ["src/stack.ts"]), head = state(D, local, ["src/stack.ts"]);
  const result = evaluate(base, head, { trustedAuthorityBase: authority(acceptedState), resourceDeltas: [{ kind: "modify", path: "src/stack.ts" }] });
  green(result, "stacked");
  const delta = result.explanations.whyChanged.find(item => item.kind === "resource_modify");
  assert.deepEqual(delta.causes, ["R-PROC", "R-STACK"]);
});

test("J3 compiler: a transition with no repository causal candidate is RED", () => {
  const docs = [requirement("ROOT")];
  const base = state(A, docs), head = state(B, docs);
  red(evaluate(base, head, { resourceDeltas: [{ kind: "modify", path: "src/unowned.ts" }] }), "J3:no_cause", "no cause");
});

test("J3 compiler: stale authority snapshot is rejected exactly", () => {
  const docs = [requirement("ROOT"), requirement("R1", { parent: "ROOT", artifacts: [{ path: "src/a.ts" }] })];
  const base = state(A, docs, ["src/a.ts"]), head = state(B, docs, ["src/a.ts"]);
  const stale = { ...authority(base), revision: C };
  red(evaluate(base, head, { trustedAuthorityBase: stale, resourceDeltas: [{ kind: "modify", path: "src/a.ts" }] }), "authority_base:snapshot_mismatch", "stale");
});


test("#840 B1 legacy malformed nested Relation target remains structured RED", () => {
  const base = state(A, [requirement("ROOT")]), head = state(B, [requirement("ROOT")]);
  const malformed = {
    bad: {
      predicate: "documents",
      target: { kind: "document", path: "docs/a.json", pointer: NaN },
    },
  };
  base.requirements.index.ROOT.value.relations = malformed;
  head.requirements.index.ROOT.value.relations = malformed;

  let result;
  assert.doesNotThrow(() => {
    result = evaluate(base, head);
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("base:invalid_relation:ROOT:bad:non-canonical transition value"), result.reasons.join(" | "));
  assert.ok(result.reasons.includes("head:invalid_relation:ROOT:bad:non-canonical transition value"), result.reasons.join(" | "));
});

test("#840 Slice 4 legacy malformed relation map remains fail-closed", () => {
  const base = state(A, [requirement("ROOT")]), head = state(B, [requirement("ROOT")]);
  base.requirements.index.ROOT.value.relations = [];
  head.requirements.index.ROOT.value.relations = [];
  const result = evaluate(base, head);
  red(result, "base:invalid_relation_map:ROOT", "legacy relation map");
  red(result, "head:invalid_relation_map:ROOT", "legacy relation map");
});

test("#840 Slice 4 legacy malformed relation item remains fail-closed", () => {
  const base = state(A, [requirement("ROOT")]), head = state(B, [requirement("ROOT")]);
  base.requirements.index.ROOT.value.relations = { bad: { predicate: "", target: { kind: "artifact", path: "src/a.ts" } } };
  head.requirements.index.ROOT.value.relations = { bad: { predicate: "", target: { kind: "artifact", path: "src/a.ts" } } };
  const result = evaluate(base, head);
  red(result, "base:invalid_relation:ROOT:bad", "legacy relation item");
  red(result, "head:invalid_relation:ROOT:bad", "legacy relation item");
});

test("#840 Slice 4 legacy malformed resource relation remains fail-closed", () => {
  const base = state(A, [requirement("ROOT")]), head = state(B, [requirement("ROOT")]);
  base.resourceRelations = [{ from: "src/a.ts", kind: "unsupported", to: "dist/a.js" }];
  head.resourceRelations = [{ from: "src/a.ts", kind: "unsupported", to: "dist/a.js" }];
  const result = evaluate(base, head);
  red(result, "base:invalid_resource_relation:0:unsupported_kind", "legacy resource relation");
  red(result, "head:invalid_resource_relation:0:unsupported_kind", "legacy resource relation");
});

test("#840 Slice 4 legacy duplicate Relation identity remains fail-closed", () => {
  const base = state(A, [requirement("ROOT")]), head = state(B, [requirement("ROOT")]);
  const duplicate = {
    first: { predicate: "implemented_by", target: { kind: "artifact", path: "src/a.ts" } },
    second: { predicate: "implemented_by", target: { kind: "artifact", path: "src/a.ts" } },
  };
  base.requirements.index.ROOT.value.relations = duplicate;
  head.requirements.index.ROOT.value.relations = duplicate;
  const result = evaluate(base, head);
  red(result, "base:duplicate_relation:", "legacy duplicate relation");
  red(result, "head:duplicate_relation:", "legacy duplicate relation");
});

console.log("J3 compiler-only transition closure witnesses loaded");
