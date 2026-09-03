import { it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
import {
  normalizeDocumentFact,
  projectDocumentValue,
} from "../dist/document-facts.mjs";
import { compileDocumentRelationsPolicy } from "../dist/policy-compiler.mjs";
import { runPolicyPipeline } from "../dist/runtime/pipeline.mjs";
import { loadPolicyRuntimeFromObject } from "../dist/runtime/validation.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const basePolicy = {
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: {
    forbidden: [],
    canonical_docs: [],
    governance_paths: ["repo-policy.json"],
  },
  diff_rules: {
    max_new_docs: 5,
    max_new_files: 5,
    max_net_added_lines: 500,
  },
  content_rules: [],
  cochange_rules: [],
};

function runTraceability(policy, files) {
  return runPolicyPipeline({
    mode: "check-diff",
    repositoryRoot: "/tmp/repo-guard-traceability-test",
    policy,
    changeIntent: null,
    changeIntentSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText: "",
    trackedFiles: ["repo-policy.json"],
    readFile: (path) => files[path],
    initialChecks: [],
  }, { quiet: true });
}

function traceabilityPolicy() {
  return {
    ...basePolicy,
    document_relations: {
      documents: {
        traceability: { path: "traceability/mts-v0.11.json", format: "json" },
        contract: { path: "contracts/mts-contract-v0.11.json", format: "json" },
        conformance: { path: "contracts/mts-conformance-v0.11.json", format: "json" },
      },
      rules: [
        {
          id: "invariant-ids-match",
          kind: "set_equal",
          left: { document: "traceability", pointer: "/invariants", projection: "object_keys", type: "string_set" },
          right: { document: "contract", pointer: "/requiredSemanticLaws", projection: "object_keys", type: "string_set" },
        },
        {
          id: "alpha-positive-known",
          kind: "set_subset",
          left: { document: "traceability", pointer: "/invariants/alpha/positive", projection: "array_items", type: "string_set" },
          right: { document: "conformance", pointer: "/requiredGenesisVectors", projection: "array_items", type: "string_set" },
        },
        {
          id: "alpha-contract-pointer-resolves",
          kind: "referenced_pointer_exists",
          source: { document: "traceability", pointer: "/invariants/alpha/contractPointer", type: "string" },
          target_document: "contract",
        },
      ],
    },
  };
}

function traceabilityFiles(overrides = {}) {
  const traceability = {
    invariants: {
      alpha: {
        contractPointer: "/requiredSemanticLaws/alpha",
        positive: ["genesis-alpha"],
      },
    },
  };
  const contract = {
    requiredSemanticLaws: {
      alpha: { description: "alpha law" },
    },
  };
  const conformance = {
    requiredGenesisVectors: ["genesis-alpha", "genesis-extra"],
  };
  return {
    "traceability/mts-v0.11.json": JSON.stringify(overrides.traceability ?? traceability),
    "contracts/mts-contract-v0.11.json": JSON.stringify(overrides.contract ?? contract),
    "contracts/mts-conformance-v0.11.json": JSON.stringify(overrides.conformance ?? conformance),
  };
}

it("projects object keys for invariant identity coverage", () => {
  const document = {
    invariants: {
      beta: { contractPointer: "/laws/beta" },
      alpha: { contractPointer: "/laws/alpha" },
    },
  };

  const keys = projectDocumentValue(document, "/invariants", "object_keys");

  assert.deepEqual(keys, ["beta", "alpha"]);
  assert.deepEqual(normalizeDocumentFact(keys, "string_set"), ["alpha", "beta"]);
});

it("fails closed when object_keys targets a non-object", () => {
  assert.throws(
    () => projectDocumentValue({ invariants: ["alpha"] }, "/invariants", "object_keys"),
    /requires an object/,
  );
});

