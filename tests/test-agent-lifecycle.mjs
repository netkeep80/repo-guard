import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../dist/repo-guard.mjs";
import {
  AGENT_LIFECYCLE_STATES,
  AGENT_NEXT_ACTIONS,
  projectAgentLifecycle,
} from "../dist/agent-lifecycle.mjs";

const BASE = {
  provider: "portable",
  configuration_status: "ready",
  pr: 42,
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  branch_behind: false,
  merged: false,
  queued: false,
  integrating: false,
  merge_conflict: false,
  transaction_status: "success",
  state_status: "success",
};

function project(overrides = {}) {
  return projectAgentLifecycle({ ...BASE, ...overrides });
}

function value(overrides = {}) {
  const result = project(overrides);
  assert.equal(result.ok, true);
  return result.value;
}

describe("provider-neutral agent lifecycle", () => {
  it("exposes status as an additive CLI command", () => {
    assert.equal(COMMANDS.includes("status"), true);
  });

  it("keeps lifecycle and next_action vocabularies finite and provider-neutral", () => {
    assert.deepEqual(AGENT_LIFECYCLE_STATES, [
      "fix_pr",
      "ready_for_integration",
      "queued",
      "integrating",
      "blocked_ci",
      "fix_conflict",
      "misconfigured",
      "merged",
    ]);
    assert.deepEqual(AGENT_NEXT_ACTIONS, [
      "fix_pr",
      "enqueue",
      "wait",
      "inspect_failure",
      "configure_repository",
      "none",
    ]);
  });

  it("keeps a behind portable PR ready without assigning freshness work to the agent", () => {
    const status = value({ branch_behind: true });
    assert.equal(status.protocol, "parallel");
    assert.equal(status.state, "ready_for_integration");
    assert.equal(status.next_action, "enqueue");
    assert.equal(status.requires_agent_branch_update, false);
    assert.equal(status.base_sha, BASE.base_sha);
    assert.equal(status.head_sha, BASE.head_sha);
  });

  it("projects the native merge queue into the same high-level ready state", () => {
    const status = value({ provider: "github_merge_queue", branch_behind: true });
    assert.equal(status.protocol, "parallel");
    assert.equal(status.state, "ready_for_integration");
    assert.equal(status.next_action, "enqueue");
    assert.equal(status.requires_agent_branch_update, false);
  });

  it("maps transaction and state failures to distinct actionable states", () => {
    const transactionFailure = value({ transaction_status: "failure" });
    assert.equal(transactionFailure.state, "fix_pr");
    assert.equal(transactionFailure.next_action, "fix_pr");

    const stateFailure = value({ state_status: "failure" });
    assert.equal(stateFailure.state, "blocked_ci");
    assert.equal(stateFailure.next_action, "inspect_failure");
  });

  it("maps merge conflicts to agent repair rather than freshness work", () => {
    const status = value({ merge_conflict: true, branch_behind: true });
    assert.equal(status.state, "fix_conflict");
    assert.equal(status.next_action, "fix_pr");
    assert.equal(status.requires_agent_branch_update, false);
  });

  it("maps queued and integrating candidates to wait", () => {
    const queued = value({ queued: true });
    assert.equal(queued.state, "queued");
    assert.equal(queued.next_action, "wait");

    const integrating = value({ integrating: true });
    assert.equal(integrating.state, "integrating");
    assert.equal(integrating.next_action, "wait");
  });

  it("keeps pending and missing gate evidence non-ready", () => {
    const pending = value({ state_status: "pending" });
    assert.equal(pending.state, "blocked_ci");
    assert.equal(pending.next_action, "wait");

    const missing = value({ transaction_status: "missing" });
    assert.equal(missing.state, "blocked_ci");
    assert.equal(missing.next_action, "inspect_failure");
  });

  it("maps invalid or unknown repository configuration to configuration work", () => {
    for (const configuration_status of ["misconfigured", "unknown"]) {
      const status = value({ configuration_status });
      assert.equal(status.state, "misconfigured");
      assert.equal(status.next_action, "configure_repository");
    }
  });

  it("maps merged PRs to the terminal state", () => {
    const status = value({ merged: true });
    assert.equal(status.state, "merged");
    assert.equal(status.next_action, "none");
  });

  it("preserves legacy freshness diagnostics without changing parallel semantics", () => {
    const status = value({ provider: "legacy", branch_behind: true });
    assert.equal(status.protocol, "legacy");
    assert.equal(status.state, "fix_pr");
    assert.equal(status.next_action, "fix_pr");
    assert.equal(status.requires_agent_branch_update, true);
  });

  it("fails closed for malformed or incomplete provider facts", () => {
    for (const input of [
      { ...BASE, provider: "unknown-provider" },
      { ...BASE, head_sha: undefined },
      { ...BASE, base_sha: "short" },
      { ...BASE, transaction_status: "unknown" },
    ]) {
      const result = projectAgentLifecycle(input);
      assert.equal(result.ok, false);
      assert.equal(result.error, "malformed_lifecycle_facts");
    }
  });

  it("is deterministic for the same normalized fact snapshot", () => {
    const input = { ...BASE, provider: "github_merge_queue", branch_behind: true };
    assert.deepEqual(projectAgentLifecycle(input), projectAgentLifecycle(input));
  });
});
