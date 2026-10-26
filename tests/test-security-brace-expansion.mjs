import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const root = lock.packages?.[""];
const minimatch = lock.packages?.["node_modules/minimatch"];
const braceExpansion = lock.packages?.["node_modules/brace-expansion"];

const atLeast = (version, floor) => {
  const parse = (value) => value.split(".").map((part) => Number(part));
  const a = parse(version), b = parse(floor);
  assert.equal(a.length, 3);
  assert.equal(b.length, 3);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
};

assert.ok(root, "package-lock root package must exist");
assert.ok(minimatch, "minimatch must remain a locked runtime dependency");
assert.ok(braceExpansion, "brace-expansion must remain represented in the lockfile");
assert.equal(root.dependencies?.["brace-expansion"], undefined,
  "brace-expansion must stay transitive rather than becoming a direct dependency");
assert.equal(packageJson.dependencies?.["brace-expansion"], undefined,
  "package.json must not gain a direct brace-expansion dependency");
assert.equal(packageJson.overrides?.["brace-expansion"], undefined,
  "package.json must not gain a brace-expansion override");
assert.equal(minimatch.version, "10.2.5");
assert.equal(minimatch.dependencies?.["brace-expansion"], "^5.0.5",
  "existing minimatch dependency range must remain the source of brace-expansion");
assert.equal(braceExpansion.version.split(".")[0], "5",
  "brace-expansion must stay within the compatible 5.x line");
assert.ok(atLeast(braceExpansion.version, "5.0.12"),
  "brace-expansion must not regress below the security floor 5.0.12");
assert.equal(braceExpansion.resolved,
  `https://registry.npmjs.org/brace-expansion/-/brace-expansion-${braceExpansion.version}.tgz`);
assert.match(braceExpansion.integrity, /^sha512-/);
console.log("Security brace-expansion lock contract passed");
