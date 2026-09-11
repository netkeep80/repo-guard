import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../dist/repo-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

console.log("\n--- superseded branch-hygiene island stays absent ---");
for (const path of [
  "src/branch-hygiene.mts",
  "dist/branch-hygiene.mjs",
  "docs/branch-hygiene.md",
  "tests/test-branch-hygiene-analysis.mjs",
]) {
  assert.equal(existsSync(resolve(root, path)), false, `${path} must remain absent from the final product tree`);
}

console.log("\n--- final public CLI surface remains unchanged ---");
assert.deepEqual(
  [...COMMANDS].sort(),
  ["validate", "check-diff", "check-pr", "init", "doctor"].sort(),
);

console.log("C3.9i branch-hygiene purge ratchet passed.");
