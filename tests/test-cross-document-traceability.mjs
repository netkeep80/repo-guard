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
        traceability: { path: "fixtures/traceability.json", format: "json" },
        specification: { path: "fixtures/specification.json", format: "json" },
        evidence: { path: "fixtures/evidence.json", format: "json" },
      },
      rules: [
        {
          id: "obligation-ids-match",
          kind: "set_equal",
          left: { document: "traceability", pointer: "/obligations", projection: "object_keys", type: "string_set" },
          right: { document: "specification", pointer: "/requirements", projection: "object_keys", type: "string_set" },
        },
        {
          id: "alpha-cases-known",
          kind: "set_subset",
          left: { document: "traceability", pointer: "/obligations/alpha/positiveCases", projection: "array_items", type: "string_set" },
          right: { document: "evidence", pointer: "/caseIds", projection: "array_items", type: "string_set" },
        },
        {
          id: "alpha-spec-pointer-resolves",
          kind: "referenced_pointer_exists",
          source: { document: "traceability", pointer: "/obligations/alpha/specPointer", type: "string" },
          target_document: "specification",
        },
      ],
    },
  };
}

function traceabilityFiles(overrides = {}) {
  const traceability = {
    obligations: {
      alpha: {
        specPointer: "/requirements/alpha",
        positiveCases: ["case-alpha"],
      },
    },
  };
  const specification = {
    requirements: {
      alpha: { description: "alpha requirement" },
    },
  };
  const evidence = {
    caseIds: ["case-alpha", "case-extra"],
  };
  return {
    "fixtures/traceability.json": JSON.stringify(overrides.traceability ?? traceability),
    "fixtures/specification.json": JSON.stringify(overrides.specification ?? specification),
    "fixtures/evidence.json": JSON.stringify(overrides.evidence ?? evidence),
  };
}

it("projects object keys for stable identity coverage", () => {
  const document = {
    obligations: {
      beta: { specPointer: "/requirements/beta" },
      alpha: { specPointer: "/requirements/alpha" },
    },
  };

  const keys = projectDocumentValue(document, "/obligations", "object_keys");

  assert.deepEqual(keys, ["beta", "alpha"]);
  assert.deepEqual(normalizeDocumentFact(keys, "string_set"), ["alpha", "beta"]);
});

it("fails closed when object_keys targets a non-object", () => {
  assert.throws(
    () => projectDocumentValue({ obligations: ["alpha"] }, "/obligations", "object_keys"),
    /requires an object/,
  );
});

it("executes set equality, subset and referenced-pointer relations through the canonical pipeline", () => {
  const result = runTraceability(traceabilityPolicy(), traceabilityFiles());

  assert.equal(result.ruleResults.find((item) => item.rule === "document-relation:obligation-ids-match")?.ok, true);
  assert.equal(result.ruleResults.find((item) => item.rule === "document-relation:alpha-cases-known")?.ok, true);
  assert.equal(result.ruleResults.find((item) => item.rule === "document-relation:alpha-spec-pointer-resolves")?.ok, true);
});

it("normalizes set order and duplicates deterministically", () => {
  const files = traceabilityFiles({
    traceability: {
      obligations: {
        alpha: {
          specPointer: "/requirements/alpha",
          positiveCases: ["case-b", "case-alpha", "case-b"],
        },
      },
    },
    evidence: { caseIds: ["case-alpha", "case-b", "case-alpha"] },
  });
  const result = runTraceability(traceabilityPolicy(), files);
  const relation = result.ruleResults.find((item) => item.rule === "document-relation:alpha-cases-known");

  assert.equal(relation?.ok, true);
  assert.deepEqual(relation?.data?.left?.value, ["case-alpha", "case-b"]);
  assert.deepEqual(relation?.data?.right?.value, ["case-alpha", "case-b"]);
});

