import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkGovernanceChangeAuthorization } from "../dist/checks/rules/governance-paths.mjs";
import { createDefaultRuleRegistry } from "../dist/checks/default-rule-families.mjs";
import { buildPolicyFacts } from "../dist/facts/input.mjs";
import { runPolicyChecks } from "../dist/checks/orchestrator.mjs";
import { createAnalysisCollector } from "../dist/runtime/analysis-report.mjs";
import { extractGovernanceGrant } from "../dist/change-intent.mjs";

const PATHS = ["repo-policy.json", "schemas/", ".github/workflows/", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/", "templates/", "action.yml"];
const TRUSTED = { issue_author_permission_trusted: true, governance_approved_label: false, codeowner_approved: false, trusted_team_approval: false };
const UNTRUSTED = { issue_author_permission_trusted: false, governance_approved_label: false, codeowner_approved: false, trusted_team_approval: false };
const file = (path) => ({ path, status: "modified", addedLines: ["+"], deletedLines: [] });
const grant = (...paths) => ({ authorized_governance_paths: paths });
const intent = (changeType) => ({ change_type: changeType, scope: ["**"], budgets: {}, must_touch: [], must_not_touch: [], expected_effects: [changeType] });

describe("GovernanceGrant authorization", () => {
  it("passes when governance is untouched for ordinary changes", () => assert.equal(checkGovernanceChangeAuthorization({ files: [file("src/a.mjs")], governancePaths: PATHS }).ok, true));
  it("blocks governance without grant", () => {
    const result = checkGovernanceChangeAuthorization({ files: [file("repo-policy.json")], governancePaths: PATHS });
    assert.equal(result.ok, false); assert.deepEqual(result.unauthorized_paths, ["repo-policy.json"]);
  });
  it("allows exact or glob grant from trusted source", () => {
    for (const [path, pattern] of [["repo-policy.json", "repo-policy.json"], ["schemas/a.json", "schemas/**"]]) {
      const result = checkGovernanceChangeAuthorization({ files: [file(path)], governancePaths: PATHS, governanceGrant: grant(pattern), trustedAuthorizer: TRUSTED });
      assert.equal(result.ok, true); assert.deepEqual(result.unauthorized_paths, []);
    }
  });
  it("blocks untrusted grant", () => {
    const result = checkGovernanceChangeAuthorization({ files: [file("repo-policy.json")], governancePaths: PATHS, governanceGrant: grant("repo-policy.json"), trustedAuthorizer: UNTRUSTED });
    assert.equal(result.ok, false); assert.equal(result.untrusted_governance_grant_ignored, true);
  });
  it("accepts trusted label/codeowner/team sources", () => {
    for (const source of [{ governance_approved_label: true }, { codeowner_approved: true }, { trusted_team_approval: true }]) {
      assert.equal(checkGovernanceChangeAuthorization({ files: [file("repo-policy.json")], governancePaths: PATHS, governanceGrant: grant("repo-policy.json"), trustedAuthorizer: { ...UNTRUSTED, ...source } }).ok, true);
    }
  });
  it("reports partial grant", () => {
    const result = checkGovernanceChangeAuthorization({ files: [file("repo-policy.json"), file("schemas/a.json")], governancePaths: PATHS, governanceGrant: grant("repo-policy.json"), trustedAuthorizer: TRUSTED });
    assert.deepEqual(result.unauthorized_paths, ["schemas/a.json"]);
  });
  it("is a no-op for empty trusted boundary on ordinary changes", () => assert.equal(checkGovernanceChangeAuthorization({ files: [file("repo-policy.json")], governancePaths: [] }).ok, true));
});

describe("reserved governance ChangeIntent", () => {
  it("allows only trusted and granted governance files", () => {
    const result = checkGovernanceChangeAuthorization({
      files: [file("repo-policy.json"), file("schemas/a.json")], governancePaths: PATHS,
      governanceGrant: grant("repo-policy.json", "schemas/**"), trustedAuthorizer: TRUSTED, changeIntentType: "governance",
    });
    assert.equal(result.ok, true); assert.deepEqual(result.non_governance_paths, []);
  });
  it("blocks any ordinary file mixed into a governance change", () => {
    const result = checkGovernanceChangeAuthorization({
      files: [file("repo-policy.json"), file("src/a.mjs")], governancePaths: PATHS,
      governanceGrant: grant("repo-policy.json"), trustedAuthorizer: TRUSTED, changeIntentType: "governance",
    });
    assert.equal(result.ok, false); assert.deepEqual(result.non_governance_paths, ["src/a.mjs"]);
  });
  it("fails closed when governance type has no trusted governance boundary", () => {
    const result = checkGovernanceChangeAuthorization({ files: [file("repo-policy.json")], governancePaths: [], changeIntentType: "governance" });
    assert.equal(result.ok, false); assert.deepEqual(result.non_governance_paths, ["repo-policy.json"]);
  });
});

describe("GovernanceGrant markdown", () => {
  it("extracts the independent grant block", () => {
    const result = extractGovernanceGrant("```repo-guard-grant\nauthorized_governance_paths:\n  - schemas/**\nallow_policy_relaxation:\n  - /size_rules/source/max\n```");
    assert.equal(result.ok, true); assert.deepEqual(result.grant.authorized_governance_paths, ["schemas/**"]);
  });
  it("does not infer grants from ChangeIntent", () => assert.equal(extractGovernanceGrant("```repo-guard-yaml\nchange_type: governance\n```").grant, null));
});

describe("governance authorization through pipeline", () => {
  const policy = {
    policy_format_version: "0.3.0", repository_kind: "tooling",
    paths: { forbidden: [], canonical_docs: ["README.md"], operational_paths: [], governance_paths: ["repo-policy.json", "schemas/"] },
    diff_rules: { max_new_docs: 5, max_new_files: 5, max_net_added_lines: 2000 },
    change_profiles: { feature: {} }, content_rules: [], cochange_rules: [],
  };
  const diff = (path) => ["diff --git a/" + path + " b/" + path, "--- a/" + path, "+++ b/" + path, "+x"].join("\n");
  function run({ path = "repo-policy.json", governanceGrant = null, trustedAuthorizer = null, trustedGovernancePaths = policy.paths.governance_paths, runtimePolicy = policy, changeIntent = null }) {
    const facts = buildPolicyFacts({ mode: "check-pr", repositoryRoot: "/tmp/repo-guard-governance-test", policy: runtimePolicy,
      changeIntent, changeIntentSource: changeIntent ? "test" : "none", governanceGrant, trustedGovernancePaths, trustedAuthorizer,
      enforcement: { mode: "blocking" }, diffText: diff(path), trackedFiles: [path, "README.md"] });
    const reporter = createAnalysisCollector({ mode: "blocking" });
    runPolicyChecks(facts, reporter, { registry: createDefaultRuleRegistry() });
    return reporter.finish({ command: "check-pr" });
  }
  it("blocks without grant", () => assert.ok(run({}).violations.some((item) => item.rule === "governance-change-authorization")));
  it("allows trusted grant", () => assert.equal(run({ governanceGrant: grant("repo-policy.json"), trustedAuthorizer: TRUSTED }).ruleResults.find((item) => item.rule === "governance-change-authorization").ok, true));
  it("blocks untrusted grant", () => assert.equal(run({ governanceGrant: grant("repo-policy.json"), trustedAuthorizer: UNTRUSTED }).violations.find((item) => item.rule === "governance-change-authorization").data.untrusted_governance_grant_ignored, true));
  it("delegates governance away from repository-specific change_profiles", () => {
    const result = run({ path: "repo-policy.json", governanceGrant: grant("repo-policy.json"), trustedAuthorizer: TRUSTED, changeIntent: intent("governance") });
    assert.equal(result.violations.some((item) => item.rule === "change-profiles"), false);
    assert.equal(result.ruleResults.find((item) => item.rule === "governance-change-authorization").ok, true);
  });
  it("blocks governance ChangeIntent outside trusted governance paths", () => {
    const result = run({ path: "src/a.mjs", governanceGrant: grant("repo-policy.json"), trustedAuthorizer: TRUSTED, changeIntent: intent("governance") });
    const violation = result.violations.find((item) => item.rule === "governance-change-authorization");
    assert.deepEqual(violation.data.non_governance_paths, ["src/a.mjs"]);
  });
  it("keeps ordinary unknown change types rejected by change_profiles", () => {
    const result = run({ path: "src/a.mjs", changeIntent: intent("unknown") });
    assert.equal(result.violations.some((item) => item.rule === "change-profiles"), true);
  });
  it("base governance boundary cannot be narrowed by head policy", () => {
    const narrowed = { ...policy, paths: { ...policy.paths, governance_paths: ["nonexistent.json"] } };
    assert.ok(run({ path: "schemas/repo-policy.schema.json", runtimePolicy: narrowed, trustedGovernancePaths: policy.paths.governance_paths }).violations.some((item) => item.rule === "governance-change-authorization"));
  });
  it("empty trusted boundary disables this check for ordinary changes", () => assert.equal(run({ trustedGovernancePaths: [] }).ruleResults.some((item) => item.rule === "governance-change-authorization"), false));
});
