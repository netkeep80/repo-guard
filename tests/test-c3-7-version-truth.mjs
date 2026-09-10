import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expectedTagForVersion } from "../scripts/verify-release-ref.mjs";

const root = resolve(".");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
);

assert.equal(packageJson.version, "3.0.0");
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages?.[""]?.version, packageJson.version);
assert.equal(expectedTagForVersion(packageJson.version), "v3.0.0");

for (const path of [
  "VERSION",
  "release-state.json",
  "target-version.json",
]) {
  assert.equal(existsSync(resolve(root, path)), false, path);
}

console.log("C3.7 canonical version truth contract passed");
