import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
import { computePolicyDelta } from "../dist/checks/rules/policy-delta-rules.mjs";

const currentPolicy = () => ({
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: {
    forbidden: [],
    canonical_docs: [],
    governance_paths: ["repo-policy.json"],
  },
  diff_rules: { max_new_docs: 5, max_new_files: 5 },
  content_rules: [],
  cochange_rules: [],
});

describe("current policy vocabulary strictness projection", () => {
  it("does not grant semantic authority to a retired BASE-only top-level field", () => {
    const base = currentPolicy();
    base.integration = {
      workflows: [{ id: "retired", path: ".github/workflows/retired.yml" }],
    };

    assert.deepEqual(computePolicyDelta(base, currentPolicy()).relaxations, []);
  });

  it("still fails closed when a current non-Constraint-Program semantic section changes", () => {
    const base = currentPolicy();
    const head = currentPolicy();
    head.content_rules = [{
      id: "no-debug",
      glob: "src/**",
      mode: "added_lines",
      forbid_regex: ["debug"],
    }];

    const relaxations = computePolicyDelta(base, head).relaxations;
    assert.equal(relaxations.length, 1);
    assert.equal(relaxations[0]?.pointer, "/content_rules");
  });

  it("reports independent residual sections with independent pointers", () => {
    const base = currentPolicy();
    const head = currentPolicy();
    head.content_rules = [{
      id: "no-debug",
      glob: "src/**",
      mode: "added_lines",
      forbid_regex: ["debug"],
    }];
    head.surfaces = { source: ["src/**"] };

    const pointers = computePolicyDelta(base, head).relaxations
      .map((item) => item.pointer)
      .sort();

    assert.deepEqual(pointers, ["/content_rules", "/surfaces"]);
  });

  it("escapes residual top-level keys as JSON Pointer tokens", () => {
    const key = "future/semantic~v1";
    const base = { [key]: { mode: "strict" } };
    const head = { [key]: { mode: "changed" } };

    const comparison = compareConstraintPrograms(base, head);

    assert.deepEqual(
      comparison.incomparable.map((item) => item.pointer),
      ["/future~1semantic~0v1"],
    );
  });
});