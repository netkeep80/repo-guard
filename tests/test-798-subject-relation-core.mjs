import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSubjectRelations,
  reverseImpact,
} from "../dist/runtime/subject-relations.mjs";
import {
  loadCanonicalRequirements,
} from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";

const resource = (path, pointer) => ({ kind: "resource", path, ...(pointer !== undefined ? { pointer } : {}) });
const requirement = (id) => ({ kind: "requirement", id });
const relation = (id) => ({ kind: "relation", id });

test("#798 Resource -> Resource depends_on is deterministic and reverse impact is role-bounded", () => {
  const A = resource("src/a.ts"), B = resource("src/b.ts"), C = resource("src/c.ts");
  const input = {
    subjects: [C, A, B],
    roles: ["impact", "other"],
    relations: [
      { id: "R1", meaning: "depends_on", role: "impact", source: A, target: B },
      { id: "R2", meaning: "depends_on", role: "other", source: C, target: B },
    ],
  };
  const first = evaluateSubjectRelations(input);
  const second = evaluateSubjectRelations({
    ...input,
    subjects: [...input.subjects].reverse(),
    relations: [...input.relations].reverse(),
  });
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, "same normalized input set must produce the same report");
  assert.deepEqual(reverseImpact(first.relations, B, { roles: ["impact"] }), [A, B]);
  assert.deepEqual(reverseImpact(first.relations, B, { roles: ["other"] }), [B, C]);
});

test("#798 malformed runtime input returns RED instead of throwing", () => {
  let result;
  assert.doesNotThrow(() => {
    result = evaluateSubjectRelations({
      subjects: [{ kind: "resource", path: undefined }],
      relations: [{ meaning: "depends_on", source: { kind: "resource", path: undefined }, target: resource("src/a.ts") }],
    });
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === "invalid_subject"));
});

test("#798 durable fragment SubjectRef and missing target fail closed", () => {
  const doc = resource("model/data.json", "/byId/core");
  const ok = evaluateSubjectRelations({
    subjects: [doc, resource("src/a.ts")],
    roles: ["impact"],
    relations: [{ meaning: "depends_on", role: "impact", source: resource("src/a.ts"), target: doc }],
  });
  assert.equal(ok.ok, true);

  const positional = evaluateSubjectRelations({
    subjects: [resource("model/data.json", "/items/0")],
    relations: [],
  });
  assert.equal(positional.ok, false);
  assert.ok(positional.errors.some(error => error.code === "invalid_subject"));

  const missing = evaluateSubjectRelations({
    subjects: [resource("src/a.ts")],
    roles: ["impact"],
    relations: [{ meaning: "depends_on", role: "impact", source: resource("src/a.ts"), target: resource("src/missing.ts") }],
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => error.code === "missing_subject"));
});

