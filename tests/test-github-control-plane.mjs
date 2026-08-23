import { strict as assert } from "node:assert";
import { readGitHubControlPlane } from "../dist/github-control-plane.mjs";

function commandError(stderr, status = 1) {
  const error = new Error(stderr);
  error.status = status;
  error.stderr = stderr;
  return error;
}

function fakeRunner(fixtures) {
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "git") {
      const value = fixtures.gitOrigin;
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected git call: ${args.join(" ")}`);
      return value;
    }
    assert.equal(command, "gh");
    assert.equal(args[0], "api", "control-plane adapter must use read-only gh api invocations");
    assert.equal(args.some((arg) => ["POST", "PUT", "PATCH", "DELETE"].includes(arg.toUpperCase())), false);
    const endpoint = args[1];
    const value = fixtures.api?.[endpoint];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected gh api endpoint: ${endpoint}`);
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  return { run, calls };
}

function read(fixtures, overrides = {}) {
  const fake = fakeRunner(fixtures);
  const result = readGitHubControlPlane({
    repoRoot: "/repo",
    provider: "portable",
    env: { GITHUB_REPOSITORY: "netkeep80/example" },
    run: fake.run,
    ...overrides,
  });
  return { result, calls: fake.calls };
}

{
  const { result, calls } = read({
    api: {
      "repos/netkeep80/example": { default_branch: "main" },
      "repos/netkeep80/example/branches/main/protection": commandError("Branch not protected (HTTP 404)"),
      "repos/netkeep80/example/rules/branches/main": [[]],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.repository, "netkeep80/example");
  assert.equal(result.defaultBranch, "main");
  assert.deepEqual(result.branchProtection, { complete: true, protected: false, data: null });
  assert.deepEqual(result.activeBranchRules, { complete: true, rules: [] });
  assert.deepEqual(result.rulesets, { complete: true, items: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(calls.every((call) => call.command === "gh"), true);
}

{
  const protection = {
    required_status_checks: { strict: true, contexts: ["CI / validate"], checks: [] },
    required_pull_request_reviews: { bypass_pull_request_allowances: { users: [], teams: [], apps: [] } },
    enforce_admins: { enabled: true },
  };
  const { result } = read({
    api: {
      "repos/netkeep80/example": { default_branch: "main" },
      "repos/netkeep80/example/branches/main/protection": protection,
      "repos/netkeep80/example/rules/branches/main": [[]],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.branchProtection, { complete: true, protected: true, data: protection });
}

{
  const activeRules = [
    { type: "pull_request", ruleset_id: 41 },
    {
      type: "required_status_checks",
      ruleset_id: 41,
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "CI / validate", integration_id: null }],
      },
    },
  ];
  const detail = { id: 41, enforcement: "active", bypass_actors: [] };
  const { result } = read({
    api: {
      "repos/netkeep80/example": { default_branch: "main" },
      "repos/netkeep80/example/branches/main/protection": commandError("Branch not protected (HTTP 404)"),
      "repos/netkeep80/example/rules/branches/main": [activeRules],
      "repos/netkeep80/example/rulesets/41": detail,
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.activeBranchRules, { complete: true, rules: activeRules });
  assert.deepEqual(result.rulesets, { complete: true, items: [detail] });
}

{
  const { result } = read({
    api: {
      "repos/netkeep80/example": { default_branch: "main" },
      "repos/netkeep80/example/branches/main/protection": commandError("Resource not accessible by integration (HTTP 403)"),
      "repos/netkeep80/example/rules/branches/main": commandError("Resource not accessible by integration (HTTP 403)"),
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.branchProtection, { complete: false, protected: null, data: null });
  assert.deepEqual(result.activeBranchRules, { complete: false, rules: null });
  assert.deepEqual(result.rulesets, { complete: false, items: null });
  assert.ok(result.errors.some((item) => item.id === "branch_protection_api_error"));
  assert.ok(result.errors.some((item) => item.id === "active_branch_rules_api_error"));
}

{
  const fake = fakeRunner({
    gitOrigin: "git@github.com:netkeep80/example.git\n",
    api: {
      "repos/netkeep80/example": { default_branch: "main" },
      "repos/netkeep80/example/branches/main/protection": commandError("Branch not protected (HTTP 404)"),
      "repos/netkeep80/example/rules/branches/main": [[]],
    },
  });
  const result = readGitHubControlPlane({ repoRoot: "/repo", provider: "portable", env: {}, run: fake.run });
  assert.equal(result.ok, true);
  assert.equal(result.repository, "netkeep80/example");
  assert.deepEqual(fake.calls[0], { command: "git", args: ["remote", "get-url", "origin"] });
}

console.log("All GitHub control-plane adapter tests passed");
