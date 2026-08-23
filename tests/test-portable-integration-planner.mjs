import { strict as assert } from "node:assert";
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

const MAIN = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const OLD_MAIN = "3333333333333333333333333333333333333333";
const OLD_HEAD = "4444444444444444444444444444444444444444";

function snapshot(overrides = {}) {
  return {
    currentMainSha: MAIN,
    prNumber: 42,
    baseRef: "main",
    baseSha: MAIN,
    headSha: HEAD,
    ready: true,
    mergeability: "mergeable",
    freshness: { mainSha: MAIN, status: "current" },
    transaction: { headSha: HEAD, status: "success" },
    state: { headSha: HEAD, status: "success" },
    ...overrides,
  };
}

console.log("\n--- portable integration planner exact snapshot contract ---");

const merge = planPortableIntegration(snapshot());
expect("fresh exact candidate is mergeable", merge.kind, "merge_exact_head");
expect("merge decision carries exact main SHA", merge.mainSha, MAIN);
expect("merge decision carries exact head SHA", merge.headSha, HEAD);
expect("merge decision carries PR number", merge.prNumber, 42);
expect("merge decision explains readiness", merge.reason, "ready_to_merge");

const behind = planPortableIntegration(snapshot({ freshness: { mainSha: MAIN, status: "behind" } }));
expect("behind candidate requests coordinator refresh", behind.kind, "refresh_branch");
expect("behind candidate reason is explicit", behind.reason, "branch_behind");

const behindWithOldGreenEvidence = planPortableIntegration(snapshot({
  freshness: { mainSha: MAIN, status: "behind" },
  transaction: { headSha: OLD_HEAD, status: "success" },
  state: { headSha: OLD_HEAD, status: "success" },
}));
expect("behind candidate with old green evidence still refreshes instead of merging", behindWithOldGreenEvidence.kind, "refresh_branch");

const staleHeadEvidence = planPortableIntegration(snapshot({
  transaction: { headSha: OLD_HEAD, status: "success" },
}));
expect("stale transaction evidence cannot merge", staleHeadEvidence.kind, "invalid_snapshot");
expect("stale transaction evidence is diagnosed", staleHeadEvidence.reason, "evidence_stale");

const staleStateEvidence = planPortableIntegration(snapshot({
  state: { headSha: OLD_HEAD, status: "success" },
}));
expect("stale state evidence cannot merge", staleStateEvidence.kind, "invalid_snapshot");
expect("stale state evidence is diagnosed", staleStateEvidence.reason, "evidence_stale");

const staleFreshness = planPortableIntegration(snapshot({
  freshness: { mainSha: OLD_MAIN, status: "current" },
}));
expect("freshness evidence bound to an old main fails closed", staleFreshness.kind, "invalid_snapshot");
expect("old-main freshness evidence is diagnosed", staleFreshness.reason, "freshness_stale");

const baseMetadataCounterexample = planPortableIntegration(snapshot({
  baseSha: MAIN,
  freshness: { mainSha: MAIN, status: "behind" },
}));
expect("base SHA equality does not override explicit behind evidence", baseMetadataCounterexample.kind, "refresh_branch");

const conflict = planPortableIntegration(snapshot({ mergeability: "conflicting" }));
expect("conflicting candidate is blocked", conflict.kind, "block_conflict");
expect("conflict reason is explicit", conflict.reason, "merge_conflict");

const mergeabilityUnknown = planPortableIntegration(snapshot({ mergeability: "unknown" }));
expect("unknown mergeability fails closed", mergeabilityUnknown.kind, "invalid_snapshot");
expect("unknown mergeability is diagnosed", mergeabilityUnknown.reason, "mergeability_unknown");

const freshnessUnknown = planPortableIntegration(snapshot({
  freshness: { mainSha: MAIN, status: "unknown" },
}));
expect("unknown freshness fails closed", freshnessUnknown.kind, "invalid_snapshot");
expect("unknown freshness is diagnosed", freshnessUnknown.reason, "freshness_unknown");

const failedTransaction = planPortableIntegration(snapshot({
  transaction: { headSha: HEAD, status: "failure" },
}));
expect("failed transaction gate blocks candidate", failedTransaction.kind, "block_failed_checks");
expect("failed transaction gate reason is explicit", failedTransaction.reason, "checks_failed");

const failedState = planPortableIntegration(snapshot({
  state: { headSha: HEAD, status: "failure" },
}));
expect("failed state gate blocks candidate", failedState.kind, "block_failed_checks");

const pending = planPortableIntegration(snapshot({
  transaction: { headSha: HEAD, status: "pending" },
}));
expect("pending exact-head check waits", pending.kind, "wait_for_checks");
expect("pending check reason is explicit", pending.reason, "checks_pending");

const missing = planPortableIntegration(snapshot({
  state: { headSha: HEAD, status: "missing" },
}));
expect("missing exact-head check waits", missing.kind, "wait_for_checks");

const notReady = planPortableIntegration(snapshot({ ready: false }));
expect("PR without READY marker is ignored", notReady.kind, "ignore_not_ready");
expect("not-ready reason is explicit", notReady.reason, "not_ready");

const malformedSha = planPortableIntegration(snapshot({ headSha: "not-a-sha" }));
expect("malformed candidate SHA fails closed", malformedSha.kind, "invalid_snapshot");
expect("malformed candidate is diagnosed", malformedSha.reason, "malformed_snapshot");

const missingFreshness = planPortableIntegration({
  ...snapshot(),
  freshness: undefined,
});
expect("missing freshness evidence fails closed", missingFreshness.kind, "invalid_snapshot");
expect("missing freshness is diagnosed", missingFreshness.reason, "malformed_snapshot");

const malformedPr = planPortableIntegration(snapshot({ prNumber: 0 }));
expect("invalid PR number fails closed", malformedPr.kind, "invalid_snapshot");

const deterministicInput = snapshot();
const first = JSON.stringify(planPortableIntegration(deterministicInput));
const second = JSON.stringify(planPortableIntegration(deterministicInput));
expect("same snapshot produces byte-stable decision", first, second);

console.log(`\n${failures === 0 ? "All portable integration planner tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
