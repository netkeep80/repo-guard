import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaTest = readFileSync(resolve(root, "tests/validate-schemas.mjs"), "utf-8");

console.log("\n--- standalone size-rules example stays absent ---");
assert.equal(
  existsSync(resolve(root, "examples/size-rules-policy.json")),
  false,
  "examples/size-rules-policy.json must not remain as a second hand-maintained example authority",
);
assert.equal(
  schemaTest.includes("examples/size-rules-policy.json"),
  false,
  "schema tests must not depend on the removed standalone example fixture",
);

console.log("\n--- canonical size-rule schema coverage remains ---");
assert.equal(
  schemaTest.includes('expect("valid size rule"'),
  true,
  "inline positive size-rule schema coverage must remain",
);
assert.equal(
  schemaTest.includes('expect("invalid size metric"'),
  true,
  "inline negative size-rule schema coverage must remain",
);

console.log("C3.9i standalone example purge ratchet passed.");
