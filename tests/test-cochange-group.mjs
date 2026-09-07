import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";

const members = ["a.json", "b.json", "c.json"];
const file = (path) => ({ path, status: "modified", addedLines: [], deletedLines: [] });

function evaluate(changedPaths) {
  const results = evaluateConstraintIR({
    policy: {
      paths: { canonical_docs: [], operational_paths: [] },
      cochange_groups: [{ id: "pair", members }],
    },
    diff: { files: { checked: changedPaths.map(file) } },
  }, { executionPhase: "transaction" });
  const result = results.find((entry) => entry.name === "cochange-group:pair");
  assert.ok(result, "canonical runtime must emit cochange-group:pair");
  return result.check;
}

describe("cochange_group runtime", () => {
  it("passes when no member changed", () => {
    const check = evaluate([]);
    assert.equal(check.ok, true);
    assert.deepEqual(check.changed, []);
    assert.deepEqual(check.missing, members);
  });

  it("fails when a non-empty proper subset changed", () => {
    const one = evaluate(["a.json"]);
    assert.equal(one.ok, false);
    assert.deepEqual(one.changed, ["a.json"]);
    assert.deepEqual(one.missing, ["b.json", "c.json"]);

    const two = evaluate(["a.json", "b.json"]);
    assert.equal(two.ok, false);
    assert.deepEqual(two.changed, ["a.json", "b.json"]);
    assert.deepEqual(two.missing, ["c.json"]);
  });

  it("passes when every member changed", () => {
    const check = evaluate(members);
    assert.equal(check.ok, true);
    assert.deepEqual(check.changed, members);
    assert.deepEqual(check.missing, []);
  });
});
