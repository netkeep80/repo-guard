import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { compileDocumentRelationsPolicy, compileForbidRegex, compileIntegrationPolicy } from "../dist/policy-compiler.mjs";
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
const relationPolicy = (overrides = {}) => ({
  document_relations: { documents: structuredClone(documents), rules: [structuredClone(scalarEqual), structuredClone(scalarLiteral)], ...overrides },
});

describe("semantic policy compiler boundary", () => {
  it("keeps non-array nested values inert before semantic compilation", () => {
    assert.deepEqual(compileForbidRegex([{ id: "bad", forbid_regex: "[invalid" }]), []);
    assert.deepEqual(compileIntegrationPolicy({
      integration: {
        workflows: [{ id: "gate", profiles: "missing" }],
        docs: [{ id: "readme", must_mention_profiles: "missing" }],
      },
    }), []);
  });

  it("accepts semantically consistent scalar document relations", () => {
    assert.deepEqual(compileDocumentRelationsPolicy(relationPolicy()), []);
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

  it("accepts only the executable R2a scalar relation kinds", () => {
    assert.equal(validate(relationPolicy().document_relations).ok, true);
    assert.equal(validate({ documents, rules: [{ ...scalarEqual, kind: "set_equal" }] }).ok, false);
  });

  it("rejects collection projections and unsupported document formats in R2a schema", () => {
    assert.equal(validate({
      documents,
      rules: [{ ...scalarEqual, left: { ...scalarEqual.left, projection: "array_items" } }],
    }).ok, false);
    assert.equal(validate({
      documents: { contract: { path: "contracts/contract.md", format: "markdown" } },
      rules: [{ ...scalarLiteral, source: { ...scalarLiteral.source, document: "contract" } }],
    }).ok, false);
  });
});
