import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAjv, loadJSON, loadPolicyRuntimeFromObject } from "../dist/runtime/validation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("runtime validation boundary", () => {
  it("keeps schema-valid invalid regex policy fail-closed in semantic compilation", () => {
    const validPolicy = loadJSON(resolve(root, "tests/fixtures/valid-policy.json"));
    const policy = {
      ...validPolicy,
      content_rules: [{
        ...validPolicy.content_rules[0],
        forbid_regex: ["[invalid("],
      }],
    };
    const ajv = createAjv();
    const policySchema = loadJSON(resolve(root, "schemas/repo-policy.schema.json"));

    assert.equal(ajv.validate(policySchema, policy), true);
    assert.equal(loadPolicyRuntimeFromObject({ packageRoot: root, repoRoot: root }, policy, { quiet: true }).ok, false);
  });
});
