import { strict as assert } from "node:assert";
import { normalizeGitHubControlPlane } from "../dist/parallel-control-plane.mjs";

const repository = "netkeep80/example";

function input(overrides = {}) {
  return {
    provider: "portable",
    repository,
    defaultBranch: "main",
    branchProtection: { complete: true, protected: false, data: null },
    activeBranchRules: { complete: true, rules: [] },
    rulesets: { complete: true, items: [] },
    ...overrides,
  };
}

function classicProtection({ bypass = false, duplicateChecks = false } = {}) {
  return {
    complete: true,
    protected: true,
    data: {
      required_status_checks: {
        strict: true,
        contexts: ["CI / validate", ...(duplicateChecks ? ["CI / validate"] : [])],
        checks: [{ context: "CI / smoke-pack", app_id: null }],
      },
      required_pull_request_reviews: {
        required_approving_review_count: 0,
        bypass_pull_request_allowances: {
          users: bypass ? [{ login: "release-bot" }] : [],
          teams: [],
          apps: [],
        },
      },
      enforce_admins: { enabled: true },
    },
  };
}

function rulesetEvidence({ mergeQueue = false, bypass = false } = {}) {
  return {
    activeBranchRules: {
      complete: true,
      rules: [
        { type: "pull_request", ruleset_id: 41 },
        {
          type: "required_status_checks",
          ruleset_id: 41,
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [
              { context: "CI / validate", integration_id: null },
              { context: "CI / smoke-pack", integration_id: null },
            ],
          },
        },
        ...(mergeQueue ? [{ type: "merge_queue", ruleset_id: 41 }] : []),
      ],
    },
    rulesets: {
      complete: true,
      items: [{ id: 41, enforcement: "active", bypass_actors: bypass ? [{ actor_id: 7, actor_type: "Integration", bypass_mode: "always" }] : [] }],
    },
  };
}

{
  const result = normalizeGitHubControlPlane(input());
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, {
    targetBranch: "main",
    requiredChecks: [],
    pullRequestRequired: false,
    requiredChecksEnforced: false,
    upToDateRequired: false,
    noBypass: false,
    mergeQueueEnabled: false,
  });
}

{
  const result = normalizeGitHubControlPlane(input({ branchProtection: classicProtection() }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, {
    targetBranch: "main",
    requiredChecks: ["CI / smoke-pack", "CI / validate"],
    pullRequestRequired: true,
    requiredChecksEnforced: true,
    upToDateRequired: true,
    noBypass: true,
    mergeQueueEnabled: false,
  });
}

{
  const rules = rulesetEvidence();
  const result = normalizeGitHubControlPlane(input({ branchProtection: { complete: true, protected: false, data: null }, ...rules }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, {
    targetBranch: "main",
    requiredChecks: ["CI / smoke-pack", "CI / validate"],
    pullRequestRequired: true,
    requiredChecksEnforced: true,
    upToDateRequired: true,
    noBypass: true,
    mergeQueueEnabled: false,
  });
}

{
  const rules = rulesetEvidence({ mergeQueue: true });
  const result = normalizeGitHubControlPlane(input({ provider: "github_merge_queue", ...rules }));
  assert.equal(result.ok, true);
  assert.equal(result.facts.mergeQueueEnabled, true);
}

{
  const rules = rulesetEvidence();
  const result = normalizeGitHubControlPlane(input({ provider: "github_merge_queue", ...rules }));
  assert.equal(result.ok, true);
  assert.equal(result.facts.mergeQueueEnabled, false);
}

{
  const result = normalizeGitHubControlPlane(input({ branchProtection: classicProtection({ bypass: true }) }));
  assert.equal(result.ok, true);
  assert.equal(result.facts.noBypass, false);
}

{
  const rules = rulesetEvidence({ bypass: true });
  const result = normalizeGitHubControlPlane(input({ ...rules }));
  assert.equal(result.ok, true);
  assert.equal(result.facts.noBypass, false);
}

{
  const result = normalizeGitHubControlPlane(input({
    branchProtection: { complete: false },
    activeBranchRules: { complete: false },
    rulesets: { complete: false },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, {
    targetBranch: "main",
    requiredChecks: null,
    pullRequestRequired: null,
    requiredChecksEnforced: null,
    upToDateRequired: null,
    noBypass: null,
    mergeQueueEnabled: null,
  });
}

{
  const result = normalizeGitHubControlPlane(input({ branchProtection: classicProtection({ duplicateChecks: true }) }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts.requiredChecks, ["CI / smoke-pack", "CI / validate"]);
}

{
  const result = normalizeGitHubControlPlane(input({
    branchProtection: classicProtection(),
    ...rulesetEvidence(),
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts.requiredChecks, ["CI / smoke-pack", "CI / validate"]);
  assert.equal(result.facts.pullRequestRequired, true);
  assert.equal(result.facts.upToDateRequired, true);
}

for (const malformed of [
  null,
  {},
  input({ provider: "legacy" }),
  input({ repository: "not-a-repository" }),
  input({ defaultBranch: 7 }),
  input({ branchProtection: { complete: true, protected: true } }),
  input({ activeBranchRules: { complete: true, rules: "bad" } }),
  input({ rulesets: { complete: true, items: "bad" } }),
]) {
  const result = normalizeGitHubControlPlane(malformed);
  assert.equal(result.ok, false, `malformed payload must fail: ${JSON.stringify(malformed)}`);
  assert.equal(typeof result.error, "string");
  assert.equal(typeof result.message, "string");
}

console.log("All parallel control-plane normalization tests passed");
