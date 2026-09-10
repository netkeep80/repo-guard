import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lock = JSON.parse(
  readFileSync(resolve("package-lock.json"), "utf8"),
);

const root = lock.packages?.[""];
const minimatch = lock.packages?.["node_modules/minimatch"];
const braceExpansion = lock.packages?.["node_modules/brace-expansion"];

assert.ok(root, "package-lock root package must exist");
assert.ok(minimatch, "minimatch must remain a locked runtime dependency");
assert.ok(braceExpansion, "brace-expansion must remain represented in the lockfile");

assert.equal(
  root.dependencies?.["brace-expansion"],
  undefined,
  "brace-expansion must stay transitive rather than becoming a direct dependency",
);
assert.equal(
  minimatch.dependencies?.["brace-expansion"],
  "^5.0.5",
  "existing minimatch dependency range must remain the source of brace-expansion",
);
assert.equal(
  braceExpansion.version,
  "5.0.9",
  "brace-expansion must resolve to the fully patched 5.x release",
);
assert.equal(
  braceExpansion.resolved,
  "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
);
assert.equal(
  braceExpansion.integrity,
  "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
);

console.log("Security brace-expansion lock contract passed");
