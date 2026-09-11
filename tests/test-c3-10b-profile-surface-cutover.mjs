import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { resolvePolicyProfile } from "../dist/policy-profiles.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/repo-policy.schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

const base = {
  policy_format_version: "0.3.0",
  repository_kind: "library",
  paths: { forbidden: [], canonical_docs: ["README.md"], governance_paths: ["repo-policy.json"] },
  diff_rules: { max_new_docs: 2, max_new_files: 10, max_net_added_lines: 1000 },
  content_rules: [],
  cochange_rules: [],
};

const compact = {
  ...base,
  packs: {
    "requirements-strict": {
      strict_heading_docs: ["docs/architecture.md"],
      evidence_surfaces: ["src/**", "tests/**", "docs/**"],
    },
  },
};
assert.equal(validate(compact), true, `requirements-strict pack must remain valid: ${JSON.stringify(validate.errors)}`);
const resolved = resolvePolicyProfile(compact);
assert.equal(resolved.ok, true, `requirements-strict pack must lower: ${JSON.stringify(resolved.errors)}`);
assert.ok(resolved.policy.anchors?.types?.requirement_id, "pack must retain requirement anchor semantics");
assert.ok(resolved.policy.trace_rules?.some((rule) => rule.id === "changed-requirements-need-evidence"), "pack must retain requirement evidence semantics");
assert.equal(Object.hasOwn(resolved.policy, "packs"), false, "pack authoring sugar must disappear after lowering");

const legacyProfile = { ...base, profile: "requirements-strict" };
assert.equal(validate(legacyProfile), false, "top-level profile must be removed from the v3 public policy surface");

const legacyOverrides = {
  ...base,
  profile_overrides: { strict_heading_docs: ["docs/architecture.md"] },
};
assert.equal(validate(legacyOverrides), false, "top-level profile_overrides must be removed from the v3 public policy surface");

const legacyBoth = {
  ...base,
  profile: "requirements-strict",
  profile_overrides: { strict_heading_docs: ["docs/architecture.md"] },
};
assert.equal(validate(legacyBoth), false, "combined legacy profile/profile_overrides authoring must fail closed");

console.log("C3.10b profile surface cutover contract passed");
