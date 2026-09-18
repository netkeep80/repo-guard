import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { listBuiltInPacks, resolvePolicyPacks } from "../dist/policy-packs.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf-8"));
const base = json("tests/fixtures/valid-policy.json");
const schema = json("schemas/repo-policy.schema.json");
const validate = new Ajv({ allErrors: true }).compile(schema);

const contractPack = {
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

assert.ok(listBuiltInPacks().includes("contract-conformance"), "contract-conformance must be a closed built-in pack");

const packPolicy = {
  ...base,
  paths: { ...base.paths, governance_paths: ["repo-policy.json", "schemas/**"] },
  packs: { "contract-conformance": contractPack },
};
assert.equal(validate(packPolicy), true, `packs.contract-conformance must be schema-valid: ${JSON.stringify(validate.errors)}`);

const legacyPolicy = { ...packPolicy, packs: undefined, contract_conformance: contractPack };
assert.equal(validate(legacyPolicy), false, "top-level contract_conformance must be removed from the v3 public policy surface");

const resolved = resolvePolicyPacks(packPolicy);
assert.equal(resolved.ok, true, `contract-conformance pack must resolve: ${JSON.stringify(resolved.errors)}`);
assert.equal(resolved.policy.packs, undefined, "pack source field must disappear after lowering");
assert.equal(resolved.policy.contract_conformance, undefined, "legacy contract source field must not survive lowering");
assert.equal(resolved.policy.document_relations.documents["contract-conformance.current.contract"].path, "contracts/spec-v2.json");
assert.equal(resolved.policy.document_relations.documents["contract-conformance.current.conformance"].path, "contracts/checks-v2.yaml");
assert.equal(resolved.policy.document_relations.rules.length, 8, "current pair plus two required-path selectors must lower to eight ordinary relations");
assert.deepEqual(resolved.policy.cochange_groups, [{
  id: "contract-conformance",
  members: ["contracts/checks-v2.yaml", "contracts/spec-v2.json"],
}]);
assert.deepEqual(resolved.policy.paths.governance_paths, ["contracts/**", "repo-policy.json", "schemas/**"]);

console.log("C3.10b contract-conformance public surface cutover contract passed");
