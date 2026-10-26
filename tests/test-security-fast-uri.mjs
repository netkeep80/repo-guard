import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const root = lock.packages?.[""];
const ajv = lock.packages?.["node_modules/ajv"];
const fastUri = lock.packages?.["node_modules/fast-uri"];

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
assert.ok(ajv, "ajv must remain a locked runtime dependency");
assert.ok(fastUri, "fast-uri must remain represented in the lockfile");
assert.equal(root.dependencies?.["fast-uri"], undefined,
  "fast-uri must stay transitive rather than becoming a direct dependency");
assert.equal(packageJson.dependencies?.["fast-uri"], undefined,
  "package.json must not gain a direct fast-uri dependency");
assert.equal(packageJson.overrides?.["fast-uri"], undefined,
  "package.json must not gain a fast-uri override");
assert.equal(ajv.version, "8.18.0");
assert.equal(ajv.dependencies?.["fast-uri"], "^3.0.1",
  "existing ajv dependency range must remain the source of fast-uri");
assert.equal(fastUri.version.split(".")[0], "3",
  "fast-uri must stay within the compatible 3.x line");
assert.ok(atLeast(fastUri.version, "3.1.9"),
  "fast-uri must not regress below the security floor 3.1.9");
assert.equal(fastUri.resolved,
  `https://registry.npmjs.org/fast-uri/-/fast-uri-${fastUri.version}.tgz`);
assert.match(fastUri.integrity, /^sha512-/);
console.log("Security fast-uri lock contract passed");
