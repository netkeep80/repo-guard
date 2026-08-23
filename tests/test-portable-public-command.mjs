import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePortableCoordinatorArgs,
  runPortableCoordinatorCommand,
} from "../dist/portable-integration/public-command.mjs";

const explicit = parsePortableCoordinatorArgs([
  "--repository", "netkeep80/example",
  "--ready-label", "repo-guard:ready",
  "--merge-method", "squash",
  "--transaction-check", "repo-guard / transaction",
  "--transaction-check", "build",
  "--transaction-check", "build",
  "--state-check", "repo-guard / state",
  "--state-check", "integration",
  "--format", "json",
], { GITHUB_REPOSITORY: "ignored/repository" });

assert.deepEqual(explicit, {
  ok: true,
  value: {
    repository: "netkeep80/example",
    readyLabel: "repo-guard:ready",
    mergeMethod: "squash",
    requiredChecks: {
      transaction: [{ name: "build" }, { name: "repo-guard / transaction" }],
      state: [{ name: "integration" }, { name: "repo-guard / state" }],
    },
    format: "json",
  },
});

const fromEnv = parsePortableCoordinatorArgs([
  "--ready-label", "ready",
  "--merge-method", "merge",
  "--transaction-check", "tx",
  "--state-check", "state",
], { GITHUB_REPOSITORY: "netkeep80/from-env" });
assert.equal(fromEnv.ok, true);
assert.equal(fromEnv.ok && fromEnv.value.repository, "netkeep80/from-env");
assert.equal(fromEnv.ok && fromEnv.value.format, "text");

for (const [label, args, env, error] of [
  ["missing repository", ["--ready-label", "ready", "--merge-method", "merge", "--transaction-check", "tx", "--state-check", "state"], {}, "missing_repository"],
  ["malformed repository", ["--repository", "not-a-repo", "--ready-label", "ready", "--merge-method", "merge", "--transaction-check", "tx", "--state-check", "state"], {}, "malformed_repository"],
  ["missing ready label", ["--repository", "netkeep80/example", "--merge-method", "merge", "--transaction-check", "tx", "--state-check", "state"], {}, "missing_ready_label"],
  ["invalid merge method", ["--repository", "netkeep80/example", "--ready-label", "ready", "--merge-method", "octopus", "--transaction-check", "tx", "--state-check", "state"], {}, "invalid_merge_method"],
  ["missing transaction checks", ["--repository", "netkeep80/example", "--ready-label", "ready", "--merge-method", "merge", "--state-check", "state"], {}, "missing_transaction_checks"],
  ["missing state checks", ["--repository", "netkeep80/example", "--ready-label", "ready", "--merge-method", "merge", "--transaction-check", "tx"], {}, "missing_state_checks"],
  ["invalid format", ["--repository", "netkeep80/example", "--ready-label", "ready", "--merge-method", "merge", "--transaction-check", "tx", "--state-check", "state", "--format", "yaml"], {}, "invalid_format"],
  ["unknown option", ["--repository", "netkeep80/example", "--ready-label", "ready", "--merge-method", "merge", "--transaction-check", "tx", "--state-check", "state", "--from-git-remote", "yes"], {}, "unknown_option"],
]) {
  const result = parsePortableCoordinatorArgs(args, env);
  assert.equal(result.ok, false, label);
  assert.equal(result.ok ? null : result.error, error, label);
}

const output = [];
let candidateReads = 0;
let mutations = 0;
const idleExit = await runPortableCoordinatorCommand(
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
    readReadyInventory: async () => ({ complete: true, pages: [[]] }),
    readCandidate: async () => { candidateReads++; throw new Error("idle runtime must not read a candidate"); },
    mutationTransport: {
      request: async () => { mutations++; throw new Error("idle runtime must not mutate"); },
    },
    writeOutput: (text) => output.push(text),
  },
);
assert.equal(idleExit, 0, "complete empty READY inventory is a successful idle pass");
assert.equal(candidateReads, 0, "idle runtime performs no candidate reads");
assert.equal(mutations, 0, "idle runtime performs no mutations");
assert.equal(output.length, 1, "idle runtime emits one deterministic evidence document");
assert.deepEqual(JSON.parse(output[0]), {
  provider: "portable",
  kind: "idle",
  repository: "netkeep80/example",
  main_sha: null,
  pr: null,
  head_sha: null,
  decision: null,
  reason: null,
  mutation: "none",
  result: null,
});

const runtimeCalls = [];
const runtimeOutput = [];
const runtimeIdleExit = await runPortableCoordinatorCommand(
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
    run: (command, args) => {
      runtimeCalls.push([command, args]);
      if (command === "gh" && args.join(" ") === "api repos/netkeep80/example/pulls?state=open&per_page=100 --paginate --slurp") {
        return "[[]]";
      }
      throw new Error(`unexpected runtime command: ${command} ${args.join(" ")}`);
    },
    writeOutput: (text) => runtimeOutput.push(text),
  },
);
assert.equal(runtimeIdleExit, 0, "injected GitHub runtime can complete an empty READY inventory pass");
assert.deepEqual(runtimeCalls, [[
  "gh",
  ["api", "repos/netkeep80/example/pulls?state=open&per_page=100", "--paginate", "--slurp"],
]], "injected GitHub runtime uses one complete read-only paginated PR inventory request");
assert.equal(JSON.parse(runtimeOutput[0]).kind, "idle");

const fakeGhDir = mkdtempSync(join(tmpdir(), "repo-guard-p4c-gh-"));
const fakeGhPath = join(fakeGhDir, "gh");
writeFileSync(fakeGhPath, `#!/usr/bin/env node
const expected = ["api", "repos/netkeep80/example/pulls?state=open&per_page=100", "--paginate", "--slurp"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(73);
process.stdout.write("[[]]");
`);
chmodSync(fakeGhPath, 0o755);
const originalPath = process.env.PATH;
const defaultOutput = [];
try {
  process.env.PATH = `${fakeGhDir}:${originalPath ?? ""}`;
  const defaultExit = await runPortableCoordinatorCommand(
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
    { writeOutput: (text) => defaultOutput.push(text) },
  );
  assert.equal(defaultExit, 0, "default runtime executes gh directly and completes an empty inventory pass");
  assert.equal(JSON.parse(defaultOutput[0]).kind, "idle");
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(fakeGhDir, { recursive: true, force: true });
}

console.log("Portable public coordinator trusted CLI parsing/runtime composition contract passed.");
