import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";

const currentPolicy = () => ({
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: {
    forbidden: [],
    canonical_docs: [],
    governance_paths: ["repo-policy.json"],
    public_api: ["src/**"],
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
    const comparison = compareConstraintPrograms(base, currentPolicy());

    assert.equal(comparison.relation, "equal");
    assert.deepEqual(comparison.relaxations, []);
    assert.deepEqual(comparison.incomparable, []);
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
    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "incomparable");
    assert.ok(comparison.incomparable.some((item) => item.pointer === "/"));
  });
});
