import assert from "node:assert/strict";
import {
  checkRequirementTransition,
  compareRequirementRelationGraphs,
  normalizeRequirementAuthority,
  normalizeRequirementTransitionGrant,
} from "../dist/requirement-relations.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEXT = "c".repeat(40);
const trusted = { trusted: true, source: "repository_permission" };

function artifact(path, ...relations) {
  return { path, relations: ["requires", ...relations] };
}
function req(id, artifacts = [], extra = {}) {
  return { id, artifacts, ...extra };
}
function graph(snapshot, revision, docs) {
  return normalizeRequirementAuthority({
    snapshot,
    revision,
    sources: docs.map(([path, value]) => ({ path, format: "json", content: JSON.stringify(value) })),
  });
}
function empty(snapshot, revision) { return graph(snapshot, revision, []); }
function grant(base, head) {
  const delta = compareRequirementRelationGraphs(base, head);
  return {
    base_authority_sha256: base.authority_sha256,
    expected_head_authority_sha256: head.authority_sha256,
    add: delta.add,
    remove: delta.remove,
  };
}
function assertAuthorized(label, base, head) {
  const delta = compareRequirementRelationGraphs(base, head);
  assert.ok(delta.add.length + delta.remove.length > 0, `${label}: fixture needs a relation delta`);
  const noGrant = checkRequirementTransition({ base, head, trustedAuthorizer: trusted });
  assert.equal(noGrant.ok, false, `${label}: ungranted transition must be RED`);
  assert.ok(noGrant.reasons.includes("requirement_transition_grant_missing"));
  const exact = checkRequirementTransition({ base, head, grant: grant(base, head), trustedAuthorizer: trusted });
  assert.equal(exact.ok, true, `${label}: exact trusted transition must be GREEN`);
  const untrusted = checkRequirementTransition({ base, head, grant: grant(base, head), trustedAuthorizer: { trusted: false, source: "repository_permission" } });
  assert.equal(untrusted.ok, false, `${label}: untrusted transition must be RED`);
}

console.log("\n--- requirement relation normalizer ---");
{
  const yaml = normalizeRequirementAuthority({
    snapshot: "head",
    revision: HEAD,
    sources: [{
      path: "requirements/yaml.yaml",
      format: "yaml",
      content: [
        "id: RY",
        "artifacts:",
        "  - path: requirements/yaml.yaml",
        "    relations:",
        "      - requires",
        "      - documents",
        "",
      ].join("\n"),
    }],
  });
  const documents = yaml.relations.find((item) => item.relation === "documents");
  assert.deepEqual(documents?.provenance, {
    source_path: "requirements/yaml.yaml",
    subject_pointer: "/id",
    artifact_pointer: "/artifacts/0/path",
    relation_pointer: "/artifacts/0/relations/1",
    snapshot: "head",
    revision: HEAD,
  });
  assert.throws(() => normalizeRequirementAuthority({
    snapshot: "head",
    revision: HEAD,
    sources: [{ path: "requirements/bad.yaml", format: "yaml", content: "id: A\nid: B\n" }],
  }), /invalid YAML|duplicate/i);
  assert.throws(() => graph("head", HEAD, [["requirements/legacy.json", { id: "R1", artifacts: [{ path: "src/a.mts", role: "implementation", relations: ["requires"] }] }]]), /unknown field "role"/);
  assert.throws(() => graph("head", HEAD, [["requirements/no-requires.json", req("R1", [{ path: "src/a.mts", relations: ["implements"] }])]]), /must explicitly include "requires"/);
}

console.log("\n--- #644 requirement transition matrix ---");

