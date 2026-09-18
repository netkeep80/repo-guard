import assert from "node:assert/strict";
import { resolve } from "node:path";

import { listBuiltInPacks, resolvePolicyPacks } from "../dist/policy-packs.mjs";
import { createPolicyNormalizationContext, normalizePolicy } from "../dist/runtime/validation.mjs";

const packageRoot = resolve(".");
const context = createPolicyNormalizationContext({ packageRoot, repoRoot: packageRoot });

function foundationPolicy() {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json", "contracts/**", ".github/workflows/**", "package.json"],
      operational_paths: [],
    },
    diff_rules: { max_new_docs: 2, max_new_files: 10, max_net_added_lines: 1000 },
    content_rules: [],
    cochange_rules: [],
  };
}

function contractConformanceConfig() {
  return {
    current: {
      contract: { path: "contracts/spec-v2.json", format: "json" },
      conformance: { path: "contracts/checks-v2.yaml", format: "yaml" },
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
    required_paths: [
      { document: "current.contract", pointer: "/owners", projection: "object_values" },
      { document: "current.conformance", pointer: "/requiredGates", projection: "array_items" },
    ],
    cochange: ["current.contract", "current.conformance"],
    control_paths: ["contracts/**"],
  };
}

const fixtures = {
  "requirements-strict": {},
  "version-governance": {
    authority: { path: "package.json", pointer: "/version", format: "json" },
    advance: "semver",
  },
  "repo-guard-workflow": {
    path: ".github/workflows/consumer.yml",
    sha: "a".repeat(40),
  },
  "contract-conformance": contractConformanceConfig(),
};

assert.deepEqual(listBuiltInPacks(), Object.keys(fixtures).sort(), "proof corpus must cover every built-in pack");

for (const [name, config] of Object.entries(fixtures)) {
  const source = { ...foundationPolicy(), packs: { [name]: config } };
  const expanded = resolvePolicyPacks(source);
  assert.equal(expanded.ok, true, `${name}: fixture must lower successfully`);

  const fromPack = normalizePolicy(context, source, { quiet: true });
  const fromExplicit = normalizePolicy(context, expanded.policy, { quiet: true });
  assert.equal(fromPack.ok, true, `${name}: canonical pack normalization must succeed`);
  assert.equal(fromExplicit.ok, true, `${name}: canonical explicit normalization must succeed`);
  assert.deepEqual(fromPack.policy, fromExplicit.policy, `${name}: pack and explicit expansion must normalize to one policy`);
  assert.deepEqual(
    fromPack.constraintProgram.map((entry) => entry.key),
    fromExplicit.constraintProgram.map((entry) => entry.key),
    `${name}: pack and explicit expansion must compile one Constraint Program`,
  );
  assert.deepEqual(fromPack.provenance.packs, [name], `${name}: lowering provenance must retain the source pack`);
  assert.deepEqual(fromExplicit.provenance.packs, [], `${name}: explicit expansion must not invent pack provenance`);
}

console.log("P1.1 built-in pack normalization equivalence proof passed");
