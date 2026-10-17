import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { evaluateTransitionCauseClosure } from "../dist/runtime/transition-closure.mjs";

const repository = "netkeep80/repo-guard";
const A = "a".repeat(40), B = "b".repeat(40);

function req(id, parent = null, resources = []) {
  const relations = {};
  if (parent) relations.parent = { predicate: "derives_from", target: { kind: "requirement", id: parent } };
  for (const [i, path] of resources.entries()) relations["r" + i] = { predicate: "implemented_by", target: { kind: "artifact", path } };
  return { id, relations };
}

function state(revision, docs, tracked, rootIds = ["ROOT"]) {
  const paths = docs.map((x) => "requirements/" + x.id + ".json");
  const requirements = loadCanonicalRequirements({
    repository, revision, paths,
    readFile: (_, path) => JSON.stringify(docs.find((x) => path === "requirements/" + x.id + ".json")),
  });
  const trustedRoots = rootIds.map((id) => requirements.index[id].semantic);
  const j2 = evaluateRootedRequirements({ requirements, trustedRoots });
  const resolver = createResourceResolver({
    repository, revision, requirements,
    readers: { [repository]: (sha, path) => sha === revision && tracked.includes(path) ? "exact:" + path : null },
  });
  const j1 = evaluateTrackedResourceClosure({ repository, revision, requirements, j2, trackedPaths: tracked, resolver });
  return { revision, requirements, j2, j1, resourceRelations: [] };
}

test("I5 RED: ordinary implementation delta has direct cause without RequirementDelta", () => {
  const docs = [req("ROOT"), req("R1", "ROOT", ["src/f.ts"])];
  const tracked = ["requirements/ROOT.json", "requirements/R1.json", "src/f.ts"];
  const base = state(A, docs, tracked), head = state(B, docs, tracked);
  const result = evaluateTransitionCauseClosure({
    repository, base, head, trustedAuthorityBase: base,
    resourceDeltas: [{ kind: "modify", path: "src/f.ts" }],
    workIntent: { id: "W", addresses: ["R1"] },
  });
  assert.equal(result.ok, true, result.reasons.join(", "));
  assert.equal(result.deltas.some((d) => d.kind.startsWith("requirement_")), false);
});

test("I5 RED: reverse impact does not widen causal causes for shared Resource", () => {
  const docs = [req("ROOT"), req("R1", "ROOT", ["src/shared.ts"]), req("R2", "ROOT", ["src/shared.ts"])];
  const tracked = docs.map((x) => "requirements/" + x.id + ".json").concat("src/shared.ts");
  const base = state(A, docs, tracked), head = state(B, docs, tracked);
  const result = evaluateTransitionCauseClosure({
    repository, base, head, trustedAuthorityBase: base,
    resourceDeltas: [{ kind: "modify", path: "src/shared.ts" }],
    workIntent: { id: "W", addresses: ["R1"] },
  });
  assert.equal(result.ok, true, result.reasons.join(", "));
  const why = result.explanations.whyChanged.find((x) => x.kind === "resource_modify");
  assert.deepEqual(why.causes, ["R1"]);
  assert.deepEqual(why.affected, ["R1", "R2", "ROOT"]);
});

test("I5 RED: candidate-added Requirement cannot self-authorize", () => {
  const baseDocs = [req("ROOT")];
  const headDocs = [req("ROOT"), req("EVIL", "ROOT", ["src/garbage.ts"])];
  const base = state(A, baseDocs, ["requirements/ROOT.json"]);
  const head = state(B, headDocs, ["requirements/ROOT.json", "requirements/EVIL.json", "src/garbage.ts"]);
  const result = evaluateTransitionCauseClosure({
    repository, base, head, trustedAuthorityBase: base,
    resourceDeltas: [{ kind: "add", path: "requirements/EVIL.json" }, { kind: "add", path: "src/garbage.ts" }],
    workIntent: { id: "candidate", addresses: ["EVIL"] },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((x) => x.includes("missing_authority:requirement:EVIL")));
});
