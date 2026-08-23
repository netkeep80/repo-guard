import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../dist/repo-guard.mjs";

async function capture(run) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const code = await run();
    return { code, stdout: logs.join("\n"), stderr: errors.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("status CLI boundary", () => {
  it("keeps a behind portable PR ready without assigning branch refresh to the agent", async () => {
    const input = JSON.stringify({
      provider: "portable",
      configuration_status: "ready",
      pr: 123,
      base_sha: SHA_A,
      head_sha: SHA_B,
      branch_behind: true,
      merged: false,
      queued: false,
      integrating: false,
      merge_conflict: false,
      transaction_status: "success",
      state_status: "success",
    });

    const result = await capture(() => runCli(["status", "--input", input, "--format", "json"]));
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const status = JSON.parse(result.stdout);
    assert.equal(status.state, "ready_for_integration");
    assert.equal(status.next_action, "enqueue");
    assert.equal(status.provider, "portable");
    assert.equal(status.pr, 123);
    assert.equal(status.base_sha, SHA_A);
    assert.equal(status.head_sha, SHA_B);
    assert.equal(status.branch_behind, true);
    assert.equal(status.requires_agent_branch_update, false);
  });
});
