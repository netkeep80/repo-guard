import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkPolicyRelaxation, classifyChangedFiles, computePolicyDelta, policyRelaxationRuleFamily } from "../src/checks/rules/policy-delta-rules.mjs";

const file = (path, extra = {}) => ({ path, status: "modified", addedLines: [], deletedLines: [], ...extra });
const TRUSTED = { issue_author_permission_trusted: true };
const UNTRUSTED = { issue_author_permission_trusted: false, governance_approved_label: false, codeowner_approved: false, trusted_team_approval: false };
const BASE = {
  enforcement: { mode: "blocking" },
  paths: { forbidden: ["secrets/**"], governance_paths: ["repo-policy.json", "schemas/"] },
  diff_rules: { max_new_files: 5, max_new_docs: 2, max_net_added_lines: 50 },
  size_rules: [
    { id: "max-source", glob: "src/**/*.mjs", metric: "lines", max: 500, level: "blocking", count: "all_tracked" },
    { id: "max-doc", glob: "docs/**/*.md", metric: "lines", max: 300, level: "blocking", count: "all_tracked" },
  ],
  surfaces: { source: ["src/**"], tests: ["tests/**"], schemas: ["schemas/**"], docs: ["docs/**"] },
  integration: { workflows: [{ id: "gate", role: "repo_guard_pr_gate", path: ".github/workflows/ci.yml", expect: { enforcement: "blocking" } }] },
};
const mutate = (fn) => { const copy = structuredClone(BASE); fn(copy); return copy; };
const relax = () => mutate((policy) => { policy.size_rules[0].max = 1000; });
const grant = (pointer = "/size_rules/max-source/max") => ({ allow_policy_relaxation: [pointer] });

describe("Constraint Program strictness projection", () => {
  const cases = [
    ["size max", (p) => { p.size_rules[0].max = 1000; }, "size_rule_max_increased"],
    ["size level", (p) => { p.size_rules[0].level = "advisory"; }, "size_rule_level_weakened"],
    ["size count", (p) => { p.size_rules[0].count = "changed_only"; }, "size_rule_count_weakened"],
    ["diff budget", (p) => { p.diff_rules.max_new_files = 20; }, "diff_rule_budget_increased"],
    ["forbidden path", (p) => { p.paths.forbidden = []; }, "forbidden_path_removed"],
    ["governance path", (p) => { p.paths.governance_paths = ["repo-policy.json"]; }, "governance_path_removed"],
    ["workflow", (p) => { p.integration.workflows = []; }, "integration_workflow_removed"],
    ["enforcement", (p) => { p.enforcement.mode = "advisory"; }, "enforcement_weakened"],
  ];
  for (const [name, mutatePolicy, kind] of cases) it(`detects ${name} relaxation`, () => {
    const result = computePolicyDelta(BASE, mutate(mutatePolicy));
    assert.ok(result.relaxations.some((item) => item.kind === kind));
  });
  it("ignores tightening", () => assert.deepEqual(computePolicyDelta(BASE, mutate((p) => { p.diff_rules.max_new_files = 2; })), { relaxations: [] }));
  it("fails closed for unknown semantic sections", () => {
    const result = computePolicyDelta(BASE, mutate((p) => { p.content_rules = [{ id: "x", glob: "**", mode: "added_lines", forbid_regex: ["x"] }]; }));
    assert.equal(result.relaxations[0].kind, "policy_incomparable");
  });
});

describe("governance classification", () => {
  it("separates governance, protected and other files", () => {
    const result = classifyChangedFiles([file("repo-policy.json"), file("src/a.mjs"), file("docs/a.md")], BASE);
    assert.deepEqual(result.governanceFiles, ["repo-policy.json"]);
    assert.deepEqual(result.protectedFiles, ["src/a.mjs"]);
    assert.deepEqual(result.otherFiles, ["docs/a.md"]);
  });
  it("treats schemas as governance", () => assert.deepEqual(classifyChangedFiles([file("schemas/a.json")], BASE).governanceFiles, ["schemas/a.json"]));
});

describe("GovernanceGrant relaxation authorization", () => {
  const check = (overrides = {}) => checkPolicyRelaxation({
    basePolicy: BASE, headPolicy: relax(), changedFiles: [file("repo-policy.json")], trustedAuthorizer: TRUSTED,
    governanceGrant: grant(), changeIntentType: "governance", ...overrides,
  });
  it("allows a trusted governance-only grant covering the pointer", () => assert.equal(check().ok, true));
  it("accepts parent pointers", () => assert.equal(check({ governanceGrant: grant("/size_rules/max-source") }).ok, true));
  it("blocks missing grant", () => assert.ok(check({ governanceGrant: null }).blocked_reasons.includes("governance_grant_missing")));
  it("blocks incomplete grant", () => assert.ok(check({ governanceGrant: grant("/diff_rules/max_new_files") }).blocked_reasons.includes("governance_grant_does_not_cover_all_relaxations")));
  it("blocks untrusted authorizer", () => assert.ok(check({ trustedAuthorizer: UNTRUSTED }).blocked_reasons.includes("no_trusted_authorization_source")));
  it("blocks non-governance intent", () => assert.ok(check({ changeIntentType: "feature" }).blocked_reasons.includes("change_intent_type_is_not_governance")));
  it("blocks mixing relaxation with source changes", () => {
    const result = check({ changedFiles: [file("repo-policy.json"), file("src/a.mjs")] });
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });
  for (const [name, source] of [
    ["label", { governance_approved_label: true }], ["CODEOWNERS", { codeowner_approved: true }], ["team", { trusted_team_approval: true }],
  ]) it(`accepts trusted ${name} source`, () => assert.equal(check({ trustedAuthorizer: { ...UNTRUSTED, ...source } }).ok, true));
  it("does not require grants when policy is unchanged", () => assert.equal(checkPolicyRelaxation({ basePolicy: BASE, headPolicy: BASE, changedFiles: [], trustedAuthorizer: null, governanceGrant: null }).ok, true));
});

describe("policy-delta rule family", () => {
  it("uses GovernanceGrant facts", () => {
    const entry = policyRelaxationRuleFamily.evaluate({
      basePolicy: BASE, headPolicy: relax(), diff: { files: { checked: [file("repo-policy.json")] } },
      trustedAuthorizer: TRUSTED, governanceGrant: grant(), changeIntent: { change_type: "governance" },
    });
    assert.equal(entry.name, "policy-relaxation");
    assert.equal(entry.check.ok, true);
  });
});
