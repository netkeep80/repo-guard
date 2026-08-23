import { strict as assert } from "node:assert";
import { runPortableCoordinatorPass } from "../dist/portable-integration/coordinator.mjs";

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

const REPOSITORY = "netkeep80/example";
const MAIN = "1111111111111111111111111111111111111111";
const H1 = "2222222222222222222222222222222222222222";
const H2 = "3333333333333333333333333333333333333333";
const H3 = "4444444444444444444444444444444444444444";

function candidate(prNumber, headSha, overrides = {}) {
  return {
    currentMainSha: MAIN,
    prNumber,
    baseRef: "main",
    baseSha: MAIN,
    headSha,
    ready: true,
    mergeability: "mergeable",
    freshness: { mainSha: MAIN, status: "current" },
    transaction: { headSha, status: "success" },
    state: { headSha, status: "success" },
    ...overrides,
  };
}

function inventory(prNumbers = [3, 1, 2]) {
  return {
    ok: true,
    repository: REPOSITORY,
    readyPrNumbers: prNumbers,
  };
}

function harness(snapshots, mutationResults = {}) {
  const calls = { candidate: [], update: [], merge: [] };
  return {
    calls,
    deps: {
      async loadCandidate(prNumber) {
        calls.candidate.push(prNumber);
        return snapshots.get(prNumber);
      },
      async updateBranch(input) {
        calls.update.push(input);
        return mutationResults.update ?? {
          ok: true,
          kind: "update_accepted",
          expectedHeadSha: input.expectedHeadSha,
          rereadRequired: true,
        };
      },
      async mergeExactHead(input) {
        calls.merge.push(input);
        return mutationResults.merge ?? {
          ok: true,
          kind: "merged",
          expectedHeadSha: input.expectedHeadSha,
          mergeSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          mergeMethod: input.mergeMethod,
        };
      },
    },
  };
}

console.log("\n--- portable durable READY coordinator contract ---");

{
  const h = harness(new Map([
    [1, candidate(1, H1)],
    [2, candidate(2, H2)],
    [3, candidate(3, H3)],
  ]));
  const result = await runPortableCoordinatorPass({
    inventory: inventory(),
    mergeMethod: "merge",
    ...h.deps,
  });
  expect("READY inventory is processed in deterministic PR-number order", h.calls.candidate, [1]);
  expect("first actionable candidate is selected deterministically", result.prNumber, 1);
  expect("fresh candidate produces exactly one merge mutation", h.calls.merge.length, 1);
  expect("merge carries exact candidate head", h.calls.merge[0]?.expectedHeadSha, H1);
  expect("merge result stops the pass", result.mutation, "merge_exact_head");
}

{
  const h = harness(new Map([
    [1, candidate(1, H1, { freshness: { mainSha: MAIN, status: "behind" } })],
    [2, candidate(2, H2)],
  ]));
  const result = await runPortableCoordinatorPass({
    inventory: inventory([2, 1]),
    mergeMethod: "squash",
    ...h.deps,
  });
  expect("behind first candidate performs one guarded refresh", h.calls.update.length, 1);
  expect("refresh uses exact old head", h.calls.update[0]?.expectedHeadSha, H1);
  expect("refresh never falls through to optimistic same-pass merge", h.calls.merge.length, 0);
  expect("refresh pass requires a future reread", result.result?.rereadRequired, true);
}

{
  const h = harness(new Map([
    [1, candidate(1, H1, { transaction: { headSha: H1, status: "pending" } })],
    [2, candidate(2, H2)],
  ]));
  const result = await runPortableCoordinatorPass({
    inventory: inventory([1, 2]),
    mergeMethod: "merge",
    ...h.deps,
  });
  expect("waiting candidate does not permanently head-of-line block later READY PR", h.calls.candidate, [1, 2]);
  expect("later actionable candidate can merge", result.prNumber, 2);
  expect("only one mutation is executed in the pass", h.calls.merge.length + h.calls.update.length, 1);
}

{
  const h = harness(new Map([
    [1, candidate(1, H1, { mergeability: "conflicting" })],
    [2, candidate(2, H2, { transaction: { headSha: H2, status: "failure" } })],
    [3, candidate(3, H3)],
  ]));
  const result = await runPortableCoordinatorPass({
    inventory: inventory([3, 2, 1]),
    mergeMethod: "rebase",
    ...h.deps,
  });
  expect("blocked candidates are observed in deterministic order before later progress", h.calls.candidate, [1, 2, 3]);
  expect("conflict/check failures do not corrupt the durable queue", result.prNumber, 3);
  expect("later independent READY candidate progresses", h.calls.merge.length, 1);
}

{
  const h = harness(new Map([
    [1, candidate(1, H1, { transaction: { headSha: H3, status: "success" } })],
    [2, candidate(2, H2)],
  ]));
  const result = await runPortableCoordinatorPass({
    inventory: inventory([1, 2]),
    mergeMethod: "merge",
    ...h.deps,
  });
  expect("stale candidate evidence cannot refresh", h.calls.update.length, 0);
  expect("stale candidate evidence cannot itself merge", h.calls.merge.length, 1);
  expect("later exact candidate may still progress", result.prNumber, 2);
}

{
  const first = harness(new Map([[1, candidate(1, H1)]]));
  const second = harness(new Map([[1, candidate(1, H1)]]));
  const input = { inventory: inventory([1]), mergeMethod: "merge" };
  const a = await runPortableCoordinatorPass({ ...input, ...first.deps });
  const b = await runPortableCoordinatorPass({ ...input, ...second.deps });
  expect("restart rebuilds the same durable READY membership from supplied control-plane inventory", a.prNumber, b.prNumber);
  expect("same pass snapshot is deterministic", JSON.stringify(a), JSON.stringify(b));
}

{
  const h = harness(new Map());
  const result = await runPortableCoordinatorPass({
    inventory: { ok: false, error: "incomplete_pr_inventory", message: "pagination incomplete" },
    mergeMethod: "merge",
    ...h.deps,
  });
  expect("incomplete inventory fails closed", result.kind, "invalid_inventory");
  expect("incomplete inventory performs no candidate reads", h.calls.candidate.length, 0);
  expect("incomplete inventory performs no writes", h.calls.merge.length + h.calls.update.length, 0);
}

{
  const h = harness(new Map([[1, candidate(1, H1)]]));
  const result = await runPortableCoordinatorPass({
    inventory: inventory([1, 1]),
    mergeMethod: "merge",
    ...h.deps,
  });
  expect("duplicate READY membership fails closed", result.kind, "invalid_inventory");
  expect("duplicate membership performs no writes", h.calls.merge.length + h.calls.update.length, 0);
}

{
  const h = harness(new Map([[1, candidate(1, H1)]]));
  const result = await runPortableCoordinatorPass({
    inventory: inventory([1]),
    mergeMethod: "octopus",
    ...h.deps,
  });
  expect("invalid merge method fails closed before candidate reads", result.kind, "invalid_input");
  expect("invalid merge method performs no writes", h.calls.merge.length + h.calls.update.length, 0);
}

{
  const h = harness(new Map());
  const result = await runPortableCoordinatorPass({
    inventory: inventory([]),
    mergeMethod: "merge",
    ...h.deps,
  });
  expect("empty durable READY inventory is a stable no-op", result.kind, "idle");
  expect("empty inventory performs no writes", h.calls.merge.length + h.calls.update.length, 0);
}

console.log(`\n${failures === 0 ? "All portable coordinator tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