it("executes set equality, subset and referenced-pointer relations through the canonical pipeline", () => {
  const result = runTraceability(traceabilityPolicy(), traceabilityFiles());

  assert.equal(result.ruleResults.find((item) => item.rule === "document-relation:invariant-ids-match")?.ok, true);
  assert.equal(result.ruleResults.find((item) => item.rule === "document-relation:alpha-positive-known")?.ok, true);
  assert.equal(result.ruleResults.find((item) => item.rule === "document-relation:alpha-contract-pointer-resolves")?.ok, true);
});

it("reports exact missing set members", () => {
  const files = traceabilityFiles({
    traceability: {
      invariants: {
        alpha: {
          contractPointer: "/requiredSemanticLaws/alpha",
          positive: ["genesis-alpha", "unknown-vector"],
        },
      },
    },
  });
  const result = runTraceability(traceabilityPolicy(), files);
  const violation = result.violations.find((item) => item.rule === "document-relation:alpha-positive-known");

  assert.equal(Boolean(violation), true);
  assert.deepEqual(violation?.data?.missing_values, ["unknown-vector"]);
});

it("fails closed when a referenced JSON Pointer is dangling", () => {
  const files = traceabilityFiles({
    traceability: {
      invariants: {
        alpha: {
          contractPointer: "/requiredSemanticLaws/missing",
          positive: ["genesis-alpha"],
        },
      },
    },
  });
  const result = runTraceability(traceabilityPolicy(), files);
  const violation = result.violations.find((item) => item.rule === "document-relation:alpha-contract-pointer-resolves");

  assert.equal(Boolean(violation), true);
  assert.equal(violation?.data?.target?.error?.code, "missing_pointer_segment");
});

it("accepts the synthetic traceability policy through the public schema and semantic compiler", () => {
  const policy = traceabilityPolicy();
  const loaded = loadPolicyRuntimeFromObject(
    { packageRoot: projectRoot, repoRoot: projectRoot },
    policy,
    { quiet: true },
  );

  assert.equal(loaded.ok, true);
  assert.deepEqual(compileDocumentRelationsPolicy(policy), []);
});

it("semantic compilation rejects an unknown referenced-pointer target document", () => {
  const policy = traceabilityPolicy();
  policy.document_relations.rules[2].target_document = "missing";
  const messages = compileDocumentRelationsPolicy(policy).map((error) => error.message);

  assert.ok(messages.some((message) => /target_document.*unknown document "missing"/.test(message)));
});

it("public schema keeps traceability relations narrow and non-executable", () => {
  const executable = traceabilityPolicy();
  executable.document_relations.rules[1].command = "pytest";
  assert.equal(loadPolicyRuntimeFromObject(
    { packageRoot: projectRoot, repoRoot: projectRoot }, executable, { quiet: true },
  ).ok, false);

  const wrongPointerSource = traceabilityPolicy();
  wrongPointerSource.document_relations.rules[2].source.type = "string_set";
  assert.equal(loadPolicyRuntimeFromObject(
    { packageRoot: projectRoot, repoRoot: projectRoot }, wrongPointerSource, { quiet: true },
  ).ok, false);
});

it("keeps new traceability relations monotonic under the existing Constraint Program model", () => {
  const full = traceabilityPolicy();
  const withoutSubset = structuredClone(full);
  withoutSubset.document_relations.rules = withoutSubset.document_relations.rules.filter((rule) => rule.id !== "alpha-positive-known");

  const added = compareConstraintPrograms(withoutSubset, full);
  assert.equal(added.relation, "stricter");
  assert.deepEqual(added.relaxations, []);

  const removed = compareConstraintPrograms(full, withoutSubset);
  assert.equal(removed.relation, "weaker");
  assert.ok(removed.relaxations.some((item) => item.kind === "document_relation_removed" && item.rule_id === "alpha-positive-known"));

  const retargeted = structuredClone(full);
  retargeted.document_relations.rules.find((rule) => rule.id === "alpha-contract-pointer-resolves").target_document = "conformance";
  const edited = compareConstraintPrograms(full, retargeted);
  assert.equal(edited.relation, "incomparable");
  assert.ok(edited.incomparable.some((item) => item.pointer === "/document_relations/rules/alpha-contract-pointer-resolves"));
});
