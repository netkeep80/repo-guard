import assert from "node:assert/strict";
import {
  analyzeControlPlaneObservation,
  controlPlaneObservationFromGitHub,
} from "../dist/facts/control-plane.mjs";
import { controlPlaneDoctorCheckFromGraph } from "../dist/doctor.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

function payload({ roadmap = "one" } = {}) {
  const issues = [
    { number: 518, state: "open", title: roadmap === "none" ? "Product plan" : "[Roadmap] Product plan", body: "" },
    { number: 647, state: "open", title: "Control plane", body: "Part of #518.", pull_request: null },
    { number: 648, state: "open", title: "PR mirror", body: "", pull_request: { url: "https://example.test/pr/648" } },
  ];
  if (roadmap === "two") issues.push({ number: 700, state: "open", title: "[Roadmap] Another", body: "" });
  return {
    repository: "netkeep80/repo-guard",
    repository_metadata: { default_branch: "main", delete_branch_on_merge: false },
    branches: [
      { name: "main", commit: { sha: A }, protected: true },
      { name: "research/647", commit: { sha: B }, protected: false },
      { name: "merged-residue", commit: { sha: C }, protected: false },
      { name: "unexplained", commit: { sha: D }, protected: false },
    ],
    issues,
    pull_requests: [
      {
        number: 648,
        state: "open",
        draft: false,
        merged_at: null,
        body: "Part of #647",
        head: { ref: "research/647", sha: B, repo: { full_name: "netkeep80/repo-guard" } },
      },
      {
        number: 640,
        state: "closed",
        draft: false,
        merged_at: "2026-10-01T00:00:00Z",
        body: "Part of #518",
        head: { ref: "merged-residue", sha: C, repo: { full_name: "netkeep80/repo-guard" } },
      },
    ],
  };
}

console.log("\n--- #647 GitHub provider projection ---");
{
  const observation = controlPlaneObservationFromGitHub(payload());
  assert.equal(observation.root_issue_number, 518);
  assert.equal(observation.issues.length, 2, "GitHub pull-request mirrors from /issues must not become Issue entities while pull_request:null remains a real Issue");
  assert.equal(observation.pull_requests[1].merged, true);
  assert.deepEqual(observation.pull_requests[0].head, {
    ref: "research/647",
    sha: B,
    repo_full_name: "netkeep80/repo-guard",
  });

  const graph = analyzeControlPlaneObservation(observation);
  const doctor = controlPlaneDoctorCheckFromGraph(graph);
  assert.equal(doctor.name, "control-plane-hygiene");
  assert.equal(doctor.status, "WARN");
  assert.match(doctor.message, /issues 2\/2 reachable/);
  assert.match(doctor.message, /PRs 1\/1 owned/);
  assert.match(doctor.message, /merged-residue 1/);
  assert.match(doctor.message, /unclassified 1/);
  assert.deepEqual(doctor.data.counts, {
    branches: 4,
    open_issues: 2,
    reachable_open_issues: 2,
    open_prs: 1,
    owned_open_prs: 1,
    active_pr_head_branches: 1,
    exact_merged_pr_head_residues: 1,
    exact_closed_unmerged_pr_head_residues: 0,
    unclassified_non_default_refs: 1,
  });
  assert.deepEqual(doctor.data.diagnostics.unclassified_non_default_refs, ["unexplained"]);
}

console.log("\n--- #647 roadmap inference is optional, never guessed from arbitrary issues ---");
{
  const raw = payload({ roadmap: "none" });
  raw.branches = raw.branches.slice(0, 2);
  raw.pull_requests = raw.pull_requests.slice(0, 1);
  const observation = controlPlaneObservationFromGitHub(raw);
  assert.equal(observation.root_issue_number, null);

  const graph = analyzeControlPlaneObservation(observation);
  assert.deepEqual(graph.derived.unreachable_open_issues, [518, 647]);
  assert.deepEqual(graph.derived.unowned_open_prs, [648]);

  const doctor = controlPlaneDoctorCheckFromGraph(graph);
  assert.equal(
    doctor.status,
    "PASS",
    "absence of a roadmap convention must not make generic consumers fail hygiene ownership checks",
  );
  assert.match(doctor.message, /roadmap root not inferred/);
  assert.equal(doctor.data.counts.reachable_open_issues, null);
  assert.equal(doctor.data.counts.owned_open_prs, null);
  assert.deepEqual(doctor.data.diagnostics.unreachable_open_issues, []);
  assert.deepEqual(doctor.data.diagnostics.unowned_open_prs, []);
}

{
  const observation = controlPlaneObservationFromGitHub(payload({ roadmap: "two" }));
  assert.equal(observation.root_issue_number, null, "multiple roadmap candidates must fail closed to no inferred authority root");
}

console.log("#647 control-plane doctor projection passed");
