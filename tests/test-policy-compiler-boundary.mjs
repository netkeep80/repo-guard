import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { compileDocumentRelationsPolicy, compileEvidenceBindingsPolicy, compileForbidRegex } from "../dist/policy-compiler.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";
import { createDocumentReader } from "../dist/document-facts.mjs";
import { loadPolicyRuntimeFromObject } from "../dist/runtime/validation.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const basePolicy = {
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: { forbidden: [], canonical_docs: [], governance_paths: [] },
  diff_rules: { max_new_docs: 5, max_new_files: 5 },
  content_rules: [],
  cochange_rules: [],
};
const documents = {
  contract: { path: "contracts/contract.json", format: "json" },
  conformance: { path: "contracts/conformance.yaml", format: "yaml" },
};
const scalarEqual = {
  id: "contract-id-matches",
  kind: "scalar_equal",
  left: { document: "conformance", pointer: "/contract", type: "string" },
  right: { document: "contract", pointer: "/id", type: "string" },
};
const scalarLiteral = {
  id: "root-is-infinity",
  kind: "scalar_equals_literal",
  source: { document: "contract", pointer: "/root", type: "string" },
  value: "∞",
};
const referencedPaths = {
  id: "owners-exist",
  kind: "referenced_paths_exist",
  source: { document: "contract", pointer: "/owners", projection: "object_values", type: "repository_path_set" },
};
const relationPolicy = (overrides = {}) => ({
  document_relations: { documents: structuredClone(documents), rules: [structuredClone(scalarEqual), structuredClone(scalarLiteral)], ...overrides },
});

describe("semantic policy compiler boundary", () => {
  it("keeps non-array nested values inert before semantic compilation", () => {
    assert.deepEqual(compileForbidRegex([{ id: "bad", forbid_regex: "[invalid" }]), []);
  });

  it("accepts semantically consistent scalar document relations", () => {
    assert.deepEqual(compileDocumentRelationsPolicy(relationPolicy()), []);
  });

  it("accepts a referenced path selector as a used document relation", () => {
    assert.deepEqual(compileDocumentRelationsPolicy({
      document_relations: {
        documents: { contract: structuredClone(documents.contract) },
        rules: [structuredClone(referencedPaths)],
      },
    }), []);
  });

  it("rejects duplicate ids, unknown references and unused documents", () => {
    const policy = relationPolicy({
      documents: { ...documents, unused: { path: "contracts/unused.json", format: "json" } },
      rules: [
        structuredClone(scalarEqual),
        { ...structuredClone(scalarEqual), right: { document: "missing", pointer: "/id", type: "string" } },
      ],
    });
    const messages = compileDocumentRelationsPolicy(policy).map((error) => error.message);
    assert.ok(messages.some((message) => /duplicates rule/.test(message)));
    assert.ok(messages.some((message) => /unknown document "missing"/.test(message)));
    assert.ok(messages.some((message) => /"unused".*declared but unused/.test(message)));
  });

  it("rejects invalid paths, format mismatches and incompatible literals", () => {
    const policy = relationPolicy({
      documents: {
        contract: { path: "../contract.json", format: "json" },
        conformance: { path: "contracts/conformance.json", format: "yaml" },
      },
      rules: [
        structuredClone(scalarEqual),
        { ...structuredClone(scalarLiteral), source: { document: "contract", pointer: "/root", type: "boolean" }, value: "true" },
      ],
    });
    const messages = compileDocumentRelationsPolicy(policy).map((error) => error.message);
    assert.ok(messages.some((message) => /path is invalid/.test(message)));
    assert.ok(messages.some((message) => /format "yaml" does not match path/.test(message)));
    assert.ok(messages.some((message) => /literal is incompatible/.test(message)));
  });
});

