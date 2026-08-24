import { strict as assert } from "node:assert";
import { readGitHubControlPlane } from "../dist/github-control-plane.mjs";

function commandError(stderr, status = 1) {
  const error = new Error(stderr);
  error.status = status;
  error.stderr = stderr;
  return error;
}

function run(command, args) {
  assert.equal(command, "gh");
  assert.equal(args[0], "api");
  const endpoint = args[1];
  const fixtures = {
    "repos/netkeep80/example": {
      default_branch: "main",
      delete_branch_on_merge: false,
      owner: { type: "User" },
    },
    "repos/netkeep80/example/branches/main/protection": commandError("Branch not protected (HTTP 404)"),
    "repos/netkeep80/example/rules/branches/main": [[]],
  };
  const value = fixtures[endpoint];
  if (value instanceof Error) throw value;
  if (value === undefined) throw new Error(`unexpected gh api endpoint: ${endpoint}`);
  return JSON.stringify(value);
}

const result = readGitHubControlPlane({
  repoRoot: "/repo",
  provider: "portable",
  env: { GITHUB_REPOSITORY: "netkeep80/example" },
  run,
});

assert.equal(result.ok, true);
assert.equal(
  result.deleteBranchOnMerge,
  false,
  "repository delete_branch_on_merge=false must remain an explicit control-plane fact",
);

console.log("Branch hygiene repository-setting fact test passed");
