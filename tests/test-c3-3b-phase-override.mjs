import { strict as assert } from "node:assert";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";
import { relationDescriptor } from "../dist/checks/relation-kernel.mjs";

const policy = {
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: { forbidden: [], canonical_docs: [], operational_paths: [], governance_paths: [] },
  diff_rules: {},
  content_rules: [],
  cochange_rules: [],
  trace_rules: [{
    id: "phase-resolve",
    kind: "must_resolve",
    from_anchor_type: "code_req_ref",
    to_anchor_type: "requirement_id",
  }],
};

const facts = {
  policy,
  changeIntent: null,
  anchors: {
    byType: {
      code_req_ref: [{ value: "FR-404", file: "src/feature.mjs", line: 1, column: 10 }],
      requirement_id: [{ value: "FR-001", file: "requirements/fr-001.json" }],
    },
  },
  diff: { files: { checked: [] } },
};

assert.equal(relationDescriptor("set_subset").phase, "state", "set_subset descriptor remains a state relation");

const transaction = evaluateConstraintIR(facts, { executionPhase: "transaction" });
const state = evaluateConstraintIR(facts, { executionPhase: "state" });
const transactionResolve = transaction.find((entry) => entry.name === "trace-rule: phase-resolve");

assert.ok(transactionResolve, "must_resolve executes in transaction phase through instance override");
assert.equal(transactionResolve.check.ok, false, "transaction execution evaluates unresolved anchors");
assert.equal(transactionResolve.check.data.kind, "set_subset", "transaction execution still uses canonical set_subset semantics");
assert.deepEqual(transactionResolve.check.data.missing_values, ["FR-404"], "transaction execution preserves relation diagnostics");
assert.equal(state.some((entry) => entry.name === "trace-rule: phase-resolve"), false, "must_resolve does not execute in state phase");

console.log("C3.3b transaction phase override contract passed");
