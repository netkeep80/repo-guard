import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
import { resolvePolicyProfile } from "../dist/policy-profiles.mjs";

const explicitRule = (source = "src/api.mjs", required = "docs/api.md") => ({
  if_changed: [source],
  must_change_any: [required],
});

const macroSource = (cochangeRules = []) => ({
  cochange_rules: structuredClone(cochangeRules),
  contract_conformance: {
    current: {
      contract: { path: "contracts/spec-v2.json", format: "json" },
      conformance: { path: "contracts/checks-v2.json", format: "json" },
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
    cochange: ["current.contract", "current.conformance"],
    control_paths: ["contracts/**"],
  },
});

const resolvedMacro = (cochangeRules = []) => {
  const resolved = resolvePolicyProfile(macroSource(cochangeRules));
  assert.equal(resolved.ok, true);
  return resolved.policy;
};

describe("cochange strictness identity", () => {
  it("treats an explicit cochange inserted before generated macro edges as tightening", () => {
    const base = resolvedMacro();
    const head = resolvedMacro([explicitRule()]);

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "stricter");
    assert.deepEqual(comparison.relaxations, []);
    assert.deepEqual(comparison.incomparable, []);
  });

  it("treats ordinary explicit cochange addition/removal monotonically", () => {
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

  it("keeps an in-place explicit cochange semantic edit fail-closed", () => {
    const base = { cochange_rules: [explicitRule("src/a.mjs", "tests/a.mjs")] };
    const head = { cochange_rules: [explicitRule("src/a.mjs", "docs/a.md")] };

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "incomparable");
    assert.ok(comparison.incomparable.some((item) => item.pointer === "/cochange_rules/0"));
  });

  it("keeps generated edge removal fail-closed with index diagnostics", () => {
    const base = resolvedMacro();
    const head = structuredClone(base);
    head.cochange_rules.pop();

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "weaker");
    assert.ok(comparison.relaxations.some((item) => item.kind === "cochange_rule_removed" && item.pointer?.startsWith("/cochange_rules/")));
  });
});
