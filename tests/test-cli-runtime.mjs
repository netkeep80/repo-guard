import assert from "node:assert/strict";
import { runCli } from "../src/repo-guard.mjs";

const originalError = console.error;
const errors = [];
console.error = (...args) => errors.push(args.join(" "));

async function fails(args, pattern) {
  errors.length = 0;
  assert.equal(await runCli(args), 1);
  assert.match(errors.join("\n"), pattern);
}

try {
  await fails(["--definitely-unknown"], /Unknown option/);
  await fails(["--repo-root"], /--repo-root requires a path argument/);
  await fails(["check-diff", "--base"], /--base requires a value/);
  await fails(["check-pr", "extra"], /Unexpected argument for check-pr/);
  await fails(["validate", "one.json", "two.json"], /Unexpected argument for validate/);
  await fails(["init", "--bogus"], /Unknown option for init/);
} finally {
  console.error = originalError;
}

console.log("Declarative CLI grammar returns errors without terminating imported callers.");