describe("document relation public schema boundary", () => {
  const validate = (documentRelations) => loadPolicyRuntimeFromObject(
    { packageRoot: projectRoot, repoRoot: projectRoot },
    { ...basePolicy, document_relations: documentRelations },
    { quiet: true },
  );

  it("accepts only executable scalar and referenced-path relation kinds", () => {
    assert.equal(validate(relationPolicy().document_relations).ok, true);
    assert.equal(validate({
      documents: { contract: structuredClone(documents.contract) },
      rules: [structuredClone(referencedPaths)],
    }).ok, true);
    assert.equal(validate({ documents, rules: [{ ...scalarEqual, kind: "set_equal" }] }).ok, false);
  });

  it("keeps scalar selectors free of collection projections and unsupported document formats", () => {
    assert.equal(validate({
      documents,
      rules: [{ ...scalarEqual, left: { ...scalarEqual.left, projection: "array_items" } }],
    }).ok, false);
    assert.equal(validate({
      documents: { contract: { path: "contracts/contract.md", format: "markdown" } },
      rules: [{ ...scalarLiteral, source: { ...scalarLiteral.source, document: "contract" } }],
    }).ok, false);
  });

  it("restricts referenced path selectors to collection projection plus repository_path_set", () => {
    assert.equal(validate({
      documents: { contract: structuredClone(documents.contract) },
      rules: [{ ...structuredClone(referencedPaths), source: { ...referencedPaths.source, projection: "value" } }],
    }).ok, false);
    assert.equal(validate({
      documents: { contract: structuredClone(documents.contract) },
      rules: [{ ...structuredClone(referencedPaths), source: { ...referencedPaths.source, type: "string_set" } }],
    }).ok, false);
    assert.equal(validate({
      documents: { contract: structuredClone(documents.contract) },
      rules: [{ ...structuredClone(referencedPaths), source: { ...referencedPaths.source, projection: "array_items" } }],
    }).ok, true);
  });
});

const anchorEvidencePolicy = (overrides = {}) => ({
  ...basePolicy,
  anchors: {
    types: {
      case_evidence: {
        sources: [{ kind: "regex", glob: "tests/**", pattern: "CASE:([a-z-]+)" }],
      },
    },
  },
  document_relations: {
    documents: { conformance: { path: "contracts/conformance.json", format: "json" } },
    rules: [],
  },
  evidence_bindings: [{
    id: "cases-have-evidence",
    kind: "anchor_value_coverage",
    source: { document: "conformance", pointer: "/requiredCases", projection: "array_items", type: "string_set" },
    target_anchor_type: "case_evidence",
  }],
  ...overrides,
});

