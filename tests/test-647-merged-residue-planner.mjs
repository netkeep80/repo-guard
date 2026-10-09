import assert from "node:assert/strict";
import {
  analyzeControlPlaneObservation,
  planMergedResidueDeletions,
} from "../dist/facts/control-plane.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const F = "f".repeat(40);

const graph = analyzeControlPlaneObservation({
  repository: "netkeep80/repo-guard",
  default_branch: "main",
  branches: [
    { name: "main", sha: A, protected: true },
    { name: "active", sha: B },
    { name: "merged-candidate", sha: C },
    { name: "protected-merged", sha: D, protected: true },
    { name: "release/keep", sha: E },
    { name: "closed-unmerged", sha: F },
  ],
  issues: [{ number: 518, state: "open", title: "[Roadmap] Root", body: "" }],
  pull_requests: [
    {
      number: 10,
      state: "open",
      body: "Part of #518",
      head: { ref: "active", sha: B, repo_full_name: "netkeep80/repo-guard" },
    },
    {
      number: 20,
      state: "closed",
      merged: true,
      body: "Part of #518",
      head: { ref: "merged-candidate", sha: C, repo_full_name: "netkeep80/repo-guard" },
    },
    {
      number: 21,
      state: "closed",
      merged: true,
      body: "Part of #518",
      head: { ref: "protected-merged", sha: D, repo_full_name: "netkeep80/repo-guard" },
    },
    {
      number: 22,
      state: "closed",
      merged: true,
      body: "Part of #518",
      head: { ref: "release/keep", sha: E, repo_full_name: "netkeep80/repo-guard" },
    },
    {
      number: 23,
      state: "closed",
      merged: false,
      body: "Part of #518",
      head: { ref: "closed-unmerged", sha: F, repo_full_name: "netkeep80/repo-guard" },
    },
  ],
  root_issue_number: 518,
});

const plan = planMergedResidueDeletions(graph, ["release/keep"]);
assert.equal(plan.contract, "plan_only");
assert.equal(plan.destructive_authority, false);
assert.deepEqual(plan.candidates, [{
  ref: "merged-candidate",
  expected_sha: C,
  merged_prs: [20],
}]);
assert.deepEqual(plan.excluded, [
  {
    ref: "protected-merged",
    expected_sha: D,
    merged_prs: [21],
    reasons: ["protected"],
  },
  {
    ref: "release/keep",
    expected_sha: E,
    merged_prs: [22],
    reasons: ["persistent"],
  },
]);
assert.equal(
  plan.candidates.some((item) => item.ref === "closed-unmerged"),
  false,
  "closed-unmerged PR residue must never enter merged-only P4 candidates",
);

// Defense-in-depth: even if a caller supplies a forged/stale derived residue,
// the planner rechecks default/active/protected/persistent and exact branch identity.
const forged = {
  ...graph,
  derived: {
    ...graph.derived,
    exact_merged_pr_head_residues: [
      ...graph.derived.exact_merged_pr_head_residues,
      { ref: "main", sha: A, prs: [90] },
      { ref: "active", sha: B, prs: [91] },
    ],
  },
};
const defended = planMergedResidueDeletions(forged, ["release/keep"]);
assert.deepEqual(
  defended.excluded.filter((item) => item.ref === "main")[0]?.reasons,
  ["default", "protected"],
);
assert.deepEqual(
  defended.excluded.filter((item) => item.ref === "active")[0]?.reasons,
  ["active_open_pr_head"],
);

assert.throws(
  () => planMergedResidueDeletions({
    ...graph,
    derived: {
      ...graph.derived,
      exact_merged_pr_head_residues: [{ ref: "merged-candidate", sha: "9".repeat(40), prs: [20] }],
    },
  }),
  /stale merged residue identity/,
);

console.log("#647 merged-residue deletion planner passed");
