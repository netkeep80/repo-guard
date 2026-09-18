import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import Ajv from "ajv";
import { compileCochangeGroupsPolicy } from "../dist/policy-compiler.mjs";
import { loadJSON } from "../dist/runtime/validation.mjs";

const schema = loadJSON(new URL("../schemas/repo-policy.schema.json", import.meta.url));
const validate = new Ajv({ allErrors: true }).compile(schema);

function policy(groups) {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: { forbidden: [], canonical_docs: [], governance_paths: [] },
    diff_rules: { max_new_files: 5, max_new_docs: 2 },
    content_rules: [],
    cochange_rules: [],
    cochange_groups: groups,
  };
}

describe("cochange_groups public boundary", () => {
  it("accepts the minimal generic group", () => {
    assert.equal(validate(policy([{ id: "pair", members: ["a.json", "b.json"] }])), true);
  });

  it("rejects structurally weak group shapes", () => {
    assert.equal(validate(policy([{ id: "pair", members: ["a.json"] }])), false);
    assert.equal(validate(policy([{ id: "pair", members: ["a.json", "a.json"] }])), false);
    assert.equal(validate(policy([{ id: "pair", members: ["a.json", "b.json"], executable: true }])), false);
  });

  it("rejects duplicate semantic identities", () => {
    assert.deepEqual(compileCochangeGroupsPolicy(policy([
      { id: "pair", members: ["a.json", "b.json"] },
      { id: "pair", members: ["c.json", "d.json"] },
    ])), [{ field: "cochange_groups", message: 'cochange group id "pair" is duplicated' }]);
  });

  it("rejects paths outside the repository even if schema validation is bypassed", () => {
    const errors = compileCochangeGroupsPolicy(policy([{ id: "pair", members: ["a.json", "../escape.json"] }]));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].field, "cochange_groups");
    assert.match(errors[0].message, /invalid repository path/);
  });
});
