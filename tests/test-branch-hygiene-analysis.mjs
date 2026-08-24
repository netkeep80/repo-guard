import { strict as assert } from "node:assert";
import * as branchHygiene from "../dist/branch-hygiene.mjs";

const { analyzeBranchHygiene } = branchHygiene;
const sha = (digit) => digit.repeat(40);
const MAIN = sha("1");
const PAGES = sha("2");
const RELEASE = sha("3");
const OPEN = sha("4");
const OWNED = sha("5");
const HANDOFF = sha("6");
const STALE = sha("7");
const MERGED = sha("8");
const ORPHAN = sha("9");

const branch = (name, value, protectedBranch = false) => ({ name, sha: value, protected: protectedBranch });

const input = {
  defaultBranch: "main",
  deleteBranchOnMerge: false,
  branchInventory: {
    complete: true,
    items: [
      branch("main", MAIN, true),
      branch("gh-pages", PAGES),
      branch("release/stable", RELEASE),
      branch("feature/open", OPEN),
      branch("feature/owned", OWNED),
      branch("feature/handoff", HANDOFF),
      branch("feature/stale", STALE),
      branch("feature/merged", MERGED),
      branch("feature/orphan", ORPHAN),
    ],
  },
  openSameRepositoryPullRequestHeads: {
    complete: true,
    items: [{ number: 11, name: "feature/open", sha: OPEN }],
  },
  persistentBranches: ["gh-pages", "release/stable"],
  durableOwnership: {
    complete: true,
    items: [
      { name: "feature/owned", sha: OWNED, state: "live" },
      { name: "feature/handoff", sha: HANDOFF, state: "handoff" },
      { name: "feature/stale", sha: STALE, state: "stale_candidate" },
    ],
  },
  mergedSameRepositoryPullRequestHeads: {
    complete: true,
    items: [{ number: 10, name: "feature/merged", sha: MERGED }],
  },
};

const result = analyzeBranchHygiene(input);
assert.equal(result.ok, true);
assert.deepEqual(result.persistentBranches.map((item) => item.name).sort(), ["gh-pages", "main", "release/stable"]);
assert.deepEqual(result.activePullRequestHeads.map((item) => item.name), ["feature/open"]);
assert.deepEqual(result.ownedPrePullRequestBranches.map((item) => [item.name, item.state]).sort(), [
  ["feature/handoff", "handoff"],
  ["feature/owned", "live"],
]);
assert.deepEqual(result.staleOwnershipBranches.map((item) => item.name), ["feature/stale"]);
assert.deepEqual(result.orphanCandidates.map((item) => item.name).sort(), ["feature/merged", "feature/orphan"]);
assert.deepEqual(result.mergedPullRequestHeadsStillPresent, [
  { number: 10, name: "feature/merged", sha: MERGED },
]);
assert.deepEqual(result.deleteBranchOnMergeDrift, {
  state: "disabled",
  residualMergedBranchCount: 1,
});
assert.equal(Object.hasOwn(result, "deletePlan"), false, "classification must never manufacture deletion authority");

const incompleteOwnership = analyzeBranchHygiene({
  ...input,
  durableOwnership: { complete: false, items: null },
});
assert.equal(incompleteOwnership.ok, false);
assert.equal(incompleteOwnership.error, "incomplete_branch_hygiene_facts");

const missingDefault = analyzeBranchHygiene({
  ...input,
  branchInventory: {
    complete: true,
    items: input.branchInventory.items.filter((item) => item.name !== "main"),
  },
});
assert.equal(missingDefault.ok, false);
assert.equal(missingDefault.error, "default_branch_missing");

assert.equal(
  typeof branchHygiene.planMergedBranchDeletion,
  "function",
  "merged branch cleanup requires an explicit planner before any mutation",
);
const deletionPlan = branchHygiene.planMergedBranchDeletion?.({
  facts: input,
  branchName: "feature/merged",
  prNumber: 10,
  expectedHeadSha: MERGED,
  rereadBranch: { name: "feature/merged", sha: MERGED },
});
assert.deepEqual(deletionPlan, {
  ok: true,
  kind: "delete_merged_branch",
  branchName: "feature/merged",
  prNumber: 10,
  expectedHeadSha: MERGED,
});

const alreadyAbsentPlan = branchHygiene.planMergedBranchDeletion?.({
  facts: input,
  branchName: "feature/merged",
  prNumber: 10,
  expectedHeadSha: MERGED,
  rereadBranch: null,
});
assert.deepEqual(alreadyAbsentPlan, {
  ok: true,
  kind: "already_absent",
  branchName: "feature/merged",
  prNumber: 10,
  expectedHeadSha: MERGED,
});

console.log("Branch hygiene analysis tests passed");
