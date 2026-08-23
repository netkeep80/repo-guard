import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { runTrustedPortableCoordinator } from "../dist/portable-integration/trusted-command.mjs";
import { COMMANDS } from "../dist/repo-guard.mjs";

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
const READY_LABEL = "repo-guard:ready";
const TX = "repo-guard / transaction";
const STATE = "repo-guard / state";
const M0 = "1111111111111111111111111111111111111111";
const M1 = "2222222222222222222222222222222222222222";
const M2 = "3333333333333333333333333333333333333333";
const MOLD = "0000000000000000000000000000000000000000";
const A0 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B0 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const B1 = "cccccccccccccccccccccccccccccccccccccccc";
const C0 = "dddddddddddddddddddddddddddddddddddddddd";
const C1 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const C2 = "ffffffffffffffffffffffffffffffffffffffff";

function checkRun(name, headSha, status) {
  if (status === "pending") {
    return { name, head_sha: headSha, status: "in_progress", conclusion: null, app: null };
  }
  return {
    name,
    head_sha: headSha,
    status: "completed",
    conclusion: status === "success" ? "success" : "failure",
    app: null,
  };
}

class FakeGitHubControlPlane {
  constructor(mainSha = M0) {
    this.mainSha = mainSha;
    this.prs = new Map();
    this.requests = [];
    this.successfulMerges = 0;
    this.beforeMutation = null;
    this.throwNextMutation = false;
    this.transport = { request: async (request) => this.mutate(request) };
  }

  addPr(number, headSha, options = {}) {
    this.prs.set(number, {
      number,
      baseSha: options.baseSha ?? this.mainSha,
      headSha,
      open: true,
      ready: options.ready ?? true,
      draft: options.draft ?? false,
      mergeability: options.mergeability ?? "mergeable",
      transaction: options.transaction ?? "success",
      state: options.state ?? "success",
      nextHeadSha: options.nextHeadSha ?? null,
      mergeSha: options.mergeSha ?? C2,
    });
  }

  rawPr(pr) {
    return {
      number: pr.number,
      draft: pr.draft,
      mergeable: pr.mergeability === "mergeable" ? true : pr.mergeability === "conflicting" ? false : null,
      base: { ref: "main", sha: pr.baseSha },
      head: { ref: `pr-${pr.number}`, sha: pr.headSha, repo: { full_name: REPOSITORY } },
      labels: pr.ready ? [{ name: READY_LABEL }] : [],
    };
  }

  async readReadyInventory() {
    const open = [...this.prs.values()].filter((pr) => pr.open).map((pr) => this.rawPr(pr));
    return { complete: true, pages: [open] };
  }

  async readCandidate(prNumber) {
    const pr = this.prs.get(prNumber);
    if (!pr || !pr.open) throw new Error(`PR #${prNumber} is not open`);
    return {
      currentMainSha: this.mainSha,
      pullRequest: this.rawPr(pr),
      compare: {
        mainSha: this.mainSha,
        headSha: pr.headSha,
        status: pr.baseSha === this.mainSha ? "ahead" : "behind",
      },
      checkRuns: {
        complete: true,
        headSha: pr.headSha,
        runs: [
          checkRun(TX, pr.headSha, pr.transaction),
          checkRun(STATE, pr.headSha, pr.state),
        ],
      },
    };
  }

