import { strict as assert } from "node:assert";
import { compileConstraintProgram, runtimeConstraints } from "../dist/checks/constraint-program.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";
import { readFact } from "../dist/document-facts.mjs";

let failures = 0;

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS: ${label}`);
  } catch {
    failures++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function primitiveById(program, relationId) {
  return runtimeConstraints(program).find((item) => item.kind === "primitive_relation" && item.relation_id === relationId);
}

const basePolicy = {
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: { forbidden: [], canonical_docs: [], operational_paths: [], governance_paths: [] },
  diff_rules: {},
  content_rules: [],
  cochange_rules: [],
};

console.log("\n--- canonical FactRef sources for C3.3b ---");
{
  const repositoryFact = readFact({
    anchors: {
      byType: {
        requirement_id: [
          { value: "FR-002", file: "requirements/fr-002.json" },
          { value: "FR-001", file: "requirements/fr-001.json" },
          { value: "FR-001", file: "docs/duplicate.md", line: 3, column: 2 },
        ],
      },
    },
  }, {
    source: "repository",
    selector: { kind: "anchor_values", anchor_type: "requirement_id" },
    type: "string_set",
  });
  expect("repository anchor_values keeps normalized values and source provenance", repositoryFact, {
    ok: true,
    value: ["FR-001", "FR-002"],
    provenance: {
      kind: "anchor_instances",
      anchor_type: "requirement_id",
      instances: [
        { value: "FR-001", file: "docs/duplicate.md", line: 3, column: 2 },
        { value: "FR-001", file: "requirements/fr-001.json" },
        { value: "FR-002", file: "requirements/fr-002.json" },
      ],
    },
  });

  const changeIntentFact = readFact({
    changeIntent: {
      anchors: {
        affects: ["FR-002", "FR-001", "FR-001"],
      },
    },
  }, {
    source: "change_intent",
    selector: { pointer: "/anchors/affects", projection: "array_items" },
    type: "string_set",
  });
  expect("ChangeIntent uses a generic typed pointer selector", changeIntentFact, {
    ok: true,
    value: ["FR-001", "FR-002"],
  });
}

console.log("\n--- trace rules lower into existing relation algebra ---");
{
  const policy = {
    ...basePolicy,
    trace_rules: [
      {
        id: "code-refs-resolve",
        kind: "must_resolve",
        from_anchor_type: "code_req_ref",
        to_anchor_type: "requirement_id",
      },
      {
        id: "changed-requirements-have-evidence",
        kind: "changed_files_require_evidence",
        if_changed: ["requirements/**"],
        must_touch_any: ["tests/**", "docs/**"],
      },
      {
        id: "declared-affects-have-evidence",
        kind: "declared_anchors_require_evidence",
        change_intent_field: "anchors.affects",
        must_touch_any: ["tests/**", "docs/**"],
      },
    ],
  };
  const program = compileConstraintProgram(policy, {
    anchors: { affects: ["FR-001"] },
  });
  const runtime = runtimeConstraints(program);

  expect("historical trace_rules runtime kind is absent", runtime.some((item) => item.kind === "trace_rules"), false);

  const resolve = primitiveById(program, "trace:code-refs-resolve");
  expect("must_resolve lowers to existing set_subset", resolve?.primitive, "set_subset");
  expect("must_resolve keeps historical transaction scheduling on the relation instance", resolve?.phase, "transaction");
  expect("must_resolve left operand reads repository anchor values", resolve?.operands?.left, {
    source: "repository",
    selector: { kind: "anchor_values", anchor_type: "code_req_ref" },
    type: "string_set",
  });
  expect("must_resolve right operand reads repository anchor values", resolve?.operands?.right, {
    source: "repository",
    selector: { kind: "anchor_values", anchor_type: "requirement_id" },
    type: "string_set",
  });

  const changedEvidence = primitiveById(program, "trace:changed-requirements-have-evidence");
  expect("changed-files evidence lowers to existing set_presence_implies", changedEvidence?.primitive, "set_presence_implies");
  expect("changed-files evidence trigger remains an informative changed_paths fact", changedEvidence?.operands?.left, {
    source: "diff",
    selector: { kind: "changed_paths", patterns: ["requirements/**"] },
    type: "repository_path_set",
  });
  expect("changed-files evidence target remains an informative changed_paths fact", changedEvidence?.operands?.right, {
    source: "diff",
    selector: { kind: "changed_paths", patterns: ["tests/**", "docs/**"] },
    type: "repository_path_set",
  });

  const declaredEvidence = primitiveById(program, "trace:declared-affects-have-evidence");
  expect("declared-anchor evidence lowers to existing set_presence_implies", declaredEvidence?.primitive, "set_presence_implies");
  expect("declared-anchor evidence uses generic ChangeIntent FactRef", declaredEvidence?.operands?.left, {
    source: "change_intent",
    selector: { pointer: "/anchors/affects", projection: "array_items" },
    type: "string_set",
  });
}

console.log("\n--- anchor evidence lowers into existing set_subset ---");
{
  const policy = {
    ...basePolicy,
    anchors: {
      types: {
        case_evidence: { sources: [{ kind: "regex", glob: "tests/**", pattern: "CASE:([a-z-]+)" }] },
      },
    },
    document_relations: {
      documents: {
        conformance: { path: "contracts/conformance.json", format: "json" },
      },
      rules: [],
    },
    evidence_bindings: [
      {
        id: "cases-have-evidence",
        kind: "anchor_value_coverage",
        source: { document: "conformance", pointer: "/requiredCases", projection: "array_items", type: "string_set" },
        target_anchor_type: "case_evidence",
      },
    ],
  };
  const program = compileConstraintProgram(policy);
  const runtime = runtimeConstraints(program);

  expect("historical evidence_anchor_value_coverage runtime kind is absent", runtime.some((item) => item.kind === "evidence_anchor_value_coverage"), false);
  const coverage = primitiveById(program, "evidence:cases-have-evidence");
  expect("anchor value coverage lowers to existing set_subset", coverage?.primitive, "set_subset");
  expect("anchor value coverage target is canonical repository anchor_values", coverage?.operands?.right, {
    source: "repository",
    selector: { kind: "anchor_values", anchor_type: "case_evidence" },
    type: "string_set",
  });
}

console.log("\n--- relation algebra stays finite ---");
{
  expect("C3.3b keeps exactly the existing ten relation descriptors", relationDescriptors().length, 10);
  expect("C3.3b adds no relation descriptor kind", relationDescriptors().map((item) => item.kind).sort(), [
    "numeric_bound",
    "referenced_paths_exist",
    "referenced_pointer_exists",
    "scalar_equal",
    "scalar_equals_literal",
    "scalar_strictly_greater",
    "set_all_or_none",
    "set_equal",
    "set_presence_implies",
    "set_subset",
  ]);
}

console.log(`\n${failures === 0 ? "C3.3b canonical lowering contract passed" : `C3.3b RED confirmed by ${failures} failing probe(s)`}`);
process.exit(failures === 0 ? 0 : 1);
