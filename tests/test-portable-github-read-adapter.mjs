import { strict as assert } from "node:assert";
import {
  normalizeGitHubCandidate,
  normalizeGitHubReadyInventory,
} from "../dist/portable-integration/github-read.mjs";
import { planPortableIntegration } from "../dist/portable-integration/planner.mjs";

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

const REPO = "netkeep80/repo-guard";
const MAIN = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const OTHER = "3333333333333333333333333333333333333333";
const READY = "repo-guard:ready";

function pr(overrides = {}) {
  return {
    number: 42,
    draft: false,
    mergeable: true,
    base: { ref: "main", sha: MAIN },
    head: {
      ref: "feature/read-adapter",
      sha: HEAD,
      repo: { full_name: REPO },
    },
    labels: [{ name: READY }],
    ...overrides,
  };
}

function check(name, overrides = {}) {
  return {
    name,
    head_sha: HEAD,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    repository: REPO,
    currentMainSha: MAIN,
    readyLabel: READY,
    pullRequest: pr(),
    compare: {
      mainSha: MAIN,
      headSha: HEAD,
      status: "ahead",
    },
    checkRuns: {
      headSha: HEAD,
      complete: true,
      runs: [
        check("transaction-gate"),
        check("state-gate"),
      ],
    },
    requiredChecks: {
      transaction: [{ name: "transaction-gate", appSlug: "github-actions" }],
      state: [{ name: "state-gate", appSlug: "github-actions" }],
    },
    ...overrides,
  };
}

console.log("\n--- portable GitHub read adapter contract ---");

const valid = normalizeGitHubCandidate(candidate());
expect("valid GitHub state normalizes successfully", valid.ok, true);
if (valid.ok) {
  expect("candidate carries exact main SHA", valid.snapshot.currentMainSha, MAIN);
  expect("candidate carries exact head SHA", valid.snapshot.headSha, HEAD);
  expect("candidate carries exact base metadata", valid.snapshot.baseSha, MAIN);
  expect("READY label makes non-draft PR ready", valid.snapshot.ready, true);
  expect("mergeable=true maps to mergeable", valid.snapshot.mergeability, "mergeable");
  expect("ahead exact compare maps to current freshness", valid.snapshot.freshness, { mainSha: MAIN, status: "current" });
  expect("transaction gate is exact-head success", valid.snapshot.transaction, { headSha: HEAD, status: "success" });
  expect("state gate is exact-head success", valid.snapshot.state, { headSha: HEAD, status: "success" });
  expect("planner accepts normalized exact snapshot", planPortableIntegration(valid.snapshot).kind, "merge_exact_head");
  expect("normalized evidence keeps source identity", valid.evidence.transaction[0], {
    name: "transaction-gate",
    headSha: HEAD,
    status: "success",
    conclusion: "success",
    appSlug: "github-actions",
  });
}

const behind = normalizeGitHubCandidate(candidate({
  compare: { mainSha: MAIN, headSha: HEAD, status: "diverged" },
}));
expect("diverged compare is normalized as behind", behind.ok && behind.snapshot.freshness.status, "behind");
if (behind.ok) expect("planner requests coordinator refresh for behind branch", planPortableIntegration(behind.snapshot).kind, "refresh_branch");

const mergeabilityUnknown = normalizeGitHubCandidate(candidate({
  pullRequest: pr({ mergeable: null }),
}));
expect("mergeable=null is preserved as unknown instead of optimistic true", mergeabilityUnknown.ok && mergeabilityUnknown.snapshot.mergeability, "unknown");
if (mergeabilityUnknown.ok) expect("unknown mergeability cannot merge", planPortableIntegration(mergeabilityUnknown.snapshot).kind, "invalid_snapshot");

const pending = normalizeGitHubCandidate(candidate({
  checkRuns: {
    headSha: HEAD,
    complete: true,
    runs: [
      check("transaction-gate", { status: "in_progress", conclusion: null }),
      check("state-gate"),
    ],
  },
}));
expect("in-progress required check maps to pending gate", pending.ok && pending.snapshot.transaction.status, "pending");

const failed = normalizeGitHubCandidate(candidate({
  checkRuns: {
    headSha: HEAD,
    complete: true,
    runs: [
      check("transaction-gate", { conclusion: "failure" }),
      check("state-gate"),
    ],
  },
}));
expect("failed completed required check maps to failure gate", failed.ok && failed.snapshot.transaction.status, "failure");

const missing = normalizeGitHubCandidate(candidate({
  checkRuns: {
    headSha: HEAD,
    complete: true,
    runs: [check("transaction-gate")],
  },
}));
expect("missing required check maps to missing gate", missing.ok && missing.snapshot.state.status, "missing");

const wrongCheckSha = normalizeGitHubCandidate(candidate({
  checkRuns: {
    headSha: OTHER,
    complete: true,
    runs: [
      check("transaction-gate", { head_sha: OTHER }),
      check("state-gate", { head_sha: OTHER }),
    ],
  },
}));
expect("check evidence envelope bound to another SHA is rejected", wrongCheckSha.ok, false);
expect("wrong-head check evidence is diagnosed", wrongCheckSha.error, "stale_check_evidence");

