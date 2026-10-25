import assert from "node:assert/strict";
import * as publicRuntime from "../dist/repo-guard.mjs";
import { COMMANDS, runCli } from "../dist/repo-guard.mjs";

assert.deepEqual([...COMMANDS].sort(), ["validate", "check-diff", "check", "build", "init", "doctor"].sort());
for (const name of ["runTrustedService","reconcileAuthorityTarget","sameAuthorityEvaluationKey","verifyAuthorityWebhook","serviceEvaluatorEnvironment","runBoundedChild"]) {
  assert.equal(Object.hasOwn(publicRuntime, name), false, `obsolete external authority export must be absent: ${name}`);
}
const originalError = console.error, errors = [];
console.error = (...args) => errors.push(args.join(" "));
const cases = [
  [["--definitely-unknown"], /Unknown option/],
  [["--repo-root"], /--repo-root requires a path argument/],
  [["check-diff", "--base"], /--base requires a value/],
  [["check-diff", "--change-intent"], /--change-intent requires a value/],
  [["check-diff", "--contract", "legacy.json"], /Unknown option for check-diff/],
  [["check-pr", "extra"], /Unexpected argument for validate/],
  [["trusted-service", "--bogus"], /Unknown option for validate/],
  [["validate", "one.json", "two.json"], /Unexpected argument for validate/],
  [["init", "--bogus"], /Unknown option for init/],
];
try {
  for (const [args, pattern] of cases) {
    errors.length = 0;
    assert.equal(await runCli(args), 1);
    assert.match(errors.join("\n"), pattern);
  }
} finally { console.error = originalError; }
console.log("CLI runtime boundary passed");
