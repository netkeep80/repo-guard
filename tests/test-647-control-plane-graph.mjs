import assert from "node:assert/strict";
import { analyzeControlPlaneObservation } from "../dist/facts/control-plane.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const F = "f".repeat(40);
const G = "1".repeat(40);
const H = "2".repeat(40);

function selfHostFixture() {
  return {
    repository: "netkeep80/repo-guard",
    default_branch: "main",
    delete_branch_on_merge: false,
    root_issue_number: 518,
    branches: [
      { name: "main", sha: A, protected: true },
      { name: "research/644-relation-transition-falsifier", sha: B },
      { name: "tmp-do-not-use", sha: C },
      { name: "release/legacy", sha: D, protected: true },
      { name: "moved-head", sha: G },
      { name: "feature/no-owner", sha: H },
    ],
    issues: [
      { number: 518, state: "open", title: "[Roadmap] Product constitution", body: "" },
      { number: 589, state: "open", title: "Semantic evidence", body: "Part of #518." },
      { number: 608, state: "open", title: "MDDB", body: "Parent roadmap: #518" },
      { number: 622, state: "open", title: "Projection API", body: "Related:\n- #608\n" },
      { number: 644, state: "open", title: "Requirement transitions", body: "Родительский roadmap: #518" },
      { number: 647, state: "open", title: "Control-plane hygiene", body: "Родительский roadmap: #518" },
      { number: 999, state: "open", title: "Detached research", body: "No explicit parent relation." },
    ],
    pull_requests: [
      {
        number: 646,
        state: "open",
        draft: true,
        body: "Part of #644",
        head: {
          ref: "research/644-relation-transition-falsifier",
          sha: B,
          repo_full_name: "netkeep80/repo-guard",
        },
      },
      {
        number: 648,
        state: "open",
        body: "Part of #647",
        head: {
          ref: "fork/feature",
          sha: E,
          repo_full_name: "someone/fork",
        },
      },
      {
        number: 649,
        state: "open",
        body: "Part of #647",
        head: {
          ref: "moved-head",
          sha: F,
          repo_full_name: "netkeep80/repo-guard",
        },
      },
      {
        number: 650,
        state: "open",
        body: "No linked issue",
        head: {
          ref: "feature/no-owner",
          sha: H,
          repo_full_name: "netkeep80/repo-guard",
        },
      },
    ],
  };
}

console.log("\n--- #647 canonical control-plane graph ---");
{
  const graph = analyzeControlPlaneObservation(selfHostFixture());

  assert.equal(graph.repository, "netkeep80/repo-guard");
  assert.equal(graph.default_branch, "main");
  assert.equal(graph.delete_branch_on_merge, false);
  assert.equal(graph.root_issue_number, 518);

  assert.deepEqual(
    graph.derived.reachable_open_issues,
    [518, 589, 608, 622, 644, 647],
    "direct and transitive issue reachability must converge on the roadmap root",
  );
  assert.deepEqual(graph.derived.unreachable_open_issues, [999]);

  assert.deepEqual(
    graph.derived.owned_open_prs,
    [646, 648, 649],
    "ownership is roadmap reachability, independent of whether the PR head is in this repository",
  );
  assert.deepEqual(graph.derived.unowned_open_prs, [650]);

  assert.deepEqual(
    graph.derived.active_pr_head_branches,
    ["feature/no-owner", "research/644-relation-transition-falsifier"],
    "only exact current same-repository PR heads are active branch identities",
  );
  assert.deepEqual(graph.derived.moved_or_missing_pr_heads, [{
    pr: 649,
    ref: "moved-head",
    expected_sha: F,
    observed_sha: G,
  }]);

  assert.deepEqual(graph.derived.persistent_default_branches, ["main"]);
  assert.deepEqual(graph.derived.protected_non_default_branches, ["release/legacy"]);
  assert.deepEqual(
    graph.derived.unclassified_non_default_no_open_pr,
    ["moved-head", "release/legacy", "tmp-do-not-use"],
    "protected/name/age do not silently become deletion authority",
  );

  assert.equal(Object.hasOwn(graph.derived, "deletable_branches"), false, "P0 must not manufacture destructive authority");

  const projectionApiRelation = graph.relations.find(
    (relation) => relation.kind === "related" && relation.from === "issue:#622" && relation.to === "issue:#608",
  );
  assert.ok(projectionApiRelation);
  assert.equal(projectionApiRelation.provenance.source, "github_issue_body");

  const prHead = graph.relations.find(
    (relation) => relation.kind === "pr_head" && relation.from === "pr:#646",
  );
  assert.ok(prHead);
  assert.equal(
    prHead.to,
    `branch:research/644-relation-transition-falsifier@${B}`,
    "PR head relation must bind exact ref + SHA, not a branch name alone",
  );

  assert.equal(
    graph.relations.some((relation) => relation.kind === "pr_head" && relation.from === "pr:#648"),
    false,
    "fork heads must never become base-repository branch identities",
  );
}

console.log("\n--- #647 fail-closed normalization ---");
{
  const fixture = selfHostFixture();
  assert.throws(
    () => analyzeControlPlaneObservation({
      ...fixture,
      branches: [...fixture.branches, { name: "main", sha: A }],
    }),
    /duplicate branch "main"/,
  );

  assert.throws(
    () => analyzeControlPlaneObservation({
      ...fixture,
      branches: fixture.branches.map((branch) => branch.name === "main" ? { ...branch, sha: "not-a-sha" } : branch),
    }),
    /exact 40-hex commit SHA/,
  );

  assert.throws(
    () => analyzeControlPlaneObservation({
      ...fixture,
      default_branch: "missing-default",
    }),
    /is not present in observed branches/,
  );

  assert.throws(
    () => analyzeControlPlaneObservation({
      ...fixture,
      issues: [...fixture.issues, { number: 518, state: "open", body: "" }],
    }),
    /duplicate issue #518/,
  );
}

console.log("#647 control-plane graph projection passed");
