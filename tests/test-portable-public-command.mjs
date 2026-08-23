import assert from "node:assert/strict";
import {
  parsePortableCoordinatorArgs,
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

console.log("Portable public coordinator trusted CLI parsing contract passed.");
