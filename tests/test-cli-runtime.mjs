import assert from "node:assert/strict";
import { COMMANDS, runCli } from "../dist/repo-guard.mjs";

assert.deepEqual([...COMMANDS].sort(), ["build", "check"]);

const originalError = console.error;
const errors = [];
console.error = (...args) => errors.push(args.join(" "));
try {
  for (const args of [
    [],
    ["validate"],
    ["check-diff"],
    ["doctor"],
    ["init"],
    ["--definitely-unknown"],
    ["--repo-root"],
    ["check", "--base"],
    ["check", "--bogus"],
    ["build", "--bogus"],
  ]) {
    const code = await runCli(args);
    assert.equal(code, 1, `expected failure for ${JSON.stringify(args)}`);
  }
} finally {
  console.error = originalError;
}
assert.ok(errors.every((line) => line.startsWith("ERROR:")));
console.log("CLI exposes only check/build and rejects retired policy commands");
