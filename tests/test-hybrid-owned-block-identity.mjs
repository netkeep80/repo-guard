import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFact } from "../dist/document-facts.mjs";
import { readOwnedMarkdownBlock } from "../dist/markdown-structure.mjs";
import {
  normalizeProjectionModel,
  projectionModelIdentity,
} from "../dist/projection-model.mjs";
import { lowerProjectionVerification } from "../dist/projection-lowering.mjs";
import { evaluatePrimitiveRelation } from "../dist/checks/relation-kernel.mjs";
import { analyzeProjection } from "../dist/projection-analysis.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const begin = "<!-- consumer:generated-summary:begin -->";
const end = "<!-- consumer:generated-summary:end -->";
const blockSpec = {
  blockId: "generated-summary",
  beginMarker: begin,
  endMarker: end,
};
const region = {
  kind: "markdown_owned_block",
  anchor_id: "projection-node",
  block_id: "generated-summary",
  begin_marker: begin,
  end_marker: end,
};

const sourceV1 = "claim: alpha\n";
const markdown = [
  '<a id="projection-node"></a>',
  "## Projection node",
  "Authored before.",
  begin,
  "> generated v1",
  end,
  "Authored after.",
  "",
  '<a id="other-node"></a>',
  "## Other node",
  "Other authored bytes.",
].join("\n") + "\n";

const owned = readOwnedMarkdownBlock(markdown, blockSpec);
assert.ok(owned, "existing generic MDDB must resolve the owned block fixture");
const ownedDigest = sha256(owned.content);
assert.notEqual(
  ownedDigest,
  sha256(markdown),
  "HYBRID output identity must not collapse to whole-file identity",
);

const model = normalizeProjectionModel({
  schema: "repo-guard/projection-model/v0",
  id: "projection.hybrid.demo",
  sources: [
    {
      id: "claims",
      kind: "repository_content",
      path: "model/claims.txt",
      algorithm: "sha256",
    },
  ],
  target: {
    path: "README.md",
    ownership: "hybrid",
    locator: region,
  },
  generator: {
    contract_id: "demo-generator/v1",
  },
  required_evidence: ["generator-ci"],
});

assert.equal(model.target.locator.kind, "markdown_owned_block");
assert.equal(model.target.locator.anchor_id, "projection-node");
assert.equal(model.target.locator.block_id, "generated-summary");

const build = {
  schema: "repo-guard/projection-build-record/v0",
  projection_id: model.id,
  model_identity: projectionModelIdentity(model),
  source_identities: [
    { source_id: "claims", algorithm: "sha256", digest: sha256(sourceV1) },
  ],
  generator: {
    contract_id: "demo-generator/v1",
    tool_identity: "demo-generator@accepted",
  },
  configuration_digest: sha256("profile:v1\n"),
  output_identity: {
    algorithm: "sha256",
    digest: ownedDigest,
  },
  evidence: [
    { class: "generator-ci", ref: "ci:generator:123" },
  ],
};

const regionalFact = {
  source: "repository",
  selector: {
    kind: "content_identity",
    path: "README.md",
    snapshot: "state",
    algorithm: "sha256",
    region,
  },
  type: "scalar",
};

function context(readme = markdown, source = sourceV1, changed = []) {
  const files = new Map([
    ["README.md", readme],
    ["model/claims.txt", source],
  ]);
  return {
    readFile: (path) => {
      if (!files.has(path)) throw new Error(`missing fixture file: ${path}`);
      return files.get(path);
    },
    diff: { files: { checked: changed } },
  };
}

const identity = readFact(context(), regionalFact);
assert.deepEqual(identity, { ok: true, value: ownedDigest });

const outsideChanged = markdown.replace("Authored after.", "Authored after changed.");
assert.deepEqual(
  readFact(context(outsideChanged), regionalFact),
  { ok: true, value: ownedDigest },
  "authored bytes outside the owned region must not stale a HYBRID projection",
);

const generatedChanged = markdown.replace("> generated v1", "> generated v2");
const changedIdentity = readFact(context(generatedChanged), regionalFact);
assert.equal(changedIdentity.ok, true);
assert.notEqual(changedIdentity.value, ownedDigest);

const movedBlock = [
  '<a id="projection-node"></a>',
  "## Projection node",
  "Authored A only.",
  "",
  '<a id="other-node"></a>',
  "## Other node",
  begin,
  "> generated v1",
  end,
].join("\n") + "\n";
const movedIdentity = readFact(context(movedBlock), regionalFact);
assert.equal(movedIdentity.ok, false, "owned block must be structurally bound to its declared anchor/node");

const relations = lowerProjectionVerification(model, build);
assert.deepEqual(
  relations.map((relation) => relation.primitive),
  ["scalar_equals_literal", "scalar_equals_literal"],
  "HYBRID verification still lowers only to the existing scalar relation",
);
const targetRelation = relations.find((relation) => relation.parameters.projection_role === "target");
assert.ok(targetRelation);
assert.deepEqual(
  targetRelation.operands.source.selector.region,
  region,
  "HYBRID lowering must preserve the exact address-local region in the existing content_identity fact",
);
assert.ok(relations.every((relation) => evaluatePrimitiveRelation(context(), relation).ok));

assert.deepEqual(
  analyzeProjection(model, build, context(markdown, sourceV1, [])),
  {
    projection_id: model.id,
    freshness: "CURRENT",
    impact: "UNAFFECTED",
    failed_relations: [],
    affected_sources: [],
  },
);

assert.deepEqual(
  analyzeProjection(
    model,
    build,
    context(
      outsideChanged,
      sourceV1,
      [{ path: "README.md", status: "modified", addedLines: ["authored"], deletedLines: ["authored"] }],
    ),
  ),
  {
    projection_id: model.id,
    freshness: "CURRENT",
    impact: "UNAFFECTED",
    failed_relations: [],
    affected_sources: [],
  },
  "manual authored edits outside an owned block are allowed for HYBRID ownership",
);

assert.deepEqual(
  analyzeProjection(
    model,
    build,
    context(
      generatedChanged,
      sourceV1,
      [{ path: "README.md", status: "modified", addedLines: ["generated"], deletedLines: ["generated"] }],
    ),
  ),
  {
    projection_id: model.id,
    freshness: "BROKEN",
    impact: "UNAFFECTED",
    failed_relations: [`${model.id}:target`],
    affected_sources: [],
  },
  "owned generated bytes that disagree with the BuildRecord must be BROKEN",
);

assert.throws(
  () => normalizeProjectionModel({
    ...model,
    target: {
      path: "README.md",
      ownership: "hybrid",
      locator: {
        ...region,
        begin_marker: "same",
        end_marker: "same",
      },
    },
  }),
  /markers.*distinct|distinct.*markers/i,
);

assert.throws(
  () => normalizeProjectionModel({
    ...model,
    target: {
      path: "README.md",
      ownership: "generated",
      locator: region,
    },
  }),
  /generated.*locator|locator.*generated/i,
);

console.log("HYBRID owned-block identity contract passed.");
