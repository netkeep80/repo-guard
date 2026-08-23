import assert from "node:assert/strict";
import { COMMANDS, runCli } from "../dist/repo-guard.mjs";
import { runPortableCoordinatorCommand } from "../dist/portable-integration/public-command.mjs";

assert.equal(COMMANDS.includes("portable-coordinator"), true, "public CLI exposes portable-coordinator command");

const originalError = console.error, errors = [];
console.error = (...args) => errors.push(args.join(" "));
const cases = [
  [["--definitely-unknown"], /Unknown option/], [["--repo-root"], /--repo-root requires a path argument/],
  [["check-diff", "--base"], /--base requires a value/], [["check-diff", "--change-intent"], /--change-intent requires a value/],
  [["check-diff", "--contract", "legacy.json"], /Unknown option for check-diff/], [["check-pr", "extra"], /Unexpected argument for check-pr/],
  [["validate", "one.json", "two.json"], /Unexpected argument for validate/], [["init", "--bogus"], /Unknown option for init/],
  [["portable-coordinator", "--repository", "not-a-repo", "--ready-label", "ready", "--merge-method", "merge", "--transaction-check", "tx", "--state-check", "state"], /malformed_repository/],
];
try {
  for (const [args, pattern] of cases) {
    errors.length = 0; assert.equal(await runCli(args), 1); assert.match(errors.join("\n"), pattern);
  }
} finally { console.error = originalError; }

const mainSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const mergeSha = "cccccccccccccccccccccccccccccccccccccccc";
const mergePr = {
  number: 7,
  draft: false,
  mergeable: true,
  base: { ref: "main", sha: mainSha },
  head: { ref: "feature", sha: headSha, repo: { full_name: "netkeep80/example" } },
  labels: [{ name: "repo-guard:ready" }],
};
const mergeCalls = [];
const mergeOutput = [];
const mergeExit = await runPortableCoordinatorCommand(
  {},
  [
    "--repository", "netkeep80/example",
    "--ready-label", "repo-guard:ready",
    "--merge-method", "squash",
    "--transaction-check", "tx",
    "--state-check", "state",
    "--format", "json",
  ],
  {},
  {
    readReadyInventory: async () => ({ complete: true, pages: [[mergePr]] }),
    readCandidate: async () => ({
      currentMainSha: mainSha,
      pullRequest: mergePr,
      compare: { mainSha, headSha, status: "ahead" },
      checkRuns: {
        complete: true,
        headSha,
        runs: [
          { name: "tx", head_sha: headSha, status: "completed", conclusion: "success" },
          { name: "state", head_sha: headSha, status: "completed", conclusion: "success" },
        ],
      },
    }),
    run: (command, args) => {
      mergeCalls.push([command, args]);
      return `HTTP/2 200 OK\ncontent-type: application/json\n\n${JSON.stringify({ merged: true, sha: mergeSha })}`;
    },
    writeOutput: (text) => mergeOutput.push(text),
  },
);
assert.equal(mergeExit, 0, "public portable coordinator accepts a canonical exact-head merge");
assert.deepEqual(mergeCalls, [[
  "gh",
  [
    "api",
    "repos/netkeep80/example/pulls/7/merge",
    "--method", "PUT",
    "--include",
    "--raw-field", `sha=${headSha}`,
    "--raw-field", "merge_method=squash",
  ],
]], "public mutation transport preserves exact merge head and merge method without a shell");
const mergeEvidence = JSON.parse(mergeOutput[0]);
assert.equal(mergeEvidence.decision, "merge_exact_head");
assert.equal(mergeEvidence.mutation, "merge");
assert.deepEqual(mergeEvidence.result, {
  ok: true,
  kind: "merged",
  expectedHeadSha: headSha,
  mergeSha,
  mergeMethod: "squash",
});

console.log("Declarative CLI grammar and exact public merge transport contract passed.");
