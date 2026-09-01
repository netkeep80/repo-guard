import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
import { resolvePolicyProfile } from "../dist/policy-profiles.mjs";

const CURRENT_PROMOTION_POINTERS = [
  "/document_relations/rules/contract-conformance:current-id",
  "/document_relations/rules/contract-conformance:current-conformance-path",
  "/document_relations/rules/contract-conformance:current-contract-status",
  "/document_relations/rules/contract-conformance:current-conformance-status",
  "/document_relations/rules/contract-conformance:current-contract-accepted",
  "/document_relations/rules/contract-conformance:current-conformance-accepted",
  "/document_relations/rules/contract-conformance:required-path:0",
].sort();

function sourcePolicy(version) {
  return {
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
      canonical_docs: [],
    },
    diff_rules: { max_new_files: 5, max_new_docs: 2, max_net_added_lines: 50 },
    cochange_rules: [],
    contract_conformance: {
      current: {
        contract: { path: `contracts/spec-${version}.json`, format: "json" },
        conformance: { path: `contracts/checks-${version}.json`, format: "json" },
      },
      pair_fields: {
        contract_id: "/schema",
        conformance_contract_id: "/contract",
        contract_conformance_path: "/conformanceCorpus",
        contract_status: "/status",
        conformance_status: "/status",
        contract_accepted: "/accepted",
        conformance_accepted: "/accepted",
      },
      accepted_state: { status: "accepted", accepted: true },
      required_paths: [{
        document: "current.conformance",
        pointer: "/requiredRepositoryPaths",
        projection: "array_items",
      }],
      cochange: ["current.contract", "current.conformance"],
      control_paths: ["contracts/**"],
    },
  };
}

function resolvedPolicy(version) {
  const resolved = resolvePolicyProfile(sourcePolicy(version));
  assert.equal(resolved.ok, true);
  return resolved.policy;
}

describe("contract_conformance.current promotion strictness", () => {
  it("reports only generated current-pair semantic pointers when only current paths change", () => {
    const comparison = compareConstraintPrograms(resolvedPolicy("v1"), resolvedPolicy("v2"));
    const pointers = [...new Set([
      ...comparison.relaxations.map((item) => item.pointer),
      ...comparison.incomparable.map((item) => item.pointer),
    ])].sort();

    assert.deepEqual(pointers, CURRENT_PROMOTION_POINTERS);
  });
});
