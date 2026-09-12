import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
import { resolvePolicyProfile } from "../dist/policy-profiles.mjs";

const explicitRule = (source = "src/api.mjs", required = "docs/api.md") => ({
  if_changed: [source],
  must_change_any: [required],
});

const macroSource = (cochangeRules = []) => ({
  cochange_rules: structuredClone(cochangeRules),
  packs: {
    "contract-conformance": {
      current: {
        contract: { path: "contracts/spec-v2.json", format: "json" },
        conformance: { path: "contracts/checks-v2.json", format: "json" },
      },
      previous: {
        contract: { path: "contracts/spec-v1.json", format: "json" },
        conformance: { path: "contracts/checks-v1.json", format: "json" },
      },
      acceptance: {
        document: { path: "contracts/acceptance.json", format: "json" },
        current_contract_path: "/currentContract",
        current_conformance_path: "/currentConformance",
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
      required_paths: [],
      cochange: ["current.contract", "current.conformance", "previous.contract", "previous.conformance", "acceptance"],
      control_paths: ["contracts/**"],
    },
  },
});

const resolvedMacro = (cochangeRules = []) => {
  const resolved = resolvePolicyProfile(macroSource(cochangeRules));
  assert.equal(resolved.ok, true);
  return resolved.policy;
};

describe("C3.2 cochange macro lowering", () => {
  it("lowers five contract roles to one semantic group and no generated directed edges", () => {
    const resolved = resolvedMacro();

    assert.deepEqual(resolved.cochange_rules, []);
    assert.deepEqual(resolved.cochange_groups, [{
      id: "contract-conformance",
      members: [
        "contracts/acceptance.json",
        "contracts/checks-v1.json",
        "contracts/checks-v2.json",
        "contracts/spec-v1.json",
        "contracts/spec-v2.json",
      ],
    }]);
  });

  it("preserves independent directed cochange rules while macro cochange becomes one group", () => {
    const explicit = explicitRule("src/**", "tests/**");
    const resolved = resolvedMacro([explicit]);

    assert.deepEqual(resolved.cochange_rules, [explicit]);
    assert.equal(resolved.cochange_groups.length, 1);
  });

  it("keeps ordinary explicit directed cochange strictness unchanged", () => {
    const first = explicitRule("src/a.mjs", "tests/a.mjs");
    const second = explicitRule("src/b.mjs", "tests/b.mjs");
    const base = { cochange_rules: [first] };
    const head = { cochange_rules: [first, second] };

    const addition = compareConstraintPrograms(base, head);
    assert.equal(addition.relation, "stricter");
    assert.deepEqual(addition.relaxations, []);
    assert.deepEqual(addition.incomparable, []);

    const removal = compareConstraintPrograms(head, base);
    assert.equal(removal.relation, "weaker");
    assert.ok(removal.relaxations.some((item) => item.kind === "cochange_rule_removed" && item.pointer === "/cochange_rules/1"));
  });

  it("keeps an in-place explicit directed cochange edit fail-closed", () => {
    const base = { cochange_rules: [explicitRule("src/a.mjs", "tests/a.mjs")] };
    const head = { cochange_rules: [explicitRule("src/a.mjs", "docs/a.md")] };

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "incomparable");
    assert.ok(comparison.incomparable.some((item) => item.pointer === "/cochange_rules/0"));
  });

  it("removes contract-conformance vocabulary and reverse recognition from canonical core", () => {
    const root = resolve(new URL("..", import.meta.url).pathname);
    const core = readFileSync(resolve(root, "src/checks/constraint-program.mts"), "utf-8");
    for (const token of [
      "ContractConformanceRole",
      "CONTRACT_CONFORMANCE_DOCUMENT_ROLES",
      "contractConformanceRolesByPath",
      "cochangeRoleEdge",
      "generatedContractConformanceCochange",
      "current.contract",
      "current.conformance",
      "previous.contract",
      "previous.conformance",
      "acceptance",
    ]) assert.equal(core.includes(token), false, `canonical core must not contain ${token}`);
  });
});
