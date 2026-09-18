import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const narrative = "docs/self-hosting-coverage.md";
const exceptions = "docs/self-hosting-coverage.json";
const readme = readFileSync("README.md", "utf8");

assert.equal(
  existsSync(narrative),
  false,
  "duplicate self-hosting narrative inventory must not ship as current product documentation",
);
assert.equal(existsSync(exceptions), true, "self-hosting JSON exceptions authority must remain");
assert.doesNotMatch(readme, /docs\/self-hosting-coverage\.md/);
assert.match(readme, /docs\/self-hosting-coverage\.json/);
assert.match(readme, /tests\/test-c3-4b-self-host-exemplar\.mjs/);

console.log("C3.9e ratchet: self-hosting authority is executable proof plus JSON exceptions only.");
