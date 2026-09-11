import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";

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

const structuredSnapshotPolicy = {
  ...basePolicy,
  document_relations: {
    documents: {
      package: { path: "package.json", format: "json" },
    },
    rules: [{
      id: "version-monotonic",
      kind: "scalar_strictly_greater",
      comparator: "semver",
      left: { document: "package", snapshot: "head", pointer: "/version", type: "string" },
      right: { document: "package", snapshot: "base", pointer: "/version", type: "string" },
    }],
  },
};

assert.equal(
  validate(structuredSnapshotPolicy),
  true,
  `JSON document selectors must expose canonical base/head snapshots; schema errors: ${JSON.stringify(validate.errors)}`,
);

for (const [name, config] of Object.entries({
  "version-governance": {
    authority: { path: "package.json", pointer: "/version" },
    advance: "semver",
    mirrors: [{ path: "package-lock.json", pointer: "/version" }],
  },
  "repo-guard-workflow": {
    path: ".github/workflows/repo-guard.yml",
    action: "netkeep80/repo-guard",
    ref: "0123456789abcdef0123456789abcdef01234567",
    mode: "check-pr",
    enforcement: "blocking",
    permissions: { contents: "read", issues: "read", "pull-requests": "read" },
  },
})) {
  const policy = { ...basePolicy, packs: { [name]: config } };
  assert.equal(
    validate(policy),
    true,
    `built-in pack ${name} must be accepted by the public schema; errors: ${JSON.stringify(validate.errors)}`,
  );
}

const unknownPack = { ...basePolicy, packs: { "user-defined": { expression: "anything" } } };
assert.equal(validate(unknownPack), false, "unknown/user-defined packs must remain closed and fail schema validation");

console.log("C3.10b RED contract captured: structured snapshots + closed built-in packs");
