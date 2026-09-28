import assert from "node:assert/strict";
import {
  normalizeProjectionModel,
  normalizeProjectionBuildRecord,
  projectionModelIdentity,
} from "../dist/projection-model.mjs";

const hex = (char) => char.repeat(64);

const modelInput = {
  schema: "repo-guard/projection-model/v0",
  id: "projection.intro.canonical",
  sources: [
    {
      id: "contract",
      kind: "repository_content",
      path: "contracts/mts-contract-v0.14.json",
      algorithm: "sha256",
    },
    {
      id: "claims",
      kind: "repository_content",
      path: "requirements/mts-v0.14.json",
      algorithm: "sha256",
    },
  ],
  target: {
    path: "outreach/introduction.md",
    ownership: "hybrid",
    locator: {
      kind: "markdown_anchor",
      anchor_id: "intro-foundation-root",
    },
  },
  generator: {
    contract_id: "introduction-compiler/v1",
  },
  required_evidence: [
    "projection-differential",
    "editorial-qa",
  ],
};

const model = normalizeProjectionModel(modelInput);

assert.deepEqual(
  model.sources.map((x) => x.id),
  ["claims", "contract"],
  "source dependency ordering must be canonical and deterministic",
);
assert.deepEqual(
  model.required_evidence,
  ["editorial-qa", "projection-differential"],
  "required evidence classes are a deterministic set",
);
assert.deepEqual(model.target, {
  path: "outreach/introduction.md",
  ownership: "hybrid",
  locator: {
    kind: "markdown_anchor",
    anchor_id: "intro-foundation-root",
  },
});
assert.equal(model.generator.contract_id, "introduction-compiler/v1");

const sameModelDifferentOrder = {
  required_evidence: ["editorial-qa", "projection-differential"],
  generator: { contract_id: "introduction-compiler/v1" },
  target: {
    locator: { anchor_id: "intro-foundation-root", kind: "markdown_anchor" },
    ownership: "hybrid",
    path: "outreach/introduction.md",
  },
  sources: [
    {
      path: "requirements/mts-v0.14.json",
      algorithm: "sha256",
      kind: "repository_content",
      id: "claims",
    },
    {
      algorithm: "sha256",
      id: "contract",
      path: "contracts/mts-contract-v0.14.json",
      kind: "repository_content",
    },
  ],
  id: "projection.intro.canonical",
  schema: "repo-guard/projection-model/v0",
};

const modelIdentity = projectionModelIdentity(model);
assert.match(modelIdentity, /^[0-9a-f]{64}$/);
assert.equal(
  projectionModelIdentity(sameModelDifferentOrder),
  modelIdentity,
  "model identity must depend on normalized semantics rather than input key/source ordering",
);

const buildInput = {
  schema: "repo-guard/projection-build-record/v0",
  projection_id: model.id,
  model_identity: modelIdentity,
  source_identities: [
    { source_id: "contract", algorithm: "sha256", digest: hex("b") },
    { source_id: "claims", algorithm: "sha256", digest: hex("a") },
  ],
  generator: {
    contract_id: model.generator.contract_id,
    tool_identity: "anum-docs@34d28141f1e2301e2931ded77f8ab7880d3b5140",
  },
  configuration_digest: hex("c"),
  output_identity: {
    algorithm: "sha256",
    digest: hex("d"),
  },
  evidence: [
    { class: "projection-differential", ref: "ci:projection-differential:456" },
    { class: "editorial-qa", ref: "ci:editorial-qa:123" },
  ],
};

const build = normalizeProjectionBuildRecord(buildInput, model);
assert.deepEqual(
  build.source_identities.map((x) => x.source_id),
  ["claims", "contract"],
  "build source identities must normalize to model source order",
);
assert.deepEqual(
  build.evidence.map((x) => x.class),
  ["editorial-qa", "projection-differential"],
);
assert.equal(build.generator.contract_id, model.generator.contract_id);
assert.equal(build.projection_id, model.id);
assert.equal(build.model_identity, modelIdentity);

assert.throws(
  () => normalizeProjectionModel({
    ...modelInput,
    command: "node render.mjs",
  }),
  /unknown field.*command|command.*not allowed/i,
  "ProjectionModel must not grow an executable command surface",
);

assert.throws(
  () => normalizeProjectionModel({
    ...modelInput,
    sources: [...modelInput.sources, { ...modelInput.sources[0] }],
  }),
  /duplicate source/i,
);

assert.throws(
  () => normalizeProjectionModel({
    ...modelInput,
    target: {
      path: "outreach/introduction.md",
      ownership: "generated",
      locator: {
        kind: "markdown_anchor",
        anchor_id: "intro-foundation-root",
      },
    },
  }),
  /generated.*locator|locator.*generated/i,
  "whole-file generated target must not pretend to be an address-local hybrid target",
);

assert.throws(
  () => normalizeProjectionModel({
    ...modelInput,
    target: {
      path: "outreach/introduction.md",
      ownership: "hybrid",
    },
  }),
  /hybrid.*locator|locator.*hybrid/i,
  "hybrid ownership requires an explicit address-local target",
);

assert.throws(
  () => normalizeProjectionBuildRecord({
    ...buildInput,
    source_identities: buildInput.source_identities.filter((x) => x.source_id !== "claims"),
  }, model),
  /missing source identity.*claims|claims.*missing/i,
);

assert.throws(
  () => normalizeProjectionBuildRecord({
    ...buildInput,
    source_identities: [
      ...buildInput.source_identities,
      { source_id: "unknown", algorithm: "sha256", digest: hex("e") },
    ],
  }, model),
  /unknown source identity.*unknown|unknown.*source/i,
);

assert.throws(
  () => normalizeProjectionBuildRecord({
    ...buildInput,
    model_identity: hex("f"),
  }, model),
  /model identity/i,
);

assert.throws(
  () => normalizeProjectionBuildRecord({
    ...buildInput,
    generator: {
      ...buildInput.generator,
      contract_id: "other-generator/v9",
    },
  }, model),
  /generator contract/i,
);

assert.throws(
  () => normalizeProjectionBuildRecord({
    ...buildInput,
    evidence: buildInput.evidence.filter((x) => x.class !== "editorial-qa"),
  }, model),
  /required evidence.*editorial-qa|editorial-qa.*required/i,
);

assert.throws(
  () => normalizeProjectionBuildRecord({
    ...buildInput,
    output_identity: {
      algorithm: "sha256",
      digest: "not-a-digest",
    },
  }, model),
  /sha256|digest/i,
);

console.log("Projection model/build record contract passed.");
