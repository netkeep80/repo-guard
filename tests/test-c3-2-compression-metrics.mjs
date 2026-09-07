import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

const metrics = () => JSON.parse(execFileSync(process.execPath, ["scripts/compression-metrics.mjs", "--ref", "HEAD"], { encoding: "utf-8" }));

describe("C3.2 architecture compression metrics", () => {
  it("proves pure macro lowering and removal of positional generated-edge knowledge", () => {
    const architecture = metrics().architecture;

    assert.equal(architecture.contract_conformance_role_vocabulary_in_canonical_core, 0);
    assert.equal(architecture.generated_edge_recognition_helpers, 0);
    assert.equal(architecture.contract_conformance_cochange_constraints, 1);
    assert.equal(architecture.macro_generated_positional_identity, 0);
    assert.equal(architecture.high_level_pack_semantic_edit_sites_in_canonical_core, 0);
  });
});
