import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createParallelDoctorReport, renderParallelDoctorReport } from "../dist/parallel-doctor.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
let failures = 0;

const MAIN = "1111111111111111111111111111111111111111";
const OPEN = "2222222222222222222222222222222222222222";
const OWNED = "3333333333333333333333333333333333333333";
const MERGED = "4444444444444444444444444444444444444444";
const ORPHAN = "5555555555555555555555555555555555555555";
const PUBLISH = "6666666666666666666666666666666666666666";
const RELEASE = "7777777777777777777777777777777777777777";

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function expectIncludes(label, actual, expected) {
  const passed = actual.includes(expected);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected to include: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function expectNotIncludes(label, actual, expected) {
  const passed = !actual.includes(expected);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected not to include: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    env: process.env,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function readyIntegrationFacts() {
  return {
    workflows: [
      {
        path: ".github/workflows/ci.yml",
        role: "repo_guard_pr_gate",
        expect: { mode: "check-pr", enforcement: "blocking" },
        triggerEvents: ["pull_request"],
        actionUses: [{ uses: "./" }],
        stepInputs: [{ inputs: { mode: "check-pr", enforcement: "blocking" } }],
        continueOnError: [],
      },
      {
        path: ".github/workflows/parallel.yml",
        role: "repo_guard_portable_coordinator",
        expect: { mode: "portable-coordinator", enforcement: "blocking" },
        actionUses: [{ uses: "./" }],
        stepInputs: [{ inputs: { mode: "portable-coordinator", enforcement: "blocking" } }],
        continueOnError: [],
        runCommands: [],
      },
    ],
    errors: [],
  };
}

function readyControlPlaneRead() {
  return {
    ok: true,
    provider: "portable",
    repository: "netkeep80/example",
    repositoryOwnerType: "User",
    defaultBranch: "main",
    branchProtection: {
      complete: true,
      protected: true,
      data: {
        required_status_checks: { strict: true, contexts: ["CI / validate"], checks: [] },
        required_pull_request_reviews: { bypass_pull_request_allowances: { users: [], teams: [], apps: [] } },
        enforce_admins: { enabled: true },
      },
    },
    activeBranchRules: { complete: true, rules: [] },
    rulesets: { complete: true, items: [] },
    errors: [],
  };
}

function branchAwareControlPlaneRead() {
  return {
    ...readyControlPlaneRead(),
    deleteBranchOnMerge: false,
    branchInventory: {
      complete: true,
      items: [
        { name: "main", sha: MAIN, protected: true },
        { name: "gh-pages", sha: PUBLISH, protected: false },
        { name: "release/stable", sha: RELEASE, protected: false },
        { name: "feature/open", sha: OPEN, protected: false },
        { name: "agent/owned", sha: OWNED, protected: false },
        { name: "feature/merged", sha: MERGED, protected: false },
        { name: "feature/orphan", sha: ORPHAN, protected: false },
      ],
    },
    openSameRepositoryPullRequestHeads: {
      complete: true,
      items: [{ number: 7, name: "feature/open", sha: OPEN }],
    },
    mergedSameRepositoryPullRequestHeads: {
      complete: true,
      items: [{ number: 6, name: "feature/merged", sha: MERGED }],
    },
  };
}

function incompleteClassicControlPlaneRead(repositoryOwnerType) {
  return {
    ok: true,
    provider: "portable",
    repository: "netkeep80/example",
    ...(repositoryOwnerType === undefined ? {} : { repositoryOwnerType }),
    defaultBranch: "main",
    branchProtection: {
      complete: true,
      protected: true,
      data: {
        required_status_checks: { strict: true, contexts: ["CI / validate"], checks: [] },
        required_pull_request_reviews: { required_approving_review_count: 0 },
        enforce_admins: { enabled: true },
      },
    },
    activeBranchRules: { complete: true, rules: [] },
    rulesets: { complete: true, items: [] },
    errors: [],
  };
}

console.log("\n--- doctor --parallel requires an explicit provider value ---");
{
  const result = run(["doctor", "--parallel"]);
  expect("missing provider exits non-zero", result.code, 1);
  expectIncludes("parallel option is recognized as value-taking", result.stderr, "--parallel requires a value");
  expectNotIncludes("parallel option is not rejected as unknown", result.stderr, "Unknown option for doctor: --parallel");
}

console.log("\n--- doctor --parallel rejects unsupported providers ---");
{
  const result = run(["doctor", "--parallel", "bogus"]);
  expect("unsupported provider exits non-zero", result.code, 1);
  expectIncludes("unsupported provider is explicit", result.stderr, "Unsupported parallel provider: bogus");
}

console.log("\n--- doctor --parallel accepts explicit persistent branch refs ---");
{
  const result = run(["doctor", "--parallel", "bogus", "--persistent-branch", "gh-pages"]);
  expect("unsupported provider still exits non-zero", result.code, 1);
  expectIncludes("provider validation remains authoritative", result.stderr, "Unsupported parallel provider: bogus");
  expectNotIncludes("persistent branch option is accepted by CLI parser", result.stderr, "Unknown option for doctor: --persistent-branch");
}

console.log("\n--- parallel doctor composes canonical repository and control-plane readiness ---");
{
  const report = createParallelDoctorReport({
    provider: "portable",
    integrationFacts: readyIntegrationFacts(),
    integrationValid: true,
    controlPlaneRead: readyControlPlaneRead(),
  });
  assert.equal(report.provider, "portable");
  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.evidence.repository.transactionWorkflow, ".github/workflows/ci.yml");
  assert.equal(report.evidence.repository.providerWorkflow, ".github/workflows/parallel.yml");
  assert.equal(report.evidence.control_plane.targetBranch, "main");
  assert.deepEqual(report.evidence.control_plane.requiredChecks, ["CI / validate"]);
  assert.equal(report.diagnostics.controlPlane.repository, "netkeep80/example");
  assert.deepEqual(report.diagnostics.controlPlane.adapterErrors, []);

  const json = JSON.parse(renderParallelDoctorReport(report, "json"));
  assert.equal(json.provider, "portable");
  assert.equal(json.ready, true);
  assert.deepEqual(json.blockers, []);

  const text = renderParallelDoctorReport(report, "text");
  assert.match(text, /repo-guard doctor --parallel portable/);
  assert.match(text, /READY/);
  assert.match(text, /transaction workflow: \.github\/workflows\/ci\.yml/);
  assert.match(text, /provider workflow: \.github\/workflows\/parallel\.yml/);
  assert.match(text, /target branch: main/);
  assert.match(text, /required checks: CI \/ validate/);
}

console.log("\n--- branch hygiene is a machine-readable advisory diagnostic with explicit exemptions ---");
{
  const report = createParallelDoctorReport({
    provider: "portable",
    integrationFacts: readyIntegrationFacts(),
    integrationValid: true,
    controlPlaneRead: branchAwareControlPlaneRead(),
    persistentBranches: ["gh-pages", "release/stable"],
    durableOwnership: {
      complete: true,
      items: [{ name: "agent/owned", state: "handoff" }],
    },
  });

  assert.equal(report.ready, true, "advisory branch hygiene must not silently change parallel readiness");
  assert.deepEqual(report.diagnostics.branchHygiene, {
    ok: true,
    persistentBranches: [
      { name: "gh-pages", sha: PUBLISH, protected: false },
      { name: "main", sha: MAIN, protected: true },
      { name: "release/stable", sha: RELEASE, protected: false },
    ],
    activePullRequestHeads: [{ number: 7, name: "feature/open", sha: OPEN }],
    ownedPrePullRequestBranches: [{ name: "agent/owned", sha: OWNED, state: "handoff" }],
    staleOwnershipBranches: [],
    orphanCandidates: [
      { name: "feature/merged", sha: MERGED, protected: false },
      { name: "feature/orphan", sha: ORPHAN, protected: false },
    ],
    mergedPullRequestHeadsStillPresent: [{ number: 6, name: "feature/merged", sha: MERGED }],
    deleteBranchOnMergeDrift: { state: "disabled", residualMergedBranchCount: 1 },
  });

  const json = JSON.parse(renderParallelDoctorReport(report, "json"));
  assert.equal(json.diagnostics.branchHygiene.ok, true);
  assert.equal(json.diagnostics.branchHygiene.deleteBranchOnMergeDrift.state, "disabled");
  assert.equal(json.diagnostics.branchHygiene.orphanCandidates.length, 2);

  const text = renderParallelDoctorReport(report, "text");
  assert.match(text, /branch hygiene: advisory/);
  assert.match(text, /persistent branches: gh-pages, main, release\/stable/);
  assert.match(text, /merged PR heads still present: feature\/merged/);
  assert.match(text, /orphan candidates: feature\/merged, feature\/orphan/);
  assert.match(text, /delete_branch_on_merge: disabled/);
}

console.log("\n--- user-owned classic protection preserves trusted owner type through doctor projection ---");
{
  const report = createParallelDoctorReport({
    provider: "portable",
    integrationFacts: readyIntegrationFacts(),
    integrationValid: true,
    controlPlaneRead: incompleteClassicControlPlaneRead("User"),
  });
  assert.equal(report.ready, true, JSON.stringify(report.blockers));
  assert.deepEqual(report.blockers, []);
}

console.log("\n--- incomplete classic bypass evidence without trusted owner type stays fail-closed ---");
{
  const report = createParallelDoctorReport({
    provider: "portable",
    integrationFacts: readyIntegrationFacts(),
    integrationValid: true,
    controlPlaneRead: incompleteClassicControlPlaneRead(undefined),
  });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((item) => item.id === "unknown_bypass_state" && item.source === "control_plane"));
}

console.log("\n--- parallel doctor fails closed when GitHub control-plane read fails ---");
{
  const report = createParallelDoctorReport({
    provider: "portable",
    integrationFacts: readyIntegrationFacts(),
    integrationValid: true,
    controlPlaneRead: { ok: false, error: "repository_metadata_api_error", message: "HTTP 403" },
  });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((item) => item.id === "unknown_target_branch" && item.source === "control_plane"));
  assert.ok(report.blockers.some((item) => item.id === "unknown_required_checks" && item.source === "control_plane"));
  assert.deepEqual(report.diagnostics.controlPlane.adapterErrors, [{ id: "repository_metadata_api_error", message: "HTTP 403" }]);
  const text = renderParallelDoctorReport(report, "text");
  assert.match(text, /NOT READY/);
  assert.match(text, /control_plane\/unknown_target_branch/);
}

console.log("\n=========================");
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("All parallel doctor tests passed");
