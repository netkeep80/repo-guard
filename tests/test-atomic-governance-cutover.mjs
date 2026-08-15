import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkGovernanceChangeAuthorization } from "../dist/checks/rules/governance-paths.mjs";
import { checkPolicyRelaxation } from "../dist/checks/rules/policy-delta-rules.mjs";

const file = (path) => ({ path, status: "modified", addedLines: [], deletedLines: [] });
const TRUSTED = { issue_author_permission_trusted: true };
const UNTRUSTED = {
  issue_author_permission_trusted: false,
  governance_approved_label: false,
  codeowner_approved: false,
  trusted_team_approval: false,
};
const BASE = {
  paths: { governance_paths: ["repo-policy.json"] },
  surfaces: { source: ["src/**"], tests: ["tests/**"], schemas: ["schemas/**"] },
  size_rules: [{ id: "source", glob: "src/**", metric: "lines", max: 10, level: "blocking", count: "all_tracked" }],
};
const HEAD = structuredClone(BASE);
HEAD.size_rules[0].max = 20;
const FULL_GRANT = {
  authorized_governance_paths: ["repo-policy.json"],
  allow_policy_relaxation: ["/size_rules/source/max"],
  allow_atomic_governance_cutover: true,
};

function check(overrides = {}) {
  return checkPolicyRelaxation({
    basePolicy: BASE,
    headPolicy: HEAD,
    changedFiles: [file("repo-policy.json"), file("src/runtime.mjs")],
    trustedAuthorizer: TRUSTED,
    governanceGrant: FULL_GRANT,
    changeIntentType: "governance",
    ...overrides,
  });
}

function checkGovernance(overrides = {}) {
  return checkGovernanceChangeAuthorization({
    files: [file("repo-policy.json"), file("src/runtime.mjs")],
    governancePaths: ["repo-policy.json"],
    governanceGrant: FULL_GRANT,
    trustedAuthorizer: TRUSTED,
    changeIntentType: "governance",
    ...overrides,
  });
}

describe("atomic governance cutover authorization", () => {
  it("keeps mixed policy relaxation blocked without explicit opt-in", () => {
    const result = check({ governanceGrant: { authorized_governance_paths: ["repo-policy.json"], allow_policy_relaxation: ["/size_rules/source/max"] } });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("allows only the mixed-diff veto when trust, full coverage and governance intent are proven", () => {
    const result = check();
    assert.equal(result.ok, true);
    assert.equal(result.atomic_governance_cutover, true);
    assert.equal(result.governance_only, false);
  });

  it("does not trust the opt-in by itself", () => {
    const result = check({ trustedAuthorizer: UNTRUSTED });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("no_trusted_authorization_source"));
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("does not waive incomplete policy-relaxation pointer coverage", () => {
    const result = check({ governanceGrant: { ...FULL_GRANT, allow_policy_relaxation: ["/diff_rules"] } });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("governance_grant_does_not_cover_all_relaxations"));
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("requires a governance ChangeIntent", () => {
    const result = check({ changeIntentType: "feature" });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("change_intent_type_is_not_governance"));
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("requires at least one governance file in the mixed cutover", () => {
    const result = check({ changedFiles: [file("src/runtime.mjs")] });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("does not change the ordinary trusted governance-only path", () => {
    const result = check({
      changedFiles: [file("repo-policy.json")],
      governanceGrant: { authorized_governance_paths: ["repo-policy.json"], allow_policy_relaxation: ["/size_rules/source/max"] },
    });
    assert.equal(result.ok, true);
    assert.equal(result.governance_only, true);
    assert.equal(result.atomic_governance_cutover, false);
  });

  it("keeps ordinary governance ChangeIntent mixed paths blocked without atomic opt-in", () => {
    const result = checkGovernance({ governanceGrant: { authorized_governance_paths: ["repo-policy.json"] } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.non_governance_paths, ["src/runtime.mjs"]);
  });

  it("allows scoped mixed paths for a trusted atomic cutover while still authorizing governance paths", () => {
    const result = checkGovernance();
    assert.equal(result.ok, true);
    assert.equal(result.atomic_governance_cutover, true);
    assert.deepEqual(result.non_governance_paths, []);
    assert.deepEqual(result.unauthorized_paths, []);
  });

  it("does not let atomic mode waive governance-path authorization", () => {
    const result = checkGovernance({ governanceGrant: { ...FULL_GRANT, authorized_governance_paths: ["other-policy.json"] } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.unauthorized_paths, ["repo-policy.json"]);
  });

  it("does not let an untrusted atomic grant permit mixed paths", () => {
    const result = checkGovernance({ trustedAuthorizer: UNTRUSTED });
    assert.equal(result.ok, false);
    assert.equal(result.atomic_governance_cutover, false);
    assert.deepEqual(result.non_governance_paths, ["src/runtime.mjs"]);
    assert.deepEqual(result.unauthorized_paths, ["repo-policy.json"]);
  });
});
