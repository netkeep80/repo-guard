import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  checkPolicyRelaxation,
  classifyChangedFiles,
  computePolicyDelta,
  policyRelaxationRuleFamily,
} from "../src/checks/rules/policy-delta-rules.mjs";

function file(path, { status = "modified", addedLines = [], deletedLines = [] } = {}) {
  return { path, status, addedLines, deletedLines };
}

const TRUSTED_AUTHORIZER = {
  issue_author_permission_trusted: true,
  governance_approved_label: false,
  codeowner_approved: false,
  trusted_team_approval: false,
};

const UNTRUSTED_AUTHORIZER = {
  issue_author_permission_trusted: false,
  governance_approved_label: false,
  codeowner_approved: false,
  trusted_team_approval: false,
};

const BASE_POLICY = {
  enforcement: { mode: "blocking" },
  paths: {
    forbidden: ["secrets/**"],
    governance_paths: ["repo-policy.json", "schemas/"],
  },
  diff_rules: {
    max_new_files: 5,
    max_new_docs: 2,
    max_net_added_lines: 50,
  },
  size_rules: [
    { id: "max-source", glob: "src/**/*.mjs", metric: "lines", max: 500, level: "blocking", count: "all_tracked" },
    { id: "max-doc", glob: "docs/**/*.md", metric: "lines", max: 300, level: "blocking", count: "all_tracked" },
  ],
  surfaces: {
    source: ["src/**"],
    tests: ["tests/**"],
    schemas: ["schemas/**"],
    docs: ["docs/**"],
  },
  integration: {
    workflows: [
      {
        id: "ci-pr-policy-check",
        role: "repo_guard_pr_gate",
        path: ".github/workflows/ci.yml",
        expect: { enforcement: "blocking" },
      },
    ],
  },
};

function withClone(policy, mutator) {
  const copy = JSON.parse(JSON.stringify(policy));
  mutator(copy);
  return copy;
}