  async mutate(request) {
    if (this.throwNextMutation) {
      this.throwNextMutation = false;
      throw new Error("simulated coordinator crash before GitHub accepted mutation");
    }
    if (this.beforeMutation) {
      const hook = this.beforeMutation;
      this.beforeMutation = null;
      await hook();
    }

    this.requests.push(request);
    const update = request.path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/update-branch$/);
    const merge = request.path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/);

    if (update) {
      const pr = this.prs.get(Number(update[1]));
      if (!pr || !pr.open) return { status: 404, body: { message: "not found" } };
      if (request.body.expected_head_sha !== pr.headSha) return { status: 422, body: { message: "head changed" } };
      if (pr.mergeability !== "mergeable") return { status: 409, body: { message: "conflict" } };
      if (!pr.nextHeadSha) return { status: 422, body: { message: "no refreshed head fixture" } };
      pr.baseSha = this.mainSha;
      pr.headSha = pr.nextHeadSha;
      pr.nextHeadSha = null;
      pr.transaction = "pending";
      pr.state = "pending";
      return { status: 202, body: { message: "scheduled" } };
    }

    if (merge) {
      const pr = this.prs.get(Number(merge[1]));
      if (!pr || !pr.open) return { status: 404, body: { message: "not found" } };
      if (request.body.sha !== pr.headSha) return { status: 409, body: { message: "head changed" } };
      if (pr.baseSha !== this.mainSha) return { status: 405, body: { message: "base branch was modified" } };
      if (pr.mergeability !== "mergeable" || pr.transaction !== "success" || pr.state !== "success") {
        return { status: 405, body: { message: "candidate is not mergeable" } };
      }
      pr.open = false;
      this.mainSha = pr.mergeSha;
      this.successfulMerges++;
      return { status: 200, body: { merged: true, sha: pr.mergeSha } };
    }

    return { status: 404, body: { message: "unknown mutation" } };
  }
}

function commandInput(control, overrides = {}) {
  return {
    repository: REPOSITORY,
    readyLabel: READY_LABEL,
    mergeMethod: "merge",
    requiredChecks: {
      transaction: [{ name: TX }],
      state: [{ name: STATE }],
    },
    readReadyInventory: () => control.readReadyInventory(),
    readCandidate: (prNumber) => control.readCandidate(prNumber),
    mutationTransport: control.transport,
    ...overrides,
  };
}

async function run(control, overrides = {}) {
  return runTrustedPortableCoordinator(commandInput(control, overrides));
}

console.log("\n--- trusted portable coordinator recovery/security contract ---");

{
  const control = new FakeGitHubControlPlane(M0);
  control.addPr(1, A0, { mergeSha: M1 });
  control.addPr(2, B0, { nextHeadSha: B1, mergeSha: M2 });

  const a = await run(control);
  expect("first READY candidate merges over exact M0", [a.pr, a.main_sha, a.head_sha, a.decision, a.mutation], [1, M0, A0, "merge_exact_head", "merge_exact_head"]);
  expect("first merge advances fake main", control.mainSha, M1);

  const refresh = await run(control);
  expect("second PR becomes coordinator-owned freshness work", [refresh.pr, refresh.decision, refresh.mutation], [2, "refresh_branch", "refresh_branch"]);
  expect("refresh sends exact old head", control.requests.at(-1)?.body.expected_head_sha, B0);

  const wait = await run(control);
  expect("refreshed head is reread and pending checks block merge", [wait.pr, wait.head_sha, wait.decision, wait.mutation], [2, B1, "wait_for_checks", "none"]);
  const pr2 = control.prs.get(2);
  pr2.transaction = "success";
  pr2.state = "success";

  const b = await run(control);
  expect("new exact head merges only after new evidence", [b.pr, b.head_sha, b.decision, b.mutation], [2, B1, "merge_exact_head", "merge_exact_head"]);
  expect("two concurrent READY PRs integrate without agent branch update", [control.mainSha, control.successfulMerges], [M2, 2]);
}

{
  const control = new FakeGitHubControlPlane(M0);
  control.addPr(1, C0, { baseSha: MOLD, nextHeadSha: C1, mergeSha: M1 });
  control.throwNextMutation = true;

  const crashed = await run(control);
  expect("transport crash is evidence, not an unguarded retry", [crashed.mutation, crashed.result?.ok, crashed.result?.error], ["refresh_branch", false, "transport_error"]);
  expect("crash before accepted mutation leaves head unchanged", control.prs.get(1).headSha, C0);

  const restarted = await run(control);
  expect("restart rebuilds queue and retries from fresh control-plane facts", [restarted.pr, restarted.head_sha, restarted.mutation], [1, C0, "refresh_branch"]);
  expect("accepted refresh installs a new head", control.prs.get(1).headSha, C1);
}

