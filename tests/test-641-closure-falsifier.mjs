import assert from "node:assert/strict";
import { readFact, createDocumentReader } from "../dist/document-facts.mjs";
import { evaluatePrimitiveRelation } from "../dist/checks/relation-kernel.mjs";

// #641 PRE-IMPLEMENTATION FALSIFIER.
// This test intentionally fails on accepted main: tracked Git paths cannot yet
// be read as a typed repository_path_set by the existing set_equal primitive.
const justified = ["A", "requirements/ownership.yaml"];
const tracked = ["A", "orphan.txt", "requirements/ownership.yaml"];
const documents = createDocumentReader({
  readFile: (path) => path === "requirements/ownership.yaml"
    ? "artifacts:\n  - A\n  - requirements/ownership.yaml\n"
    : null,
});
const facts = { documents, trackedFiles: tracked };
const repositoryOperand = {
  source: "repository",
  selector: { kind: "tracked_paths" },
  type: "repository_path_set",
};
const authorityOperand = {
  source: "document",
  selector: {
    path: "requirements/ownership.yaml",
    format: "yaml",
    snapshot: "state",
    pointer: "/artifacts",
    projection: "array_items",
  },
  type: "repository_path_set",
};
const trackedFact = readFact(facts, repositoryOperand);
assert.equal(trackedFact.ok, true, "exact Git-tracked paths must be exposed as one typed FactRef");
assert.deepEqual(trackedFact.value, tracked);
const verdict = evaluatePrimitiveRelation(facts, {
  relation_id: "closed-repository",
  primitive: "set_equal",
  operands: { left: authorityOperand, right: repositoryOperand },
  parameters: {},
});
assert.equal(verdict.ok, false, "orphan.txt must trigger RED");
assert.deepEqual(verdict.data.extra_values, ["orphan.txt"]);
assert.deepEqual(readFact(facts, authorityOperand).value, justified);
console.log("#641 orphan tracked-file falsifier passed");
