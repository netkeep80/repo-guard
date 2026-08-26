import { strict as assert } from "node:assert";
import { readGitHubControlPlane } from "../dist/github-control-plane.mjs";

const MAIN = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const FORK = "3333333333333333333333333333333333333333";
const MERGED = "4444444444444444444444444444444444444444";

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
    "repos/netkeep80/example/branches?per_page=100": [
      [{ name: "main", commit: { sha: MAIN }, protected: true }],
      [{ name: "feature/work", commit: { sha: HEAD }, protected: false }],
    ],
    "repos/netkeep80/example/pulls?state=open&per_page=100": [
      [{
        number: 7,
        head: {
          ref: "feature/work",
          sha: HEAD,
          repo: { full_name: "netkeep80/example" },
        },
      }],
      [{
        number: 8,
        head: {
          ref: "fork-work",
          sha: FORK,
          repo: { full_name: "contributor/example" },
        },
      }],
    ],
    "repos/netkeep80/example/pulls?state=closed&per_page=100": [
      [{
        number: 6,
        merged_at: "2026-08-01T00:00:00Z",
        head: {
          ref: "feature/merged",
          sha: MERGED,
          repo: { full_name: "netkeep80/example" },
        },
      }, {
        number: 9,
        merged_at: null,
        head: {
          ref: "feature/closed-unmerged",
          sha: HEAD,
          repo: { full_name: "netkeep80/example" },
        },
      }],
      [{
        number: 10,
        merged_at: "2026-08-02T00:00:00Z",
        head: {
          ref: "fork-merged",
          sha: FORK,
          repo: { full_name: "contributor/example" },
        },
      }],
    ],
  };
  if (endpoint === "repos/netkeep80/example/branches?per_page=100"
    || endpoint === "repos/netkeep80/example/pulls?state=open&per_page=100"
    || endpoint === "repos/netkeep80/example/pulls?state=closed&per_page=100") {
    assert.equal(args.includes("--paginate"), true, `${endpoint} must request every page`);
    assert.equal(args.includes("--slurp"), true, `${endpoint} must preserve pagination completeness`);
  }
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
  includeBranchHygiene: true,
});

assert.equal(result.ok, true);
assert.equal(
  result.deleteBranchOnMerge,
  false,
  "repository delete_branch_on_merge=false must remain an explicit control-plane fact",
);
assert.deepEqual(result.branchInventory, {
  complete: true,
  items: [
    { name: "main", sha: MAIN, protected: true },
    { name: "feature/work", sha: HEAD, protected: false },
  ],
});
assert.deepEqual(result.openSameRepositoryPullRequestHeads, {
  complete: true,
  items: [
    { number: 7, name: "feature/work", sha: HEAD },
  ],
}, "fork PR heads must not become ownership facts for branches in the base repository");
assert.deepEqual(result.mergedSameRepositoryPullRequestHeads, {
  complete: true,
  items: [
    { number: 6, name: "feature/merged", sha: MERGED },
  ],
}, "only merged same-repository PR heads may become merged-residue evidence");

console.log("Branch hygiene control-plane fact tests passed");