describe("anchor value evidence public/runtime boundary", () => {
  it("treats evidence bindings as first-class document consumers and rejects unknown targets", () => {
    const policy = anchorEvidencePolicy();
    assert.deepEqual(compileDocumentRelationsPolicy(policy), []);
    assert.deepEqual(compileEvidenceBindingsPolicy(policy), []);

    const unused = anchorEvidencePolicy({ evidence_bindings: [] });
    assert.ok(compileDocumentRelationsPolicy(unused).some((error) => /declared but unused/.test(error.message)));

    const missingTarget = anchorEvidencePolicy();
    missingTarget.evidence_bindings[0].target_anchor_type = "missing";
    assert.ok(compileEvidenceBindingsPolicy(missingTarget).some((error) => /unknown anchor type/.test(error.message)));

    const missingDocument = anchorEvidencePolicy();
    missingDocument.evidence_bindings[0].source.document = "missing";
    assert.ok(compileEvidenceBindingsPolicy(missingDocument).some((error) => /unknown document/.test(error.message)));
  });

  it("keeps the public schema narrow and non-executable", () => {
    assert.equal(loadPolicyRuntimeFromObject({ packageRoot: projectRoot, repoRoot: projectRoot }, anchorEvidencePolicy(), { quiet: true }).ok, true);

    const executable = anchorEvidencePolicy();
    executable.evidence_bindings[0].command = "pytest";
    assert.equal(loadPolicyRuntimeFromObject({ packageRoot: projectRoot, repoRoot: projectRoot }, executable, { quiet: true }).ok, false);

    const wrongType = anchorEvidencePolicy();
    wrongType.evidence_bindings[0].source.type = "repository_path_set";
    assert.equal(loadPolicyRuntimeFromObject({ packageRoot: projectRoot, repoRoot: projectRoot }, wrongType, { quiet: true }).ok, false);

    const scalarProjection = anchorEvidencePolicy();
    scalarProjection.evidence_bindings[0].source.projection = "value";
    assert.equal(loadPolicyRuntimeFromObject({ packageRoot: projectRoot, repoRoot: projectRoot }, scalarProjection, { quiet: true }).ok, false);
  });

  const run = (requiredCases, anchors) => {
    const policy = anchorEvidencePolicy();
    const documentsReader = createDocumentReader({
      readFile: (path) => path === "contracts/conformance.json" ? JSON.stringify({ requiredCases }) : "",
    });
    return evaluateConstraintIR({
      policy,
      changeIntent: null,
      diff: { files: { checked: [] } },
      documents: documentsReader,
      anchors,
    }).find((entry) => entry.name === "evidence-binding:cases-have-evidence")?.check;
  };

  it("normalizes source ids, preserves duplicate target locations, and reports missing ids", () => {
    const anchors = {
      byType: {
        case_evidence: [
          { value: "case-a", file: "tests/a.test", line: 10, column: 3 },
          { value: "case-a", file: "tests/b.test", line: 20, column: 7 },
          { value: "extra-case", file: "tests/extra.test", line: 1, column: 1 },
        ],
      },
    };
    const failed = run(["case-b", "case-a", "case-a"], anchors);
    assert.equal(failed.ok, false);
    assert.equal(failed.data.kind, "set_subset");
    assert.deepEqual(failed.data.left.value, ["case-a", "case-b"]);
    assert.deepEqual(failed.data.missing_values, ["case-b"]);
    assert.deepEqual(failed.data.right.provenance.instances.filter((item) => item.value === "case-a"), [
      { value: "case-a", file: "tests/a.test", line: 10, column: 3 },
      { value: "case-a", file: "tests/b.test", line: 20, column: 7 },
    ]);
    assert.deepEqual(failed.data.extra_values, ["extra-case"]);

    const passed = run(["case-a"], anchors);
    assert.equal(passed.ok, true);
    assert.deepEqual(passed.data.missing_values, []);
    assert.equal(passed.data.right.provenance.instances.filter((item) => item.value === "case-a").length, 2);
  });

  it("fails closed when canonical anchor facts are unavailable", () => {
    const result = run(["case-a"], undefined);
    assert.equal(result.ok, false);
    assert.equal(result.data.kind, "set_subset");
    assert.equal(result.data.right.ok, false);
    assert.equal(result.data.right.error.code, "document_read_error");
    assert.match(result.data.right.error.message, /repository anchor facts are unavailable/);
  });

  it("reuses evidence-binding strictness for adoption, removal, and target changes", async () => {
    const { compareConstraintPrograms } = await import("../dist/checks/constraint-program.mjs");
    const withoutBinding = anchorEvidencePolicy({ evidence_bindings: [] });
    assert.equal(compareConstraintPrograms(withoutBinding, anchorEvidencePolicy()).relation, "stricter");

    const removed = compareConstraintPrograms(anchorEvidencePolicy(), withoutBinding);
    assert.equal(removed.relation, "weaker");
    assert.ok(removed.relaxations.some((item) => item.kind === "evidence_binding_removed"));

    const changedTarget = anchorEvidencePolicy();
    changedTarget.anchors.types.other_evidence = { sources: [{ kind: "regex", glob: "tests/**", pattern: "OTHER:([a-z-]+)" }] };
    changedTarget.evidence_bindings[0].target_anchor_type = "other_evidence";
    const changed = compareConstraintPrograms(anchorEvidencePolicy(), changedTarget);
    assert.equal(changed.relation, "incomparable");
    assert.ok(changed.incomparable.some((item) => /evidence binding/.test(item.message)));
  });
});
