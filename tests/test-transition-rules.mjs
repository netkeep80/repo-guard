import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compileConstraintProgram, compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";

const basePolicy = () => ({
  paths: { forbidden: [], canonical_docs: [], governance_paths: ["repo-policy.json"], operational_paths: [] },
  diff_rules: { max_new_docs: 2, max_new_files: 5 },
  transition_rules: [
    { id: "release-revision", path: "meta/REVISION", format: "semver", relation: "strictly_greater" },
  ],
});

function facts(baseValue, headValue, { missingBase = false, missingHead = false } = {}) {
  return {
    repositoryRoot: process.cwd(),
    baseRef: "BASE",
    headRef: "HEAD",
    readFileAtRef: (ref, path) => {
      assert.equal(path, "meta/REVISION");
      if (ref === "BASE") {
        if (missingBase) throw new Error("missing BASE file");
        return baseValue;
      }
      if (ref === "HEAD") {
        if (missingHead) throw new Error("missing HEAD file");
        return headValue;
      }
      throw new Error(`unexpected ref ${ref}`);
    },
    policy: basePolicy(),
    changeIntent: null,
    diff: {
      files: {
        checked: [{ path: "src/unrelated.mjs", status: "modified", addedLines: ["x"], deletedLines: ["y"] }],
      },
    },
  };
}

function transitionCheck(baseValue, headValue, options) {
  const entries = evaluateConstraintIR(facts(baseValue, headValue, options), { executionPhase: "transaction" });
  return entries.find((entry) => entry.name === "transition:release-revision")?.check;
}

describe("generic BASE -> HEAD scalar transition rules", () => {
  it("compiles into the canonical Constraint Program", () => {
    const entry = compileConstraintProgram(basePolicy()).find((item) => item.key === "transition:release-revision");
    assert.equal(entry?.runtime?.kind, "scalar_transition");
  });

  for (const [from, to] of [["1.2.3\n", "1.2.4\n"], ["1.2.3", "1.3.0"]]) {
    it(`${from.trim()} -> ${to.trim()} passes`, () => {
      const check = transitionCheck(from, to);
      assert.equal(check?.ok, true);
      assert.equal(check?.base_value, from.trim());
      assert.equal(check?.head_value, to.trim());
    });
  }

  for (const [label, from, to] of [
    ["equality", "1.2.3", "1.2.3"],
    ["downgrade", "1.2.3", "1.2.2"],
    ["malformed HEAD", "1.2.3", "not-a-version"],
  ]) {
    it(`${label} fails closed with structured diagnostics`, () => {
      const check = transitionCheck(from, to);
      assert.equal(check?.ok, false);
      assert.equal(check?.rule_id, "release-revision");
      assert.equal(check?.path, "meta/REVISION");
      assert.equal(check?.base_value, from);
      assert.equal(check?.head_value, to);
      assert.equal(check?.expected_relation, "strictly_greater");
    });
  }

  it("missing HEAD fails closed", () => {
    const check = transitionCheck("1.2.3", null, { missingHead: true });
    assert.equal(check?.ok, false);
    assert.equal(check?.path, "meta/REVISION");
    assert.match(check?.message || "", /HEAD/i);
  });

  it("malformed trusted BASE fails closed", () => {
    const check = transitionCheck("broken", "1.2.4");
    assert.equal(check?.ok, false);
    assert.equal(check?.base_value, "broken");
    assert.match(check?.message || "", /BASE/i);
  });

  it("unrelated repository change still requires a bump", () => {
    const check = transitionCheck("2.0.0", "2.0.0");
    assert.equal(check?.ok, false);
  });

  it("is transaction-only rather than a main-state invariant", () => {
    const entries = evaluateConstraintIR(facts("1.0.0", "1.0.1"), { executionPhase: "state" });
    assert.equal(entries.some((entry) => entry.name === "transition:release-revision"), false);
  });
});

describe("transition rule policy-delta semantics", () => {
  it("adding a transition rule is tightening", () => {
    const before = basePolicy();
    delete before.transition_rules;
    assert.equal(compareConstraintPrograms(before, basePolicy()).relation, "stricter");
  });

  it("removing a transition rule is a relaxation", () => {
    const after = basePolicy();
    delete after.transition_rules;
    const result = compareConstraintPrograms(basePolicy(), after);
    assert.equal(result.relation, "weaker");
    assert.ok(result.relaxations.some((item) => item.kind === "transition_rule_removed" && item.rule_id === "release-revision"));
  });

  for (const field of ["path", "format", "relation"]) {
    it(`changing transition ${field} is incomparable`, () => {
      const after = basePolicy();
      if (field === "path") after.transition_rules[0].path = "meta/OTHER";
      if (field === "format") after.transition_rules[0].format = "numeric_tuple";
      if (field === "relation") after.transition_rules[0].relation = "greater_or_equal";
      const result = compareConstraintPrograms(basePolicy(), after);
      assert.equal(result.relation, "incomparable");
      assert.ok(result.incomparable.some((item) => item.pointer === "/transition_rules/release-revision"));
    });
  }
});
