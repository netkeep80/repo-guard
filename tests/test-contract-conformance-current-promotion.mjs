import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import Ajv from "ajv";
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
import { checkPolicyRelaxation } from "../dist/checks/rules/policy-delta-rules.mjs";
import { resolvePolicyProfile } from "../dist/policy-profiles.mjs";
import { loadJSON } from "../dist/runtime/validation.mjs";

const CURRENT_PROMOTION_POINTERS = [
  "/document_relations/rules/contract-conformance:current-id",
  "/document_relations/rules/contract-conformance:current-conformance-path",
  "/document_relations/rules/contract-conformance:current-contract-status",
  "/document_relations/rules/contract-conformance:current-conformance-status",
  "/document_relations/rules/contract-conformance:current-contract-accepted",
  "/document_relations/rules/contract-conformance:current-conformance-accepted",
  "/document_relations/rules/contract-conformance:required-path:0",
].sort();

const changedPolicyFile = {
  path: "repo-policy.json",
  status: "modified",
  addedLines: [],
  deletedLines: [],
};

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

function resolve(source) {
  const resolved = resolvePolicyProfile(source);
  assert.equal(resolved.ok, true);
  return resolved.policy;
}

function resolvedPolicy(version) {
  return resolve(sourcePolicy(version));
}

function comparisonPointers(base, head) {
  const comparison = compareConstraintPrograms(base, head);
  return [...new Set([
    ...comparison.relaxations.map((item) => item.pointer),
    ...comparison.incomparable.map((item) => item.pointer),
  ])].sort();
}

function schemaPolicy(version = "v1") {
  const source = sourcePolicy(version);
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: { max_new_files: 5, max_new_docs: 2 },
    content_rules: [],
    cochange_rules: [],
    contract_conformance: structuredClone(source.contract_conformance),
  };
}

describe("contract_conformance.current promotion strictness", () => {
  it("reports only generated current-pair semantic pointers when only current paths change", () => {
    assert.deepEqual(comparisonPointers(resolvedPolicy("v1"), resolvedPolicy("v2")), CURRENT_PROMOTION_POINTERS);
  });

  it("allows the promotion with a narrow trusted grant covering only generated semantic pointers", () => {
    const result = checkPolicyRelaxation({
      basePolicy: resolvedPolicy("v1"),
      headPolicy: resolvedPolicy("v2"),
      changedFiles: [changedPolicyFile],
      trustedAuthorizer: { issue_author_permission_trusted: true },
      governanceGrant: { allow_policy_relaxation: CURRENT_PROMOTION_POINTERS },
      changeIntentType: "governance",
    });
    assert.equal(result.ok, true);
    assert.deepEqual([...new Set(result.policy_relaxations.map((item) => item.pointer))].sort(), CURRENT_PROMOTION_POINTERS);
  });

  it("still blocks the promotion without explicit generated-pointer grants", () => {
    const result = checkPolicyRelaxation({
      basePolicy: resolvedPolicy("v1"),
      headPolicy: resolvedPolicy("v2"),
      changedFiles: [changedPolicyFile],
      trustedAuthorizer: { issue_author_permission_trusted: true },
      governanceGrant: null,
      changeIntentType: "governance",
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes("governance_grant_missing"));
    assert.deepEqual([...new Set(result.policy_relaxations.map((item) => item.pointer))].sort(), CURRENT_PROMOTION_POINTERS);
  });

  it("keeps explicit cochange edits fail-closed instead of hiding them as generated macro edges", () => {
    const baseSource = sourcePolicy("v1");
    baseSource.cochange_rules = [{ if_changed: ["docs/a.md"], must_change_any: ["docs/b.md"] }];
    const headSource = structuredClone(baseSource);
    headSource.cochange_rules[0].must_change_any = ["docs/c.md"];
    const pointers = comparisonPointers(resolve(baseSource), resolve(headSource));
    assert.ok(pointers.includes("/cochange_rules/0"));
    assert.ok(!pointers.includes("/"));
  });

  it("keeps contract_conformance.cochange semantic edits fail-closed", () => {
    const baseSource = sourcePolicy("v1"), headSource = structuredClone(baseSource);
    headSource.contract_conformance.cochange = ["current.conformance", "current.contract"];
    const pointers = comparisonPointers(resolve(baseSource), resolve(headSource));
    assert.deepEqual(pointers, ["/cochange_rules/0", "/cochange_rules/1"]);
  });

  it("keeps pair_fields edits fail-closed through generated relation semantics", () => {
    const baseSource = sourcePolicy("v1"), headSource = structuredClone(baseSource);
    headSource.contract_conformance.pair_fields.contract_id = "/otherSchema";
    const pointers = comparisonPointers(resolve(baseSource), resolve(headSource));
    assert.ok(pointers.includes("/document_relations/rules/contract-conformance:current-id"));
  });

  it("keeps accepted_state edits fail-closed through generated relation semantics", () => {
    const baseSource = sourcePolicy("v1"), headSource = structuredClone(baseSource);
    headSource.contract_conformance.accepted_state.status = "candidate";
    const pointers = comparisonPointers(resolve(baseSource), resolve(headSource));
    assert.ok(pointers.includes("/document_relations/rules/contract-conformance:current-contract-status"));
    assert.ok(pointers.includes("/document_relations/rules/contract-conformance:current-conformance-status"));
  });

  it("keeps required_paths semantic edits fail-closed through their generated relation", () => {
    const baseSource = sourcePolicy("v1"), headSource = structuredClone(baseSource);
    headSource.contract_conformance.required_paths[0].pointer = "/otherRepositoryPaths";
    assert.ok(comparisonPointers(resolve(baseSource), resolve(headSource)).includes(
      "/document_relations/rules/contract-conformance:required-path:0",
    ));
  });

  it("keeps unknown contract_conformance siblings rejected by the source schema", () => {
    const validate = new Ajv({ allErrors: true }).compile(loadJSON(new URL("../schemas/repo-policy.schema.json", import.meta.url)));
    const source = schemaPolicy();
    source.contract_conformance.unmodeled = { allow: true };
    assert.equal(validate(source), false);
  });
});
