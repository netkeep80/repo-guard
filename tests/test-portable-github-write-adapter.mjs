import { strict as assert } from "node:assert";
import { createGitHubWriteAdapter } from "../dist/portable-integration/github-write.mjs";

let failures = 0;

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

async function run() {
  const REPO = "netkeep80/repo-guard";
  const HEAD = "1111111111111111111111111111111111111111";
  const MERGE = "2222222222222222222222222222222222222222";

  console.log("\n--- portable GitHub write adapter contract ---");

  {
    const calls = [];
    const adapter = createGitHubWriteAdapter({
      request: async (request) => {
        calls.push(request);
        return { status: 202, body: { message: "Updating pull request branch." } };
      },
    });

    const result = await adapter.updateBranch({
      repository: REPO,
      prNumber: 42,
      expectedHeadSha: HEAD,
    });

    expect("update-branch sends exactly one guarded mutation", calls.length, 1);
    expect("update-branch request is exact and minimal", calls[0], {
      method: "PUT",
      path: "/repos/netkeep80/repo-guard/pulls/42/update-branch",
      body: { expected_head_sha: HEAD },
    });
    expect("accepted update requires a fresh read", result, {
      ok: true,
      kind: "update_accepted",
      expectedHeadSha: HEAD,
      rereadRequired: true,
    });
    expect("accepted update never fabricates a new head", Object.hasOwn(result, "headSha"), false);
  }

  for (const [label, input] of [
    ["missing update SHA", { repository: "netkeep80/repo-guard", prNumber: 42 }],
    ["invalid update SHA", { repository: "netkeep80/repo-guard", prNumber: 42, expectedHeadSha: "main" }],
    ["invalid update repository", { repository: "repo-guard", prNumber: 42, expectedHeadSha: HEAD }],
    ["invalid update PR number", { repository: "netkeep80/repo-guard", prNumber: 0, expectedHeadSha: HEAD }],
  ]) {
    let called = false;
    const adapter = createGitHubWriteAdapter({
      request: async () => {
        called = true;
        return { status: 202, body: {} };
      },
    });
    const result = await adapter.updateBranch(input);
    expect(`${label} fails before transport`, called, false);
    expect(`${label} is typed invalid input`, result.error, "invalid_input");
  }

  for (const [status, error] of [
    [403, "forbidden"],
    [409, "conflict"],
    [422, "stale_head"],
    [500, "unexpected_response"],
  ]) {
    const adapter = createGitHubWriteAdapter({
      request: async () => ({ status, body: { message: `status ${status}` } }),
    });
    const result = await adapter.updateBranch({ repository: REPO, prNumber: 42, expectedHeadSha: HEAD });
    expect(`update status ${status} maps to ${error}`, result.error, error);
    expect(`update status ${status} is never success`, result.ok, false);
  }

  {
    let attempts = 0;
    const adapter = createGitHubWriteAdapter({
      request: async () => {
        attempts++;
        return { status: 422, body: { message: "head changed" } };
      },
    });
    await adapter.updateBranch({ repository: REPO, prNumber: 42, expectedHeadSha: HEAD });
    expect("update adapter performs no hidden retry loop", attempts, 1);
  }

  {
    const calls = [];
    const adapter = createGitHubWriteAdapter({
      request: async (request) => {
        calls.push(request);
        return {
          status: 200,
          body: { merged: true, sha: MERGE, message: "Pull Request successfully merged" },
        };
      },
    });

    const result = await adapter.mergeExactHead({
      repository: REPO,
      prNumber: 42,
      expectedHeadSha: HEAD,
      mergeMethod: "squash",
    });

    expect("merge sends exactly one guarded mutation", calls.length, 1);
    expect("merge request carries exact expected head and no bypass fields", calls[0], {
      method: "PUT",
      path: "/repos/netkeep80/repo-guard/pulls/42/merge",
      body: { sha: HEAD, merge_method: "squash" },
    });
    expect("successful merge exposes exact GitHub merge SHA", result, {
      ok: true,
      kind: "merged",
      expectedHeadSha: HEAD,
      mergeSha: MERGE,
      mergeMethod: "squash",
    });
  }

  for (const mergeMethod of ["merge", "squash", "rebase"]) {
    const calls = [];
    const adapter = createGitHubWriteAdapter({
      request: async (request) => {
        calls.push(request);
        return { status: 200, body: { merged: true, sha: MERGE } };
      },
    });
    const result = await adapter.mergeExactHead({ repository: REPO, prNumber: 1, expectedHeadSha: HEAD, mergeMethod });
    expect(`merge method ${mergeMethod} is allowed`, result.ok, true);
    expect(`merge method ${mergeMethod} is passed explicitly`, calls[0].body.merge_method, mergeMethod);
  }

  for (const [label, input] of [
    ["missing merge SHA", { repository: REPO, prNumber: 42, mergeMethod: "squash" }],
    ["invalid merge SHA", { repository: REPO, prNumber: 42, expectedHeadSha: "HEAD", mergeMethod: "squash" }],
    ["invalid merge repository", { repository: "repo", prNumber: 42, expectedHeadSha: HEAD, mergeMethod: "squash" }],
    ["invalid merge PR number", { repository: REPO, prNumber: -1, expectedHeadSha: HEAD, mergeMethod: "squash" }],
    ["invalid merge method", { repository: REPO, prNumber: 42, expectedHeadSha: HEAD, mergeMethod: "force" }],
  ]) {
    let called = false;
    const adapter = createGitHubWriteAdapter({
      request: async () => {
        called = true;
        return { status: 200, body: { merged: true, sha: MERGE } };
      },
    });
    const result = await adapter.mergeExactHead(input);
    expect(`${label} fails before transport`, called, false);
    expect(`${label} is typed invalid input`, result.error, "invalid_input");
  }

  for (const [status, error] of [
    [403, "forbidden"],
    [404, "not_found"],
    [405, "merge_not_allowed"],
    [409, "stale_head"],
    [422, "validation_failed"],
    [500, "unexpected_response"],
  ]) {
    const adapter = createGitHubWriteAdapter({
      request: async () => ({ status, body: { merged: false, message: `status ${status}` } }),
    });
    const result = await adapter.mergeExactHead({
      repository: REPO,
      prNumber: 42,
      expectedHeadSha: HEAD,
      mergeMethod: "squash",
    });
    expect(`merge status ${status} maps to ${error}`, result.error, error);
    expect(`merge status ${status} is never success`, result.ok, false);
  }

  {
    const adapter = createGitHubWriteAdapter({
      request: async () => ({ status: 200, body: { merged: false, sha: MERGE, message: "not merged" } }),
    });
    const result = await adapter.mergeExactHead({ repository: REPO, prNumber: 42, expectedHeadSha: HEAD, mergeMethod: "merge" });
    expect("HTTP 200 with merged=false is fail-closed", result.error, "merge_rejected");
    expect("HTTP 200 with merged=false is not success", result.ok, false);
  }

  for (const body of [
    { merged: true, sha: "bad" },
    { merged: true },
    { merged: "yes", sha: MERGE },
    null,
  ]) {
    const adapter = createGitHubWriteAdapter({
      request: async () => ({ status: 200, body }),
    });
    const result = await adapter.mergeExactHead({ repository: REPO, prNumber: 42, expectedHeadSha: HEAD, mergeMethod: "rebase" });
    expect(`malformed merge success payload ${JSON.stringify(body)} fails closed`, result.error, "malformed_response");
  }

  {
    let attempts = 0;
    const adapter = createGitHubWriteAdapter({
      request: async () => {
        attempts++;
        return { status: 409, body: { message: "head mismatch" } };
      },
    });
    await adapter.mergeExactHead({ repository: REPO, prNumber: 42, expectedHeadSha: HEAD, mergeMethod: "squash" });
    expect("merge adapter performs no hidden retry/fallback", attempts, 1);
  }

  {
    const calls = [];
    const adapter = createGitHubWriteAdapter({
      request: async (request) => {
        calls.push(request);
        if (request.method === "GET") {
          return {
            status: 200,
            body: { ref: "refs/heads/feature/work", object: { sha: HEAD, type: "commit" } },
          };
        }
        if (request.method === "DELETE") return { status: 204, body: null };
        throw new Error(`unexpected method ${request.method}`);
      },
    });
    const result = await adapter.deleteMergedBranchExact({
      repository: REPO,
      kind: "delete_merged_branch",
      branchName: "feature/work",
      prNumber: 42,
      expectedHeadSha: HEAD,
    });
    expect("merged branch deletion rereads exact ref before mutation", calls, [
      { method: "GET", path: "/repos/netkeep80/repo-guard/git/ref/heads/feature/work" },
      { method: "DELETE", path: "/repos/netkeep80/repo-guard/git/refs/heads/feature/work" },
    ]);
    expect("successful exact branch delete returns typed evidence", result, {
      ok: true,
      kind: "deleted",
      branchName: "feature/work",
      prNumber: 42,
      expectedHeadSha: HEAD,
    });
  }

  {
    const calls = [];
    const adapter = createGitHubWriteAdapter({
      request: async (request) => {
        calls.push(request);
        return {
          status: 200,
          body: { ref: "refs/heads/feature/work", object: { sha: MERGE, type: "commit" } },
        };
      },
    });
    const result = await adapter.deleteMergedBranchExact({
      repository: REPO,
      kind: "delete_merged_branch",
      branchName: "feature/work",
      prNumber: 42,
      expectedHeadSha: HEAD,
    });
    expect("moved branch is rejected as stale", result.error, "stale_head");
    expect("moved branch never reaches DELETE", calls, [
      { method: "GET", path: "/repos/netkeep80/repo-guard/git/ref/heads/feature/work" },
    ]);
  }

  {
    const calls = [];
    const adapter = createGitHubWriteAdapter({
      request: async (request) => {
        calls.push(request);
        return { status: 404, body: { message: "Reference does not exist" } };
      },
    });
    const result = await adapter.deleteMergedBranchExact({
      repository: REPO,
      kind: "delete_merged_branch",
      branchName: "feature/work",
      prNumber: 42,
      expectedHeadSha: HEAD,
    });
    expect("branch already absent at fresh reread is idempotent", result, {
      ok: true,
      kind: "already_absent",
      branchName: "feature/work",
      prNumber: 42,
      expectedHeadSha: HEAD,
    });
    expect("already absent branch never reaches DELETE", calls, [
      { method: "GET", path: "/repos/netkeep80/repo-guard/git/ref/heads/feature/work" },
    ]);
  }

  {
    const adapter = createGitHubWriteAdapter({
      request: async () => {
        throw new Error("network unavailable");
      },
    });
    const update = await adapter.updateBranch({ repository: REPO, prNumber: 42, expectedHeadSha: HEAD });
    const merge = await adapter.mergeExactHead({ repository: REPO, prNumber: 42, expectedHeadSha: HEAD, mergeMethod: "squash" });
    expect("update transport exception is typed", update.error, "transport_error");
    expect("merge transport exception is typed", merge.error, "transport_error");
  }

  {
    const adapter = createGitHubWriteAdapter({ request: null });
    const result = await adapter.updateBranch({ repository: REPO, prNumber: 42, expectedHeadSha: HEAD });
    expect("misconfigured transport fails closed", result.error, "invalid_transport");
  }

  console.log(`\n${failures === 0 ? "All portable GitHub write-adapter tests passed" : `${failures} test(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await run();
