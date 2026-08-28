import { strict as assert } from "node:assert";
import { createGitHubWriteAdapter } from "../dist/portable-integration/github-write.mjs";

const REPO = "netkeep80/repo-guard";
const HEAD = "1111111111111111111111111111111111111111";

for (const branchName of [
  "",
  "../main",
  "/main",
  "main/",
  "feature//work",
  "feature\\work",
  "feature\u0000work",
]) {
  let calls = 0;
  const adapter = createGitHubWriteAdapter({
    request: async () => {
      calls += 1;
      return { status: 404, body: { message: "should not be called" } };
    },
  });
  const result = await adapter.deleteMergedBranchExact({
    repository: REPO,
    kind: "delete_merged_branch",
    branchName,
    prNumber: 42,
    expectedHeadSha: HEAD,
  });
  assert.equal(result.ok, false, `${JSON.stringify(branchName)} must fail before transport`);
  assert.equal(result.error, "invalid_input", `${JSON.stringify(branchName)} must be typed invalid input`);
  assert.equal(calls, 0, `${JSON.stringify(branchName)} must not reach transport`);
}

console.log("Branch hygiene write hardening tests passed");
