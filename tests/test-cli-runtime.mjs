import assert from "node:assert/strict";
import { runCli } from "../dist/repo-guard.mjs";

const originalError = console.error, errors = [];
console.error = (...args) => errors.push(args.join(" "));
const cases = [
  [["--definitely-unknown"], /Unknown option/], [["--repo-root"], /--repo-root requires a path argument/],
  [["check-diff", "--base"], /--base requires a value/], [["check-diff", "--change-intent"], /--change-intent requires a value/],
  [["check-diff", "--contract", "legacy.json"], /Unknown option for check-diff/], [["check-pr", "extra"], /Unexpected argument for check-pr/],
  [["validate", "one.json", "two.json"], /Unexpected argument for validate/], [["init", "--bogus"], /Unknown option for init/],
];
try {
  for (const [args, pattern] of cases) {
    errors.length = 0; assert.equal(await runCli(args), 1); assert.match(errors.join("\n"), pattern);
  }
} finally { console.error = originalError; }
console.log("Declarative CLI grammar returns errors without terminating imported callers.");