it("reports exact missing set members", () => {
  const files = traceabilityFiles({
    traceability: {
      obligations: {
        alpha: {
          specPointer: "/requirements/alpha",
          positiveCases: ["case-alpha", "case-unknown"],
        },
      },
    },
  });
  const result = runTraceability(traceabilityPolicy(), files);
  const violation = result.violations.find((item) => item.rule === "document-relation:alpha-cases-known");

  assert.equal(Boolean(violation), true);
  assert.deepEqual(violation?.data?.missing_values, ["case-unknown"]);
});

it("fails closed when a set selector has the wrong collection shape", () => {
  const files = traceabilityFiles({
    traceability: {
      obligations: {
        alpha: {
          specPointer: "/requirements/alpha",
          positiveCases: "case-alpha",
        },
      },
    },
  });
  const result = runTraceability(traceabilityPolicy(), files);
  const violation = result.violations.find((item) => item.rule === "document-relation:alpha-cases-known");

  assert.equal(Boolean(violation), true);
  assert.equal(violation?.data?.left?.error?.code, "projection_type_mismatch");
});

it("fails closed when a referenced JSON Pointer is dangling", () => {
  const files = traceabilityFiles({
    traceability: {
      obligations: {
        alpha: {
          specPointer: "/requirements/missing",
          positiveCases: ["case-alpha"],
        },
      },
    },
  });
  const result = runTraceability(traceabilityPolicy(), files);
  const violation = result.violations.find((item) => item.rule === "document-relation:alpha-spec-pointer-resolves");

  assert.equal(Boolean(violation), true);
  assert.equal(violation?.data?.target?.error?.code, "missing_pointer_segment");
});

it("fails closed when a referenced JSON Pointer is malformed", () => {
  const files = traceabilityFiles({
    traceability: {
      obligations: {
        alpha: {
          specPointer: "/requirements/~2invalid",
          positiveCases: ["case-alpha"],
        },
      },
    },
  });
  const result = runTraceability(traceabilityPolicy(), files);
  const violation = result.violations.find((item) => item.rule === "document-relation:alpha-spec-pointer-resolves");

  assert.equal(Boolean(violation), true);
  assert.equal(violation?.data?.target?.error?.code, "malformed_pointer");
});

it("fails closed when the referenced-pointer source value is not a string", () => {
  const files = traceabilityFiles({
    traceability: {
      obligations: {
        alpha: {
          specPointer: ["/requirements/alpha"],
          positiveCases: ["case-alpha"],
        },
      },
    },
  });
  const result = runTraceability(traceabilityPolicy(), files);
  const violation = result.violations.find((item) => item.rule === "document-relation:alpha-spec-pointer-resolves");

  assert.equal(Boolean(violation), true);
  assert.equal(violation?.data?.source?.error?.code, "fact_type_mismatch");
});

it("accepts a synthetic non-domain traceability policy through the public schema and semantic compiler", () => {
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
  executable.document_relations.rules[1].command = "run-tests";
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
  withoutSubset.document_relations.rules = withoutSubset.document_relations.rules.filter((rule) => rule.id !== "alpha-cases-known");

  const added = compareConstraintPrograms(withoutSubset, full);
  assert.equal(added.relation, "stricter");
  assert.deepEqual(added.relaxations, []);

  const removed = compareConstraintPrograms(full, withoutSubset);
  assert.equal(removed.relation, "weaker");
  assert.ok(removed.relaxations.some((item) => item.kind === "document_relation_removed" && item.rule_id === "alpha-cases-known"));

  const retargeted = structuredClone(full);
  retargeted.document_relations.rules.find((rule) => rule.id === "alpha-spec-pointer-resolves").target_document = "evidence";
  const edited = compareConstraintPrograms(full, retargeted);
  assert.equal(edited.relation, "incomparable");
  assert.ok(edited.incomparable.some((item) => item.pointer === "/document_relations/rules/alpha-spec-pointer-resolves"));
});