describe("computePolicyDelta detects relaxations", () => {
  it("returns no relaxations for identical policies", () => {
    const { relaxations } = computePolicyDelta(BASE_POLICY, BASE_POLICY);
    assert.equal(relaxations.length, 0);
  });

  it("detects size_rules[*].max increase", () => {
    const head = withClone(BASE_POLICY, (p) => { p.size_rules[0].max = 1000; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "size_rule_max_increased");
    assert.equal(relaxations[0].pointer, "/size_rules/max-source/max");
    assert.equal(relaxations[0].before, 500);
    assert.equal(relaxations[0].after, 1000);
  });

  it("detects size_rules[*].level weakening blocking -> advisory", () => {
    const head = withClone(BASE_POLICY, (p) => { p.size_rules[0].level = "advisory"; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "size_rule_level_weakened");
    assert.equal(relaxations[0].before, "blocking");
    assert.equal(relaxations[0].after, "advisory");
  });

  it("detects size_rules[*].count weakening all_tracked -> changed_only", () => {
    const head = withClone(BASE_POLICY, (p) => { p.size_rules[0].count = "changed_only"; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "size_rule_count_weakened");
  });

  it("detects size_rules entry removal", () => {
    const head = withClone(BASE_POLICY, (p) => { p.size_rules = [p.size_rules[1]]; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "size_rule_removed");
    assert.equal(relaxations[0].rule_id, "max-source");
    assert.equal(relaxations[0].pointer, "/size_rules/max-source");
  });

  it("detects diff_rules budget increase (max_net_added_lines)", () => {
    const head = withClone(BASE_POLICY, (p) => { p.diff_rules.max_net_added_lines = 100; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "diff_rule_budget_increased");
    assert.equal(relaxations[0].field, "max_net_added_lines");
    assert.equal(relaxations[0].before, 50);
    assert.equal(relaxations[0].after, 100);
  });

  it("detects diff_rules budget increase (max_new_files)", () => {
    const head = withClone(BASE_POLICY, (p) => { p.diff_rules.max_new_files = 20; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "diff_rule_budget_increased");
    assert.equal(relaxations[0].field, "max_new_files");
  });

  it("ignores diff_rules budget decrease (tightening, not relaxing)", () => {
    const head = withClone(BASE_POLICY, (p) => { p.diff_rules.max_net_added_lines = 10; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 0);
  });

  it("detects paths.forbidden removal", () => {
    const head = withClone(BASE_POLICY, (p) => { p.paths.forbidden = []; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "forbidden_path_removed");
    assert.equal(relaxations[0].pattern, "secrets/**");
  });

  it("detects paths.governance_paths removal", () => {
    const head = withClone(BASE_POLICY, (p) => { p.paths.governance_paths = ["repo-policy.json"]; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "governance_path_removed");
    assert.equal(relaxations[0].pattern, "schemas/");
  });

  it("detects integration workflow removal", () => {
    const head = withClone(BASE_POLICY, (p) => { p.integration.workflows = []; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "integration_workflow_removed");
  });

  it("detects integration workflow expectation weakening", () => {
    const head = withClone(BASE_POLICY, (p) => {
      p.integration.workflows[0].expect.enforcement = "advisory";
    });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "integration_workflow_expectation_weakened");
  });

  it("detects enforcement.mode weakening blocking -> advisory", () => {
    const head = withClone(BASE_POLICY, (p) => { p.enforcement.mode = "advisory"; });
    const { relaxations } = computePolicyDelta(BASE_POLICY, head);
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0].kind, "enforcement_weakened");
  });

  it("reports zero relaxations when basePolicy or headPolicy is missing", () => {
    assert.deepEqual(computePolicyDelta(null, BASE_POLICY), { relaxations: [] });
    assert.deepEqual(computePolicyDelta(BASE_POLICY, null), { relaxations: [] });
  });
});

describe("classifyChangedFiles separates governance from product surfaces", () => {
  it("classifies repo-policy.json as governance even without explicit governance_paths", () => {
    const result = classifyChangedFiles([file("repo-policy.json")], { surfaces: BASE_POLICY.surfaces });
    assert.deepEqual(result.governanceFiles, ["repo-policy.json"]);
    assert.deepEqual(result.protectedFiles, []);
    assert.deepEqual(result.otherFiles, []);
  });

  it("classifies governance_paths entries as governance", () => {
    const result = classifyChangedFiles([file("schemas/repo-policy.schema.json")], BASE_POLICY);
    assert.deepEqual(result.governanceFiles, ["schemas/repo-policy.schema.json"]);
  });

  it("classifies source files as protected by default", () => {
    const result = classifyChangedFiles([file("src/checks/rules/foo.mjs")], BASE_POLICY);
    assert.deepEqual(result.protectedFiles, ["src/checks/rules/foo.mjs"]);
  });

  it("classifies tests files as protected by default", () => {
    const result = classifyChangedFiles([file("tests/test-foo.mjs")], BASE_POLICY);
    assert.deepEqual(result.protectedFiles, ["tests/test-foo.mjs"]);
  });

  it("classifies schemas files as governance (since they are in governance_paths)", () => {
    const result = classifyChangedFiles([file("schemas/change-contract.schema.json")], BASE_POLICY);
    assert.deepEqual(result.governanceFiles, ["schemas/change-contract.schema.json"]);
  });

  it("classifies docs files as other (not protected) by default", () => {
    const result = classifyChangedFiles([file("docs/notes.md")], BASE_POLICY);
    assert.deepEqual(result.otherFiles, ["docs/notes.md"]);
  });

  it("honors configured protected surfaces", () => {
    const result = classifyChangedFiles(
      [file("docs/notes.md"), file("src/feature.mjs")],
      BASE_POLICY,
      ["docs"]
    );
    assert.deepEqual(result.protectedFiles, ["docs/notes.md"]);
    assert.deepEqual(result.otherFiles, ["src/feature.mjs"]);
  });
});

describe("checkPolicyRelaxation enforces trusted authorization and governance-only PRs", () => {
  function relaxHeadByMaxIncrease(amount = 1000) {
    return withClone(BASE_POLICY, (p) => { p.size_rules[0].max = amount; });
  }

  it("passes when there are no relaxations even without authorization", () => {
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: BASE_POLICY,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: null,
      issueAuthorization: null,
      contractChangeType: null,
    });
    assert.equal(result.ok, true);
  });

  it("blocks size_rules max increase without any authorization", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: null,
      issueAuthorization: null,
      contractChangeType: null,
    });
    assert.equal(result.ok, false);
    assert.ok(result.policy_relaxations.length === 1);
    assert.ok(result.blocked_reasons.includes("no_trusted_authorization_source")
      || result.blocked_reasons.includes("trusted_authorizer_missing"));
    assert.ok(result.blocked_reasons.includes("linked_issue_missing_allow_policy_relaxation")
      || result.blocked_reasons.includes("no_linked_issue_authorization"));
  });

  it("blocks size_rules max increase when authorizer is untrusted (bot author, no label, no codeowner)", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: UNTRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("no_trusted_authorization_source"));
  });

  it("blocks when the linked-issue does not list the relaxed pointer", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/diff_rules/max_new_files"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("linked_issue_allow_policy_relaxation_does_not_cover_all_pointers"));
  });

  it("blocks when a relaxation is combined with a protected-surface change (source code)", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json"), file("src/feature.mjs", { addedLines: ["x"] })],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
    assert.deepEqual(result.protected_files, ["src/feature.mjs"]);
  });

  it("blocks when contract change_type is not governance", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contractChangeType: "feature",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("contract_change_type_is_not_governance"));
  });

  it("allows trusted governance-only relaxation when every channel lines up", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.governance_only, true);
  });

  it("allows trusted governance-only relaxation when issue authorization uses a parent pointer", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, true);
  });

  it("accepts authorization via governance-approved label", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: { ...UNTRUSTED_AUTHORIZER, governance_approved_label: true },
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, true);
  });

  it("accepts authorization via CODEOWNERS approval", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: { ...UNTRUSTED_AUTHORIZER, codeowner_approved: true },
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, true);
  });

  it("accepts authorization via trusted team approval", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: { ...UNTRUSTED_AUTHORIZER, trusted_team_approval: true },
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, true);
  });

  it("blocks when authorization comes from PR body only (allow_policy_relaxation in contract, not issueAuthorization)", () => {
    const head = relaxHeadByMaxIncrease();
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: null,
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("no_linked_issue_authorization"));
  });

  it("blocks size_rules level weakening combined with source change (acceptance: blocking -> advisory + kernel)", () => {
    const head = withClone(BASE_POLICY, (p) => { p.size_rules[0].level = "advisory"; });
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json"), file("src/big-file.mjs", { addedLines: Array(700).fill("// line") })],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/level"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("blocks size_rules removal combined with source change", () => {
    const head = withClone(BASE_POLICY, (p) => { p.size_rules = [p.size_rules[1]]; });
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json"), file("src/foo.mjs", { addedLines: ["x"] })],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("blocks diff_rules budget increase combined with non-governance change", () => {
    const head = withClone(BASE_POLICY, (p) => { p.diff_rules.max_net_added_lines = 5000; });
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json"), file("src/feature.mjs", { addedLines: Array(4000).fill("x") })],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/diff_rules/max_net_added_lines"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("blocks size_rules count weakening when it is combined with a source change", () => {
    const head = withClone(BASE_POLICY, (p) => { p.size_rules[0].count = "changed_only"; });
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json"), file("src/foo.mjs", { addedLines: ["x"] })],
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/count"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });

  it("treats bot-authored linked-issue authorization as untrusted (mirrors trusted-authorizer isBotUser)", () => {
    const head = relaxHeadByMaxIncrease();
    const botSummary = {
      issue_author_permission_trusted: false,
      governance_approved_label: false,
      codeowner_approved: false,
      trusted_team_approval: false,
      issue_author_is_bot: true,
    };
    const result = checkPolicyRelaxation({
      basePolicy: BASE_POLICY,
      headPolicy: head,
      changedFiles: [file("repo-policy.json")],
      trustedAuthorizer: botSummary,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contractChangeType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("no_trusted_authorization_source"));
  });
});

describe("policyRelaxationRuleFamily integrates with the rule registry", () => {
  it("has id 'policy-delta'", () => {
    assert.equal(policyRelaxationRuleFamily.id, "policy-delta");
  });

  it("applies() returns false when basePolicy or headPolicy is missing", () => {
    assert.equal(policyRelaxationRuleFamily.applies({}), false);
    assert.equal(policyRelaxationRuleFamily.applies({ basePolicy: BASE_POLICY }), false);
    assert.equal(policyRelaxationRuleFamily.applies({ headPolicy: BASE_POLICY }), false);
  });

  it("applies() returns true when both basePolicy and headPolicy are present", () => {
    assert.equal(
      policyRelaxationRuleFamily.applies({ basePolicy: BASE_POLICY, headPolicy: BASE_POLICY }),
      true
    );
  });

  it("evaluate() emits 'policy-relaxation' check entry", () => {
    const head = JSON.parse(JSON.stringify(BASE_POLICY));
    head.size_rules[0].max = 9999;
    const facts = {
      basePolicy: BASE_POLICY,
      headPolicy: head,
      diff: { files: { checked: [file("repo-policy.json")] } },
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contract: { change_type: "governance" },
    };
    const entries = [].concat(policyRelaxationRuleFamily.evaluate(facts));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "policy-relaxation");
    assert.equal(entries[0].check.ok, true);
  });

  it("evaluate() returns a failing 'policy-relaxation' entry when relaxation is mixed with kernel change", () => {
    const head = JSON.parse(JSON.stringify(BASE_POLICY));
    head.size_rules[0].max = 9999;
    const facts = {
      basePolicy: BASE_POLICY,
      headPolicy: head,
      diff: { files: { checked: [file("repo-policy.json"), file("src/feature.mjs", { addedLines: ["x"] })] } },
      trustedAuthorizer: TRUSTED_AUTHORIZER,
      issueAuthorization: { allow_policy_relaxation: ["/size_rules/max-source/max"] },
      contract: { change_type: "governance" },
    };
    const entry = policyRelaxationRuleFamily.evaluate(facts);
    assert.equal(entry.check.ok, false);
    assert.ok(entry.check.blocked_reasons.includes("policy_relaxation_mixed_with_non_governance_changes"));
  });
});
