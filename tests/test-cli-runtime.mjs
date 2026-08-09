import assert from "node:assert/strict";
import { runCli } from "../src/repo-guard.mjs";

const originalError = console.error;
const errors = [];
console.error = (...args) => errors.push(args.join(" "));

try {
  const unknown = await runCli(["--definitely-unknown"]);
  assert.equal(unknown, 1);
  assert.match(errors.join("\n"), /Unknown option/);

  errors.length = 0;
  const missingRoot = await runCli(["--repo-root"]);
  assert.equal(missingRoot, 1);
  assert.match(errors.join("\n"), /--repo-root requires a path argument/);
} finally {
  console.error = originalError;
}

console.log("CLI runtime returns exit codes without terminating imported callers.");
