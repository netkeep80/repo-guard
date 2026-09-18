import assert from "node:assert/strict";
import { evaluatePrimitiveRelation } from "../dist/checks/relation-kernel.mjs";

const file = (path, status = "modified") => ({ path, status, addedLines: [], deletedLines: [] });
const facts = { diff: { files: { checked: [file("src/a.mjs"), file("secrets/token.txt")] } } };

const forbiddenSource = {
  source: "diff",
  selector: { kind: "changed_paths", patterns: ["secrets/**"], exclude_statuses: ["deleted"] },
  type: "repository_path_set",
};
const forbidden = evaluatePrimitiveRelation(facts, {
  relation_id: "paths:forbidden",
  primitive: "numeric_bound",
  operands: { source: forbiddenSource },
  parameters: { max: 0 },
});
assert.equal(forbidden.ok, false);
assert.equal(forbidden.actual, 1);
assert.deepEqual(forbidden.data.source_values, ["secrets/token.txt"]);
assert.deepEqual(forbidden.data.operands.source, forbiddenSource);

const cochange = evaluatePrimitiveRelation(facts, {
  relation_id: "cochange:0",
  primitive: "set_presence_implies",
  operands: {
    left: { source: "diff", selector: { kind: "changed_paths", patterns: ["src/**"] }, type: "repository_path_set" },
    right: { source: "diff", selector: { kind: "changed_paths", patterns: ["tests/**"] }, type: "repository_path_set" },
  },
  parameters: {},
});
assert.equal(cochange.ok, false);
assert.deepEqual(cochange.data.left.value, ["src/a.mjs"]);
assert.deepEqual(cochange.data.operands.right.selector.patterns, ["tests/**"]);

console.log("C3.3a canonical diagnostic evidence contract passed");