test("#798 named Relation is addressable without becoming a new ontology", () => {
  const A = resource("src/a.ts"), B = resource("src/b.ts"), verifier = resource("tests/relation.mjs");
  const result = evaluateSubjectRelations({
    subjects: [A, B, verifier],
    roles: ["impact", "evidence"],
    relations: [
      { id: "R_IMPL", meaning: "depends_on", role: "impact", source: A, target: B },
      { id: "R_VERIFY", meaning: "trace", role: "evidence", source: verifier, target: relation("R_IMPL") },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.relations.some(item => item.target.kind === "relation" && item.target.id === "R_IMPL"), true);

  const duplicate = evaluateSubjectRelations({
    subjects: [A, B],
    roles: ["impact"],
    relations: [
      { id: "R", meaning: "depends_on", role: "impact", source: A, target: B },
      { id: "R", meaning: "trace", role: "impact", source: B, target: A },
    ],
  });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some(error => error.code === "duplicate_relation_id"));

  const missingRelation = evaluateSubjectRelations({
    subjects: [A, verifier],
    roles: ["evidence"],
    relations: [
      { id: "R_VERIFY", meaning: "trace", role: "evidence", source: verifier, target: relation("ABSENT") },
    ],
  });
  assert.equal(missingRelation.ok, false, "unknown named relation target is RED");
  assert.ok(missingRelation.errors.some(error => error.code === "missing_subject" && error.detail === "relation:ABSENT"));
});

test("#798 unknown finite meaning is RED", () => {
  const A = resource("src/a.ts"), B = resource("src/b.ts");
  const result = evaluateSubjectRelations({
    subjects: [A, B],
    relations: [{ meaning: "invented_semantics", source: A, target: B }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === "unknown_meaning"));
});

test("#798 project roles are declared data; unknown executable role is RED", () => {
  const A = resource("src/a.ts"), B = resource("src/b.ts");
  const unknown = evaluateSubjectRelations({
    subjects: [A, B],
    roles: ["known"],
    relations: [{ meaning: "depends_on", role: "unknown", source: A, target: B }],
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(error => error.code === "unknown_role"));

  const selection = evaluateSubjectRelations({
    subjects: [A, B],
    roles: ["known"],
    relations: [{ meaning: "depends_on", role: "known", source: A, target: B }],
    acyclic: [{ meaning: "depends_on", roles: ["undeclared"] }],
  });
  assert.equal(selection.ok, false);
  assert.ok(selection.errors.some(error => error.code === "invalid_acyclic_selection"));
});

test("#798 cycles are scoped: traceability cycle allowed, selected ordering cycle RED", () => {
  const A = resource("src/a.ts"), B = resource("src/b.ts");
  const traceCycle = evaluateSubjectRelations({
    subjects: [A, B],
    roles: ["trace"],
    relations: [
      { meaning: "trace", role: "trace", source: A, target: B },
      { meaning: "trace", role: "trace", source: B, target: A },
    ],
  });
  assert.equal(traceCycle.ok, true, "ordinary incidence/traceability is not globally acyclic");

  const orderCycle = evaluateSubjectRelations({
    subjects: [A, B],
    roles: ["order"],
    relations: [
      { meaning: "depends_on", role: "order", source: A, target: B },
      { meaning: "depends_on", role: "order", source: B, target: A },
    ],
    acyclic: [{ meaning: "depends_on", roles: ["order"] }],
  });
  assert.equal(orderCycle.ok, false);
  assert.ok(orderCycle.errors.some(error => error.code === "relation_cycle"));

  const mixedRoleCycle = evaluateSubjectRelations({
    subjects: [A, B],
    roles: ["reader", "proof-premise"],
    relations: [
      { meaning: "depends_on", role: "reader", source: A, target: B },
      { meaning: "depends_on", role: "proof-premise", source: B, target: A },
    ],
    acyclic: [{ meaning: "depends_on", roles: ["reader", "proof-premise"] }],
  });
  assert.equal(mixedRoleCycle.ok, false, "a mixed-role cycle is detected when the strict order selects both roles");
  assert.ok(mixedRoleCycle.errors.some(error => error.code === "relation_cycle"));
});

test("#798 Requirement-only semantics remain normative", () => {
  const R = requirement("R1"), A = resource("src/a.ts");
  const valid = evaluateSubjectRelations({
    subjects: [R, A],
    relations: [{ meaning: "requires", source: R, target: A }],
  });
  assert.equal(valid.ok, true);

  const invalid = evaluateSubjectRelations({
    subjects: [R, A],
    relations: [{ meaning: "requires", source: A, target: R }],
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some(error => error.code === "invalid_domain"));
});

test("#798 rooted normative closure remains J2; a closed cycle cannot self-authorize", () => {
  const revision = "a".repeat(40);
  const repository = "fixture/r798";
  const docs = [
    { id: "A", relations: { d: { predicate: "derives_from", target: { kind: "requirement", id: "B" } } } },
    { id: "B", relations: { d: { predicate: "derives_from", target: { kind: "requirement", id: "A" } } } },
  ];
  const requirements = loadCanonicalRequirements({
    repository,
    revision,
    paths: ["requirements/A.json", "requirements/B.json"],
    readFile: (_sha, path) => JSON.stringify(docs.find(doc => path === "requirements/" + doc.id + ".json")),
  });
  const closed = evaluateRootedRequirements({ requirements, trustedRoots: [] });
  assert.equal(closed.ok, false);
  assert.deepEqual(closed.unrooted, ["A", "B"]);

  const rootedDocs = [
    { id: "ROOT", relations: {} },
    { id: "A", relations: {
      root: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } },
      cycle: { predicate: "derives_from", target: { kind: "requirement", id: "B" } },
    } },
    { id: "B", relations: { cycle: { predicate: "derives_from", target: { kind: "requirement", id: "A" } } } },
  ];
  const rootedRequirements = loadCanonicalRequirements({
    repository,
    revision,
    paths: rootedDocs.map(doc => "requirements/" + doc.id + ".json"),
    readFile: (_sha, path) => JSON.stringify(rootedDocs.find(doc => path === "requirements/" + doc.id + ".json")),
  });
  const rooted = evaluateRootedRequirements({
    requirements: rootedRequirements,
    trustedRoots: [rootedRequirements.index.ROOT.semantic],
  });
  assert.equal(rooted.ok, true, "a cycle reachable from an admitted root is not rejected by a global DAG rule");
});
