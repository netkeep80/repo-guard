import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkGovernanceChangeAuthorization } from "../src/checks/rules/governance-paths.mjs";
import { createDefaultRuleRegistry } from "../src/checks/default-rule-families.mjs";
import { buildPolicyFacts } from "../src/facts/input.mjs";
import { runPolicyChecks } from "../src/checks/orchestrator.mjs";
import { createAnalysisCollector } from "../src/runtime/analysis-report.mjs";
import { extractGovernanceGrant } from "../src/change-intent.mjs";

const PATHS = ["repo-policy.json", "schemas/", ".github/workflows/", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/", "templates/", "action.yml"];
const TRUSTED = { issue_author_permission_trusted: true, governance_approved_label: false, codeowner_approved: false, trusted_team_approval: false };
const UNTRUSTED = { issue_author_permission_trusted: false, governance_approved_label: false, codeowner_approved: false, trusted_team_approval: false };
const file = (path) => ({ path, status: "modified", addedLines: ["+"], deletedLines: [] });
const grant = (...paths) => ({ authorized_governance_paths: paths });

describe("GovernanceGrant authorization", () => {
  it("passes when governance is untouched", () => assert.equal(checkGovernanceChangeAuthorization({ files: [file("src/a.mjs")], governancePaths: PATHS }).ok, true));
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
  it("is a no-op for empty trusted boundary", () => assert.equal(checkGovernanceChangeAuthorization({ files: [file("repo-policy.json")], governancePaths: [] }).ok, true));
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
    diff_rules: { max_new_docs: 5, max_new_files: 5, max_net_added_lines: 2000 }, content_rules: [], cochange_rules: [],
  };
  const diff = (path) => ["diff --git a/" + path + " b/" + path, "--- a/" + path, "+++ b/" + path, "+x"].join("\n");
  function run({ path = "repo-policy.json", governanceGrant = null, trustedAuthorizer = null, trustedGovernancePaths = policy.paths.governance_paths, runtimePolicy = policy }) {
    const facts = buildPolicyFacts({ mode: "check-pr", repositoryRoot: "/tmp/repo-guard-governance-test", policy: runtimePolicy,
      changeIntent: null, changeIntentSource: "none", governanceGrant, trustedGovernancePaths, trustedAuthorizer,
      enforcement: { mode: "blocking" }, diffText: diff(path), trackedFiles: [path, "README.md"] });
    const reporter = createAnalysisCollector({ mode: "blocking" });
    runPolicyChecks(facts, reporter, { registry: createDefaultRuleRegistry() });
    return reporter.finish({ command: "check-pr" });
  }
  it("blocks without grant", () => assert.ok(run({}).violations.some((item) => item.rule === "governance-change-authorization")));
  it("allows trusted grant", () => assert.equal(run({ governanceGrant: grant("repo-policy.json"), trustedAuthorizer: TRUSTED }).ruleResults.find((item) => item.rule === "governance-change-authorization").ok, true));
  it("blocks untrusted grant", () => assert.equal(run({ governanceGrant: grant("repo-policy.json"), trustedAuthorizer: UNTRUSTED }).violations.find((item) => item.rule === "governance-change-authorization").data.untrusted_governance_grant_ignored, true));
  it("base governance boundary cannot be narrowed by head policy", () => {
    const narrowed = { ...policy, paths: { ...policy.paths, governance_paths: ["nonexistent.json"] } };
    assert.ok(run({ path: "schemas/repo-policy.schema.json", runtimePolicy: narrowed, trustedGovernancePaths: policy.paths.governance_paths }).violations.some((item) => item.rule === "governance-change-authorization"));
  });
  it("empty trusted boundary disables this check", () => assert.equal(run({ trustedGovernancePaths: [] }).ruleResults.some((item) => item.rule === "governance-change-authorization"), false));
});
