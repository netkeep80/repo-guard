import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { compileConstraintProgram } from "../dist/checks/constraint-program.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/repo-policy.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const basePolicy = {
  policy_format_version: "0.3.0",
  repository_kind: "application",
  enforcement: { mode: "blocking" },
  paths: { forbidden: [], canonical_docs: [], governance_paths: ["repo-policy.json"] },
  diff_rules: { max_new_docs: 1, max_new_files: 2, max_net_added_lines: 20 },
  content_rules: [],
  cochange_rules: [],
};

for (const format of ["json", "yaml", "plain_text"]) {
  const path = format === "json" ? "package.json" : format === "yaml" ? "config.yml" : "VERSION";
  const pointer = format === "plain_text" ? "" : "/version";
  const policy = {
    ...basePolicy,
    document_relations: {
      documents: {
        source: { path, format },
      },
      rules: [{
        id: `version-monotonic-${format}`,
        kind: "scalar_strictly_greater",
        comparator: "semver",
        left: { document: "source", snapshot: "head", pointer, type: "string" },
        right: { document: "source", snapshot: "base", pointer, type: "string" },
      }],
    },
  };

  assert.equal(
    validate(policy),
    true,
    `${format} document selectors must expose canonical base/head snapshots; schema errors: ${JSON.stringify(validate.errors)}`,
  );

  const relation = compileConstraintProgram(policy).find((entry) => entry.runtime?.relation_id === `version-monotonic-${format}`)?.runtime;
  assert.ok(relation, `${format} version relation must lower into the canonical Constraint Program`);
  assert.equal(relation.operands.left.selector.snapshot, "head", `${format} left operand must lower to HEAD FactRef`);
  assert.equal(relation.operands.right.selector.snapshot, "base", `${format} right operand must lower to BASE FactRef`);
  assert.equal(relation.kind, "primitive_relation", `${format} lowering must keep the single canonical runtime kind`);
}

const invalidSnapshotPolicy = {
  ...basePolicy,
  document_relations: {
    documents: { package: { path: "package.json", format: "json" } },
    rules: [{
      id: "invalid-snapshot",
      kind: "scalar_equal",
      left: { document: "package", snapshot: "working-tree", pointer: "/version", type: "string" },
      right: { document: "package", pointer: "/version", type: "string" },
    }],
  },
};
assert.equal(validate(invalidSnapshotPolicy), false, "unknown document snapshots must fail schema validation");

console.log("C3.10b snapshot parity contract passed");
