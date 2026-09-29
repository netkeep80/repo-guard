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

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const parserSourcePath = "src/markdown-parser.mts";
const tsconfigPath = "tsconfig.json";
const packagePath = "package.json";
const parserTargetPath = "dist/markdown-parser.mjs";

const parserSource = read(parserSourcePath);
const tsconfig = read(tsconfigPath);
const packageText = read(packagePath);
const parserTarget = read(parserTargetPath);
const packageJson = JSON.parse(packageText);

const model = normalizeProjectionModel({
  schema: "repo-guard/projection-model/v0",
  id: "projection.repo-guard.markdown-parser-dist",
  sources: [
    {
      id: "parser-source",
      kind: "repository_content",
      path: parserSourcePath,
      algorithm: "sha256",
    },
    {
      id: "tsconfig",
      kind: "repository_content",
      path: tsconfigPath,
      algorithm: "sha256",
    },
    {
      id: "typescript-version",
      kind: "repository_content",
      path: packagePath,
      algorithm: "sha256",
    },
  ],
  target: {
    path: parserTargetPath,
    ownership: "generated",
  },
  generator: {
    contract_id: "repo-guard-typescript-build/v1",
  },
  required_evidence: ["check-dist"],
});

const build = {
  schema: "repo-guard/projection-build-record/v0",
  projection_id: model.id,
  model_identity: projectionModelIdentity(model),
  source_identities: model.sources.map((source) => ({
    source_id: source.id,
    algorithm: "sha256",
    digest: sha256(read(source.path)),
  })),
  generator: {
    contract_id: model.generator.contract_id,
    tool_identity: `typescript@${packageJson.devDependencies.typescript}`,
  },
  configuration_digest: sha256(tsconfig),
  output_identity: {
    algorithm: "sha256",
    digest: sha256(parserTarget),
  },
  evidence: [
    {
      class: "check-dist",
      ref: "npm-script:check:dist",
    },
  ],
};

function diffFile(path, status = "modified") {
  return {
    path,
    status,
    addedLines: ["changed"],
    deletedLines: ["old"],
  };
}

function context(overrides = new Map(), changed = []) {
  return {
    readFile: (path) => overrides.has(path) ? overrides.get(path) : read(path),
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
  "repo-guard must verify one real generated projection of its own accepted source tree",
);

const staleSource = new Map([
  [parserSourcePath, parserSource + "\n// simulated unbuilt source change\n"],
]);
assert.deepEqual(
  analyzeProjection(model, build, context(staleSource, [diffFile(parserSourcePath)])),
  {
    projection_id: model.id,
    freshness: "STALE",
    impact: "AFFECTED",
    failed_relations: [`${model.id}:source:parser-source`],
    affected_sources: ["parser-source"],
  },
  "real self-host source drift must be detected without running TypeScript",
);

assert.deepEqual(
  analyzeProjection(model, build, context(new Map(), [diffFile("README.md")])),
  {
    projection_id: model.id,
    freshness: "CURRENT",
    impact: "UNAFFECTED",
    failed_relations: [],
    affected_sources: [],
  },
  "unrelated repository change must not affect the self-host projection",
);

const editedTarget = new Map([
  [parserTargetPath, parserTarget + "\n// simulated manual dist edit\n"],
]);
assert.deepEqual(
  analyzeProjection(model, build, context(editedTarget, [diffFile(parserTargetPath)])),
  {
    projection_id: model.id,
    freshness: "BROKEN",
    impact: "UNAFFECTED",
    failed_relations: [`${model.id}:target`],
    affected_sources: [],
  },
  "manual derived-target drift must fail closed without invoking the generator",
);

assert.equal(
  Object.values(model).some((value) => typeof value === "function"),
  false,
  "self-host ProjectionModel carries no executable generator authority",
);

console.log(
  `Projection self-host witness passed: ${model.id} CURRENT; source drift STALE; target drift BROKEN`,
);
