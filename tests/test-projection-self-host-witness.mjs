import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeProjectionModel,
  projectionModelIdentity,
} from "../dist/projection-model.mjs";
import { analyzeProjection } from "../dist/projection-analysis.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const readBytes = (path) => readFileSync(resolve(root, path));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const packageJson = JSON.parse(readBytes("package.json").toString("utf8"));
const tsconfig = JSON.parse(readBytes("tsconfig.json").toString("utf8"));
const lock = JSON.parse(readBytes("package-lock.json").toString("utf8"));

assert.equal(packageJson.scripts.build, "node scripts/build.mjs");
assert.equal(packageJson.scripts["check:dist"], "node scripts/check-dist.mjs");
assert.equal(tsconfig.compilerOptions.rootDir, "src");
assert.equal(tsconfig.compilerOptions.outDir, "dist");

const typescriptVersion = lock.packages?.["node_modules/typescript"]?.version;
assert.equal(typeof typescriptVersion, "string");
assert.ok(typescriptVersion.length > 0);

const model = normalizeProjectionModel({
  schema: "repo-guard/projection-model/v0",
  id: "projection.repo-guard.projection-analysis-dist",
  sources: [
    {
      id: "analysis-source",
      kind: "repository_content",
      path: "src/projection-analysis.mts",
      algorithm: "sha256",
    },
    {
      id: "build-script",
      kind: "repository_content",
      path: "scripts/build.mjs",
      algorithm: "sha256",
    },
    {
      id: "compiler-config",
      kind: "repository_content",
      path: "tsconfig.json",
      algorithm: "sha256",
    },
    {
      id: "compiler-lock",
      kind: "repository_content",
      path: "package-lock.json",
      algorithm: "sha256",
    },
  ],
  target: {
    path: "dist/projection-analysis.mjs",
    ownership: "generated",
  },
  generator: {
    contract_id: "repo-guard-typescript-build/v1",
  },
  required_evidence: [],
});

const build = {
  schema: "repo-guard/projection-build-record/v0",
  projection_id: model.id,
  model_identity: projectionModelIdentity(model),
  source_identities: model.sources.map((source) => ({
    source_id: source.id,
    algorithm: "sha256",
    digest: sha256(readBytes(source.path)),
  })),
  generator: {
    contract_id: model.generator.contract_id,
    tool_identity: `typescript@${typescriptVersion}`,
  },
  configuration_digest: sha256(readBytes("tsconfig.json")),
  output_identity: {
    algorithm: "sha256",
    digest: sha256(readBytes(model.target.path)),
  },
  evidence: [],
};

function diffFile(path) {
  return {
    path,
    status: "modified",
    addedLines: ["changed"],
    deletedLines: ["old"],
  };
}

function context(overrides = new Map(), changed = []) {
  return {
    readFile: (path) => overrides.has(path) ? overrides.get(path) : readBytes(path),
    diff: {
      files: {
        checked: changed,
      },
    },
  };
}

assert.deepEqual(
  analyzeProjection(model, build, context()),
  {
    projection_id: model.id,
    freshness: "CURRENT",
    impact: "UNAFFECTED",
    failed_relations: [],
    affected_sources: [],
  },
  "the actual checked-in projection-analysis dist artifact must be CURRENT",
);

const changedSource = Buffer.concat([
  readBytes("src/projection-analysis.mts"),
  Buffer.from("\n// hypothetical source drift\n", "utf8"),
]);
assert.deepEqual(
  analyzeProjection(
    model,
    build,
    context(
      new Map([["src/projection-analysis.mts", changedSource]]),
      [diffFile("src/projection-analysis.mts")],
    ),
  ),
  {
    projection_id: model.id,
    freshness: "STALE",
    impact: "AFFECTED",
    failed_relations: [`${model.id}:source:analysis-source`],
    affected_sources: ["analysis-source"],
  },
  "real self-host source drift must become STALE + AFFECTED without rebuilding",
);

const changedTarget = Buffer.concat([
  readBytes("dist/projection-analysis.mjs"),
  Buffer.from("\n// hypothetical manual dist edit\n", "utf8"),
]);
assert.deepEqual(
  analyzeProjection(
    model,
    build,
    context(
      new Map([["dist/projection-analysis.mjs", changedTarget]]),
      [diffFile("dist/projection-analysis.mjs")],
    ),
  ),
  {
    projection_id: model.id,
    freshness: "BROKEN",
    impact: "UNAFFECTED",
    failed_relations: [`${model.id}:target`],
    affected_sources: [],
  },
  "manual drift of the real generated dist artifact must be BROKEN",
);

console.log("Projection self-host witness passed.");