// 1 add new requirement + first artifact
assertAuthorized("1 add requirement", empty("base", BASE), graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts", "implements")])]]));
// 2 add artifact to existing requirement
assertAuthorized("2 add artifact", graph("base", BASE, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])]]), graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts"), artifact("src/b.mts")])]]));
// 3 remove artifact + relation
assertAuthorized("3 remove artifact", graph("base", BASE, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts"), artifact("src/b.mts")])]]), graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])]]));
// 4 rename/move artifact
assertAuthorized("4 rename artifact", graph("base", BASE, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/old.mts")])]]), graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/new.mts")])]]));
// 5 rename requirement id
assertAuthorized("5 rename requirement", graph("base", BASE, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])]]), graph("head", HEAD, [["requirements/r1.json", req("R2", [artifact("requirements/r1.json"), artifact("src/a.mts")])]]));
// 6 ownership transfer
assertAuthorized("6 ownership transfer", graph("base", BASE, [
  ["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])],
  ["requirements/r2.json", req("R2", [artifact("requirements/r2.json")])],
]), graph("head", HEAD, [
  ["requirements/r1.json", req("R1", [artifact("requirements/r1.json")])],
  ["requirements/r2.json", req("R2", [artifact("requirements/r2.json"), artifact("src/a.mts")])],
]));
// 7 split requirement
assertAuthorized("7 split requirement", graph("base", BASE, [["requirements/r.json", req("R", [artifact("requirements/r.json"), artifact("src/a.mts"), artifact("src/b.mts")])]]), graph("head", HEAD, [
  ["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])],
  ["requirements/r2.json", req("R2", [artifact("requirements/r2.json"), artifact("src/b.mts")])],
]));
// 8 merge requirements
assertAuthorized("8 merge requirements", graph("base", BASE, [
  ["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])],
  ["requirements/r2.json", req("R2", [artifact("requirements/r2.json"), artifact("src/b.mts")])],
]), graph("head", HEAD, [["requirements/r.json", req("R", [artifact("requirements/r.json"), artifact("src/a.mts"), artifact("src/b.mts")])]]));
// 9 add/remove immutable relation: transition identity only; mutation semantics remains separately gated by the product constitution.
assertAuthorized("9 immutable relation delta", graph("base", BASE, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("docs/history.png")])]]), graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("docs/history.png", "immutable")])]]));
// 10 retire requirement
assertAuthorized("10 retire requirement", graph("base", BASE, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json")])]]), empty("head", HEAD));
// 11 bootstrap canonical requirement file
assertAuthorized("11 bootstrap requirement authority", empty("base", BASE), graph("head", HEAD, [["requirements/bootstrap.json", req("BOOT", [artifact("requirements/bootstrap.json")])]]));
// 12 requirement-owned <-> infrastructure transfer
assertAuthorized("12 infrastructure ownership transfer", graph("base", BASE, [
  ["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact(".github/workflows/ci.yml")])],
  ["requirements/infra.json", req("INFRA", [artifact("requirements/infra.json")])],
]), graph("head", HEAD, [
  ["requirements/r1.json", req("R1", [artifact("requirements/r1.json")])],
  ["requirements/infra.json", req("INFRA", [artifact("requirements/infra.json"), artifact(".github/workflows/ci.yml")])],
]));

// 13 concurrent PR from stale BASE
{
  const baseA = graph("base", BASE, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json")], { note: "A" })]]);
  const head = graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])]]);
  const stale = grant(baseA, head);
  const baseB = graph("base", NEXT, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json")], { note: "B" })]]);
  const verdict = checkRequirementTransition({ base: baseB, head, grant: stale, trustedAuthorizer: trusted });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.includes("requirement_transition_base_authority_mismatch"));
}
// 14 replay old grant
{
  const base = empty("base", BASE);
  const head = graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json")])]]);
  const oldGrant = grant(base, head);
  const replayBase = graph("base", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json")])]]);
  const replayHead = graph("head", NEXT, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])]]);
  const verdict = checkRequirementTransition({ base: replayBase, head: replayHead, grant: oldGrant, trustedAuthorizer: trusted });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.includes("requirement_transition_base_authority_mismatch"));
}
// 15 malformed / partial relation delta
{
  const base = empty("base", BASE);
  const head = graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])]]);
  const exact = grant(base, head);
  const partial = { ...exact, add: exact.add.slice(0, 1) };
  const verdict = checkRequirementTransition({ base, head, grant: partial, trustedAuthorizer: trusted });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.includes("requirement_transition_added_relations_mismatch"));
  assert.throws(() => normalizeRequirementTransitionGrant({ ...exact, add: [{ subject: "R1", relation: "unknown", object: "src/a.mts" }] }), /unknown relation/);
}
// 16 administrative requirement transition without dummy subject-matter evidence at the core authority layer
{
  const base = graph("base", BASE, [
    ["requirements/r1.json", req("R1", [artifact("requirements/r1.json"), artifact("src/a.mts")])],
    ["requirements/r2.json", req("R2", [artifact("requirements/r2.json")])],
  ]);
  const head = graph("head", HEAD, [
    ["requirements/r1.json", req("R1", [artifact("requirements/r1.json")])],
    ["requirements/r2.json", req("R2", [artifact("requirements/r2.json"), artifact("src/a.mts")])],
  ]);
  assert.equal(checkRequirementTransition({ base, head, grant: grant(base, head), trustedAuthorizer: trusted }).ok, true);
}

console.log("\n--- transition identity boundaries ---");
{
  const base = graph("base", BASE, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json")], { title: "old" })]]);
  const head = graph("head", HEAD, [["requirements/r1.json", req("R1", [artifact("requirements/r1.json")], { title: "new" })]]);
  assert.deepEqual(compareRequirementRelationGraphs(base, head), { add: [], remove: [] });
  assert.notEqual(base.authority_sha256, head.authority_sha256, "authority digest must bind non-relation source content too");
  assert.equal(checkRequirementTransition({ base, head, trustedAuthorizer: trusted }).ok, true, "content-only requirement edits remain owned by ordinary evidence semantics");
  const spurious = {
    base_authority_sha256: base.authority_sha256,
    expected_head_authority_sha256: head.authority_sha256,
    add: [{ subject: "R1", relation: "requires", object: "src/ghost.mts" }],
    remove: [],
  };
  const verdict = checkRequirementTransition({ base, head, grant: spurious, trustedAuthorizer: trusted });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.includes("requirement_transition_grant_without_relation_delta"));
}

console.log("requirement relation normalization + #644 transition matrix passed");
