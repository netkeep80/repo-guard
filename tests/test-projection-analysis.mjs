import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeProjectionModel,
  projectionModelIdentity,
} from "../dist/projection-model.mjs";
import { analyzeProjection } from "../dist/projection-analysis.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const sourceV1 = "claim: alpha\n";
const sourceV2 = "claim: beta\n";
const contractV1 = "contract: stable\n";
const targetV1 = "# Derived\nalpha\n";

const model = normalizeProjectionModel({
  schema: "repo-guard/projection-model/v0",
  id: "projection.analysis.demo",
  sources: [
    {
      id: "claims",
      kind: "repository_content",
      path: "model/claims.txt",
      algorithm: "sha256",
    },
    {
      id: "contract",
      kind: "repository_content",
      path: "model/contract.txt",
      algorithm: "sha256",
    },
  ],
  target: {
    path: "derived/output.md",
    ownership: "generated",
  },
  generator: {
    contract_id: "demo-generator/v1",
  },
  required_evidence: ["generator-ci"],
});

const build = {
  schema: "repo-guard/projection-build-record/v0",
  projection_id: model.id,
  model_identity: projectionModelIdentity(model),
  source_identities: [
    { source_id: "claims", algorithm: "sha256", digest: sha256(sourceV1) },
    { source_id: "contract", algorithm: "sha256", digest: sha256(contractV1) },
  ],
  generator: {
    contract_id: "demo-generator/v1",
    tool_identity: "demo-generator@accepted",
  },
  configuration_digest: sha256("profile:v1\n"),
  output_identity: {
    algorithm: "sha256",
    digest: sha256(targetV1),
  },
  evidence: [
    { class: "generator-ci", ref: "ci:generator:123" },
  ],
};

function diffFile(path, status = "modified", previousPath) {
  return {
    path,
    ...(previousPath ? { previousPath } : {}),
    status,
    addedLines: ["changed"],
    deletedLines: ["old"],
  };
}

function context(files, changed = []) {
  return {
    readFile: (path) => {
      if (!files.has(path)) throw new Error(`missing fixture file: ${path}`);
      return files.get(path);
    },
    diff: {
      files: {
        checked: changed,
      },
    },
  };
}

const currentFiles = new Map([
  ["model/claims.txt", sourceV1],
  ["model/contract.txt", contractV1],
  ["derived/output.md", targetV1],
  ["notes/unrelated.txt", "note\n"],
]);

assert.deepEqual(
  analyzeProjection(model, build, context(currentFiles, [diffFile("notes/unrelated.txt")])),
  {
    projection_id: model.id,
    freshness: "CURRENT",
    impact: "UNAFFECTED",
    failed_relations: [],
    affected_sources: [],
  },
  "unrelated change keeps projection CURRENT and UNAFFECTED",
);

const staleFiles = new Map(currentFiles);
staleFiles.set("model/claims.txt", sourceV2);
assert.deepEqual(
  analyzeProjection(model, build, context(staleFiles, [diffFile("model/claims.txt")])),
  {
    projection_id: model.id,
    freshness: "STALE",
    impact: "AFFECTED",
    failed_relations: [`${model.id}:source:claims`],
    affected_sources: ["claims"],
  },
  "changed declared source with old BuildRecord is STALE + AFFECTED",
);

assert.deepEqual(
  analyzeProjection(model, build, context(staleFiles, [diffFile("notes/unrelated.txt")])),
  {
    projection_id: model.id,
    freshness: "STALE",
    impact: "UNAFFECTED",
    failed_relations: [`${model.id}:source:claims`],
    affected_sources: [],
  },
  "freshness and current-transaction impact are independent axes",
);

const editedTarget = new Map(currentFiles);
editedTarget.set("derived/output.md", "# manual edit\n");
assert.deepEqual(
  analyzeProjection(model, build, context(editedTarget, [diffFile("derived/output.md")])),
  {
    projection_id: model.id,
    freshness: "BROKEN",
    impact: "UNAFFECTED",
    failed_relations: [`${model.id}:target`],
    affected_sources: [],
  },
  "manual target drift is BROKEN but does not make the source dependency graph AFFECTED",
);

assert.deepEqual(
  analyzeProjection(
    model,
    {
      ...build,
      source_identities: build.source_identities.map((identity) =>
        identity.source_id === "claims"
          ? { ...identity, digest: sha256("forged\n") }
          : identity
      ),
    },
    context(currentFiles),
  ),
  {
    projection_id: model.id,
    freshness: "STALE",
    impact: "UNAFFECTED",
    failed_relations: [`${model.id}:source:claims`],
    affected_sources: [],
  },
  "forged source identity fails freshness without inventing current-transaction impact",
);

const missingSource = new Map(currentFiles);
missingSource.delete("model/claims.txt");
assert.deepEqual(
  analyzeProjection(model, build, context(missingSource, [diffFile("model/claims.txt", "deleted")])),
  {
    projection_id: model.id,
    freshness: "BROKEN",
    impact: "AFFECTED",
    failed_relations: [`${model.id}:source:claims`],
    affected_sources: ["claims"],
  },
  "missing declared source is BROKEN and a deletion of that source is AFFECTED",
);

assert.deepEqual(
  analyzeProjection(
    model,
    build,
    context(currentFiles, [
      diffFile("model/claims-renamed.txt", "modified", "model/claims.txt"),
    ]),
  ),
  {
    projection_id: model.id,
    freshness: "CURRENT",
    impact: "AFFECTED",
    failed_relations: [],
    affected_sources: ["claims"],
  },
  "rename previous-path identity must affect the declared source dependency",
);

const brokenRecord = { ...build, model_identity: "f".repeat(64) };
assert.deepEqual(
  analyzeProjection(model, brokenRecord, context(currentFiles, [diffFile("model/claims.txt")])),
  {
    projection_id: model.id,
    freshness: "BROKEN",
    impact: "AFFECTED",
    failed_relations: [],
    affected_sources: ["claims"],
  },
  "invalid BuildRecord fails closed while impact still comes from the valid accepted model",
);

const malformedModel = { ...model, sources: [] };
const malformedResult = analyzeProjection(malformedModel, build, context(currentFiles));
assert.equal(malformedResult.freshness, "BROKEN");
assert.equal(malformedResult.projection_id, null);
assert.equal(
  Object.hasOwn(malformedResult, "impact"),
  false,
  "impact is omitted when the ProjectionModel itself cannot define a dependency surface",
);

assert.throws(
  () => analyzeProjection(model, build, { readFile: context(currentFiles).readFile }),
  /diff facts are unavailable|impact.*unavailable/i,
  "P7 analysis requires explicit transaction diff evidence rather than guessing UNAFFECTED",
);

console.log("Projection freshness/impact analysis contract passed.");