const wrongCompareMain = normalizeGitHubCandidate(candidate({
  compare: { mainSha: OTHER, headSha: HEAD, status: "ahead" },
}));
expect("compare evidence bound to another main is rejected", wrongCompareMain.ok, false);
expect("stale compare main is diagnosed", wrongCompareMain.error, "stale_freshness_evidence");

const wrongCompareHead = normalizeGitHubCandidate(candidate({
  compare: { mainSha: MAIN, headSha: OTHER, status: "ahead" },
}));
expect("compare evidence bound to another head is rejected", wrongCompareHead.ok, false);
expect("stale compare head is diagnosed", wrongCompareHead.error, "stale_freshness_evidence");

const malformedPr = normalizeGitHubCandidate(candidate({
  pullRequest: pr({ number: 0 }),
}));
expect("malformed PR number fails closed", malformedPr.ok, false);
expect("malformed PR is diagnosed", malformedPr.error, "malformed_pull_request");

const malformedRef = normalizeGitHubCandidate(candidate({
  pullRequest: pr({ base: { ref: "", sha: MAIN } }),
}));
expect("empty base ref fails closed", malformedRef.ok, false);

const malformedMain = normalizeGitHubCandidate(candidate({ currentMainSha: "main" }));
expect("non-SHA current main fails closed", malformedMain.ok, false);
expect("malformed main is diagnosed", malformedMain.error, "malformed_main");

const unknownCheckState = normalizeGitHubCandidate(candidate({
  checkRuns: {
    headSha: HEAD,
    complete: true,
    runs: [
      check("transaction-gate", { status: "teleported" }),
      check("state-gate"),
    ],
  },
}));
expect("unknown check status never becomes success", unknownCheckState.ok, false);
expect("unknown check state is diagnosed", unknownCheckState.error, "unknown_check_state");

const duplicate = normalizeGitHubCandidate(candidate({
  checkRuns: {
    headSha: HEAD,
    complete: true,
    runs: [
      check("transaction-gate"),
      check("transaction-gate"),
      check("state-gate"),
    ],
  },
}));
expect("duplicate required check identity is rejected deterministically", duplicate.ok, false);
expect("duplicate required check is diagnosed", duplicate.error, "duplicate_required_check");

const wrongApp = normalizeGitHubCandidate(candidate({
  checkRuns: {
    headSha: HEAD,
    complete: true,
    runs: [
      check("transaction-gate", { app: { slug: "other-app" } }),
      check("state-gate"),
    ],
  },
}));
expect("same-name check from wrong app cannot satisfy required source", wrongApp.ok && wrongApp.snapshot.transaction.status, "missing");

const incompleteChecks = normalizeGitHubCandidate(candidate({
  checkRuns: {
    headSha: HEAD,
    complete: false,
    runs: [
      check("transaction-gate"),
      check("state-gate"),
    ],
  },
}));
expect("incomplete check-run pagination fails closed", incompleteChecks.ok, false);
expect("incomplete check pages are diagnosed", incompleteChecks.error, "incomplete_check_inventory");

const inventory = normalizeGitHubReadyInventory({
  repository: REPO,
  readyLabel: READY,
  complete: true,
  pages: [
    [pr()],
    [pr({
      number: 43,
      labels: [],
      head: { ref: "fork-work", sha: OTHER, repo: { full_name: "contributor/repo-guard" } },
    })],
  ],
});
expect("complete paginated inventory normalizes", inventory.ok, true);
if (inventory.ok) {
  expect("all PRs remain observable", inventory.items.map((item) => item.prNumber), [42, 43]);
  expect("ready projection excludes not-ready PR", inventory.readyPrNumbers, [42]);
  expect("fork repository remains inert metadata", inventory.items[1].headRepository, "contributor/repo-guard");
}

const draftReadyLabel = normalizeGitHubReadyInventory({
  repository: REPO,
  readyLabel: READY,
  complete: true,
  pages: [[pr({ draft: true })]],
});
expect("draft PR is not READY even with marker", draftReadyLabel.ok && draftReadyLabel.readyPrNumbers, []);

const incompleteInventory = normalizeGitHubReadyInventory({
  repository: REPO,
  readyLabel: READY,
  complete: false,
  pages: [[pr()]],
});
expect("incomplete PR pagination fails closed", incompleteInventory.ok, false);
expect("incomplete PR pages are diagnosed", incompleteInventory.error, "incomplete_pr_inventory");

const malformedInventory = normalizeGitHubReadyInventory({
  repository: REPO,
  readyLabel: READY,
  complete: true,
  pages: [[pr({ head: { ref: "feature", sha: "bad", repo: { full_name: REPO } } })]],
});
expect("malformed inventory item fails whole inventory closed", malformedInventory.ok, false);
expect("malformed inventory item is diagnosed", malformedInventory.error, "malformed_pull_request");

console.log(`\n${failures === 0 ? "All portable GitHub read-adapter tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
