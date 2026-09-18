import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileConstraintProgram, runtimeConstraints } from "../dist/checks/constraint-program.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
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

const schema = JSON.parse(read("schemas/repo-policy.schema.json"));
const evidenceKinds = (schema.definitions?.evidence_binding?.oneOf || [])
  .map((entry) => entry?.properties?.kind?.const)
  .filter((value) => typeof value === "string")
  .sort();
expect("public evidence binding vocabulary contains only anchor_value_coverage", evidenceKinds, ["anchor_value_coverage"]);

const basePolicy = {
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: { forbidden: [], canonical_docs: [], operational_paths: [], governance_paths: [] },
  diff_rules: {},
  content_rules: [],
  cochange_rules: [],
};

const referencedPaths = {
  id: "owners-exist",
  kind: "referenced_paths_exist",
  source: {
    document: "contract",
    pointer: "/owners",
    projection: "object_values",
    type: "repository_path_set",
  },
};

const legacyPolicy = {
  ...basePolicy,
  integration: {
    workflows: [{
      id: "project-ci",
      kind: "github_actions",
      path: ".github/workflows/ci.yml",
      role: "ci_gate",
      expect: {
        events: ["pull_request"],
        enforcement: "blocking",
        disallow: ["continue_on_error"],
      },
    }],
  },
  document_relations: {
    documents: { contract: { path: "contracts/contract.json", format: "json" } },
    rules: [referencedPaths],
  },
  evidence_bindings: [{
    id: "owners-covered",
    kind: "workflow_path_coverage",
    source: referencedPaths.source,
    workflow: "project-ci",
    covers: ["tests/**"],
  }],
};

const legacyRuntime = runtimeConstraints(compileConstraintProgram(legacyPolicy));
expect(
  "constraint compiler emits no historical workflow coverage runtime",
  legacyRuntime.some((item) => item.kind === "evidence_workflow_path_coverage"),
  false,
);

const runtimeSource = read("src/checks/rules/constraints.mts");
expect(
  "runtime evaluator contains no workflow coverage kind or dedicated helper",
  runtimeSource.includes("evidence_workflow_path_coverage") || runtimeSource.includes("checkEvidenceWorkflowPathCoverage"),
  false,
);

expect(
  "superseded integration evaluator source is physically absent",
  existsSync(resolve(root, "src/checks/integration-constraints.mts")),
  false,
);
expect(
  "superseded integration evaluator dist is physically absent",
  existsSync(resolve(root, "dist/checks/integration-constraints.mjs")),
  false,
);

const policyCompilerSource = read("src/policy-compiler.mts");
expect(
  "semantic policy compiler contains no workflow path coverage branch",
  policyCompilerSource.includes("workflow_path_coverage"),
  false,
);

expect(
  "self-hosted repo policy does not consume workflow path coverage",
  read("repo-policy.json").includes("workflow_path_coverage"),
  false,
);
expect(
  "init does not generate workflow path coverage",
  read("src/init.mts").includes("workflow_path_coverage"),
  false,
);

const anchorPolicy = {
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
    source: {
      document: "conformance",
      pointer: "/requiredCases",
      projection: "array_items",
      type: "string_set",
    },
    target_anchor_type: "case_evidence",
  }],
};
const anchorRuntime = runtimeConstraints(compileConstraintProgram(anchorPolicy));
const anchorCoverage = anchorRuntime.find((item) => item.relation_id === "evidence:cases-have-evidence");
expect("anchor value coverage remains primitive_relation", anchorCoverage?.kind, "primitive_relation");
expect("anchor value coverage remains set_subset", anchorCoverage?.primitive, "set_subset");
expect("relation descriptor count remains ten", relationDescriptors().length, 10);

const factSourceMatch = read("src/document-facts.mts").match(/export type FactSource = ([^;]+);/);
const factSources = factSourceMatch
  ? [...factSourceMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort()
  : [];
expect("FactRef source vocabulary remains the accepted four", factSources, [
  "change_intent",
  "diff",
  "document",
  "repository",
]);

console.log(`\n${failures === 0 ? "C3.3c workflow path coverage deletion contract passed" : `C3.3c deletion RED confirmed by ${failures} failing probe(s)`}`);
process.exit(failures === 0 ? 0 : 1);
