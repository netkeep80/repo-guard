import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lock = JSON.parse(
  readFileSync(resolve("package-lock.json"), "utf8"),
);
const packageJson = JSON.parse(
  readFileSync(resolve("package.json"), "utf8"),
);

const root = lock.packages?.[""];
const ajv = lock.packages?.["node_modules/ajv"];
const fastUri = lock.packages?.["node_modules/fast-uri"];

assert.ok(root, "package-lock root package must exist");
assert.ok(ajv, "ajv must remain a locked runtime dependency");
assert.ok(fastUri, "fast-uri must remain represented in the lockfile");

assert.equal(
  root.dependencies?.["fast-uri"],
  undefined,
  "fast-uri must stay transitive rather than becoming a direct dependency",
);
assert.equal(
  packageJson.dependencies?.["fast-uri"],
  undefined,
  "package.json must not gain a direct fast-uri dependency",
);
assert.equal(
  packageJson.overrides?.["fast-uri"],
  undefined,
  "package.json must not gain a fast-uri override",
);
assert.equal(
  ajv.dependencies?.["fast-uri"],
  "^3.0.1",
  "existing ajv dependency range must remain the source of fast-uri",
);
assert.equal(
  fastUri.version,
  "3.1.7",
  "fast-uri must resolve to the fully patched 3.x release",
);
assert.equal(
  fastUri.resolved,
  "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.7.tgz",
);
assert.equal(
  fastUri.integrity,
  "sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg==",
);

console.log("Security fast-uri lock contract passed");