{
  const control = new FakeGitHubControlPlane(M0);
  control.addPr(1, A0, { mergeSha: M1 });
  const merged = await run(control);
  const after = await run(control);
  expect("merge response can be followed by restart without duplicate merge", [merged.mutation, after.kind, control.successfulMerges], ["merge_exact_head", "idle", 1]);
}

{
  const control = new FakeGitHubControlPlane(M0);
  control.addPr(1, A0, { mergeability: "conflicting" });
  control.addPr(2, B0, { transaction: "failure" });
  control.addPr(3, C0, { mergeSha: M1 });
  const result = await run(control);
  expect("conflict and failed checks do not head-of-line block later READY PR", [result.pr, result.decision, control.successfulMerges], [3, "merge_exact_head", 1]);
  expect("blocked PRs remain unmerged and isolated", [control.prs.get(1).open, control.prs.get(2).open], [true, true]);
}

{
  const control = new FakeGitHubControlPlane(M0);
  control.addPr(1, A0, { mergeSha: M1 });
  control.beforeMutation = async () => {
    const pr = control.prs.get(1);
    pr.headSha = B0;
    pr.transaction = "pending";
    pr.state = "pending";
  };
  const stale = await run(control);
  expect("head change between read and merge is rejected by exact-head write", [stale.result?.ok, stale.result?.error, control.successfulMerges], [false, "stale_head", 0]);
  const reread = await run(control);
  expect("next pass rereads changed head instead of reusing old evidence", [reread.head_sha, reread.decision, reread.mutation], [B0, "wait_for_checks", "none"]);
}

{
  const control = new FakeGitHubControlPlane(M0);
  control.addPr(1, A0, { nextHeadSha: B1, mergeSha: M2 });
  control.beforeMutation = async () => { control.mainSha = M1; };
  const staleMain = await run(control);
  expect("main advance before merge cannot stale-merge", [staleMain.result?.ok, staleMain.result?.error, control.successfulMerges], [false, "merge_not_allowed", 0]);
  const refresh = await run(control);
  expect("next pass sees new main and selects refresh", [refresh.main_sha, refresh.decision, refresh.mutation], [M1, "refresh_branch", "refresh_branch"]);
}

{
  const control = new FakeGitHubControlPlane(M0);
  control.addPr(1, C0, { baseSha: MOLD, nextHeadSha: C2, mergeSha: M1 });
  control.beforeMutation = async () => {
    const pr = control.prs.get(1);
    pr.headSha = C1;
    pr.nextHeadSha = C2;
  };
  const staleUpdate = await run(control);
  expect("head change before update-branch rejects old expected head", [staleUpdate.result?.ok, staleUpdate.result?.error], [false, "stale_head"]);
  const retry = await run(control);
  expect("retry after rejected update uses reread head", [retry.head_sha, retry.mutation, control.requests.at(-1)?.body.expected_head_sha], [C1, "refresh_branch", C1]);
}

{
  const control = new FakeGitHubControlPlane(M0);
  const malformed = await run(control, { readReadyInventory: async () => ({ complete: false, pages: [] }) });
  expect("incomplete control-plane inventory fails closed", [malformed.kind, malformed.mutation], ["invalid_inventory", "none"]);
}

{
  const source = readFileSync(new URL("../src/portable-integration/trusted-command.mts", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "actions/checkout", "npm test", "npm run", "git merge", "git rebase", "bypass", "admin"]) {
    expect(`trusted command source excludes privileged PR-code path: ${forbidden}`, source.includes(forbidden), false);
  }
  expect("trusted command delegates all mutations to guarded write adapter", source.includes("createGitHubWriteAdapter"), true);
  expect("trusted command reuses canonical GitHub read normalizers", source.includes("normalizeGitHubReadyInventory") && source.includes("normalizeGitHubCandidate"), true);
  expect("portable trusted command is not a public CLI command", COMMANDS.some((command) => command.includes("portable")), false);
}

console.log(`\n${failures === 0 ? "All trusted portable recovery/security tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
