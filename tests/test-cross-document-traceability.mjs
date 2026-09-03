import { it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDocumentFact,
  projectDocumentValue,
} from "../dist/document-facts.mjs";
import { runPolicyPipeline } from "../dist/runtime/pipeline.mjs";

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
