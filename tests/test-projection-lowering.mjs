import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeProjectionBuildRecord,
  normalizeProjectionModel,
  projectionModelIdentity,
} from "../dist/projection-model.mjs";
import { lowerProjectionVerification } from "../dist/projection-lowering.mjs";
import { evaluatePrimitiveRelation } from "../dist/checks/relation-kernel.mjs";
import { checkGovernanceChangeAuthorization } from "../dist/checks/rules/governance-paths.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const sourceA = "claim: alpha\n";
const sourceB = "contract: beta\n";
const target = "# Generated projection\nalpha beta\n";

const generatedModel = normalizeProjectionModel({
  schema: "repo-guard/projection-model/v0",
  id: "projection.generated.demo",
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
  required_evidence: ["external-generator-ci"],
});

const generatedBuild = normalizeProjectionBuildRecord({
  schema: "repo-guard/projection-build-record/v0",
  projection_id: generatedModel.id,
  model_identity: projectionModelIdentity(generatedModel),
  source_identities: [
    { source_id: "claims", algorithm: "sha256", digest: sha256(sourceA) },
    { source_id: "contract", algorithm: "sha256", digest: sha256(sourceB) },
  ],
  generator: {
    contract_id: generatedModel.generator.contract_id,
    tool_identity: "demo-generator@0123456789abcdef",
  },
  configuration_digest: sha256("profile:v1\n"),
  output_identity: {
    algorithm: "sha256",
    digest: sha256(target),
  },
  evidence: [
    { class: "external-generator-ci", ref: "ci:generator:123" },
  ],
}, generatedModel);

const relations = lowerProjectionVerification(generatedModel, generatedBuild);

assert.equal(relations.length, 3, "two sources + one generated target must lower to three finite relations");
assert.deepEqual(
  relations.map((relation) => relation.primitive),
  ["scalar_equals_literal", "scalar_equals_literal", "scalar_equals_literal"],
  "projection lowering must reuse the existing scalar relation only",
);
assert.ok(
  relations.every((relation) => relation.operands.source.source === "repository"),
  "projection lowering must reuse the existing repository FactRef source",
);
assert.ok(
  relations.every((relation) => relation.operands.source.selector.kind === "content_identity"),
  "projection lowering must use the existing bounded content_identity fact",
);

const files = new Map([
  ["model/claims.txt", sourceA],
  ["model/contract.txt", sourceB],
  ["derived/output.md", target],
  ["unrelated.txt", "outside projection dependencies\n"],
]);
const facts = {
  readFile: (path) => {
    if (!files.has(path)) throw new Error(`missing fixture file: ${path}`);
    return files.get(path);
  },
};

for (const relation of relations) {
  const result = evaluatePrimitiveRelation(facts, relation);
  assert.equal(result.ok, true, `current projection relation must pass: ${relation.relation_id}`);
}

const staleFacts = {
  ...facts,
  readFile: (path) => path === "model/claims.txt" ? "claim: changed\n" : facts.readFile(path),
};
const staleResults = relations.map((relation) => ({
  id: relation.relation_id,
  result: evaluatePrimitiveRelation(staleFacts, relation),
}));
assert.equal(staleResults.filter((x) => !x.result.ok).length, 1);
assert.match(staleResults.find((x) => !x.result.ok).id, /source:claims$/);

const targetFacts = {
  ...facts,
  readFile: (path) => path === "derived/output.md" ? "# manual edit\n" : facts.readFile(path),
};
const targetResults = relations.map((relation) => ({
  id: relation.relation_id,
  result: evaluatePrimitiveRelation(targetFacts, relation),
}));
assert.equal(targetResults.filter((x) => !x.result.ok).length, 1);
assert.match(targetResults.find((x) => !x.result.ok).id, /target$/);

const unrelatedFacts = {
  ...facts,
  readFile: (path) => path === "unrelated.txt" ? "changed unrelated bytes\n" : facts.readFile(path),
};
assert.ok(
  relations.every((relation) => evaluatePrimitiveRelation(unrelatedFacts, relation).ok),
  "unrelated repository changes must not affect lowered projection relations",
);

const hybridModel = normalizeProjectionModel({
  ...generatedModel,
  id: "projection.hybrid.demo",
  target: {
    path: "README.md",
    ownership: "hybrid",
    locator: {
      kind: "markdown_anchor",
      anchor_id: "projection-demo",
    },
  },
});
const hybridBuild = normalizeProjectionBuildRecord({
  ...generatedBuild,
  projection_id: hybridModel.id,
  model_identity: projectionModelIdentity(hybridModel),
  output_identity: {
    algorithm: "sha256",
    digest: sha256("# whole README is deliberately too broad\n"),
  },
}, hybridModel);

assert.throws(
  () => lowerProjectionVerification(hybridModel, hybridBuild),
  /hybrid.*address-local identity|address-local identity.*hybrid/i,
  "HYBRID output must fail closed rather than incorrectly lower to whole-file identity",
);

const projectionManifestPath = "repo-projections.json";
const changedProjectionModel = {
  path: projectionManifestPath,
  status: "modified",
  addedLines: ["+candidate narrows dependencies"],
  deletedLines: ["-accepted dependency"],
};
const denied = checkGovernanceChangeAuthorization({
  files: [changedProjectionModel],
  governancePaths: [projectionManifestPath],
});
assert.equal(denied.ok, false, "existing governance boundary blocks candidate ProjectionModel self-weakening");

const allowed = checkGovernanceChangeAuthorization({
  files: [changedProjectionModel],
  governancePaths: [projectionManifestPath],
  governanceGrant: { authorized_governance_paths: [projectionManifestPath] },
  trustedAuthorizer: {
    trusted: true,
    source: "repository_permission",
    reason: "trusted_permission",
  },
});
assert.equal(allowed.ok, true, "existing GovernanceGrant machinery is sufficient when independently authorized");

console.log("Projection lowering/authority boundary passed.");
