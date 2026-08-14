import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPolicyFacts } from "../dist/facts/input.mjs";
import { createIntegrationAnalysisReport } from "../dist/integration-validator.mjs";
import { runPolicyPipeline } from "../dist/runtime/pipeline.mjs";

let failures = 0;
const __dirname = new URL(".", import.meta.url).pathname;
const projectRoot = resolve(__dirname, "..");

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS: ${label}`);
  } catch (e) {
    failures++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

const policy = {
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: {
    forbidden: ["secrets/**"],
    canonical_docs: ["README.md"],
    operational_paths: [".github/**"],
    governance_paths: ["repo-policy.json"],
  },
  diff_rules: {
    max_new_docs: 5,
    max_new_files: 3,
    max_net_added_lines: 500,
  },
  surfaces: {
    source: ["src/**"],
    docs: ["docs/**"],
  },
  new_file_classes: {
    source: ["src/**"],
  },
  content_rules: [],
  cochange_rules: [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }],
};

const diffText = [
  "diff --git a/src/feature.mjs b/src/feature.mjs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/feature.mjs",
  "+export const value = 1;",
  "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
  "--- a/.github/workflows/ci.yml",
  "+++ b/.github/workflows/ci.yml",
  "+name: ci",
].join("\n");

function runEquivalentInput(extra = {}) {
  return runPolicyPipeline({
    mode: "check-diff",
    repositoryRoot: "/tmp/repo-guard-test",
    policy,
    changeIntent: null,
    changeIntentSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText,
    trackedFiles: ["README.md", "src/existing.mjs"],
    initialChecks: [],
    ...extra,
  }, { quiet: true });
}

function buildEquivalentFacts(extra = {}) {
  return buildPolicyFacts({
    mode: "check-diff",
    repositoryRoot: "/tmp/repo-guard-test",
    policy,
    changeIntent: null,
    changeIntentSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText,
    trackedFiles: ["README.md", "src/existing.mjs"],
    ...extra,
  });
}

function expectCanonicalEnvelope(label, report, command) {
  const canonicalKeys = [
    "command", "mode", "ok", "result", "passed", "failed", "violations", "advisoryWarnings", "warnings",
    "violationCount", "exitCode", "ruleResults", "hints", "repositoryRoot",
  ];
  expect(`${label} command`, report.command, command);
  expect(`${label} canonical keys`, canonicalKeys.every((key) => Object.prototype.hasOwnProperty.call(report, key)), true);
  expect(`${label} ruleResults array`, Array.isArray(report.ruleResults), true);
  expect(`${label} violations array`, Array.isArray(report.violations), true);
  expect(`${label} hints array`, Array.isArray(report.hints), true);
  expect(`${label} canonical check result shape`, report.ruleResults.every((item) =>
    typeof item.rule === "string" && typeof item.ok === "boolean" && ["pass", "warning", "failure"].includes(item.severity) && Array.isArray(item.details)
  ), true);
}

function makeIntegrationKernelRepo() {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-kernel-"));
  const policy = {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: { forbidden: [], canonical_docs: ["README.md"], governance_paths: ["repo-policy.json"] },
    diff_rules: { max_new_docs: 5, max_new_files: 5, max_net_added_lines: 500 },
    content_rules: [], cochange_rules: [],
  };
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(policy, null, 2));
  writeFileSync(join(dir, "README.md"), "# Test\n");
  return dir;
}

console.log("\n--- shared policy pipeline normalizes facts and checks ---");
{
  const facts = buildEquivalentFacts();
  const result = runEquivalentInput();
  expect("pipeline records changed files before and after operational filtering", result.diff, { changedFiles: 2, checkedFiles: 1, skippedOperationalFiles: 1 });
  expect("facts identify check-diff mode", facts.mode, "check-diff");
  expect("facts identify ChangeIntent source", facts.changeIntentSource, "none");
  expect("facts expose all diff files", facts.diff.files.all.map((file) => file.path), ["src/feature.mjs", ".github/workflows/ci.yml"]);
  expect("facts expose checked diff files", facts.diff.files.checked.map((file) => file.path), ["src/feature.mjs"]);
  expect("facts expose skipped operational files", facts.diff.files.skippedOperational.map((file) => file.path), [".github/workflows/ci.yml"]);
  expect("facts expose normalized changed paths", facts.derived.changedPaths, ["src/feature.mjs"]);
  expect("facts extract touched surfaces", facts.derived.touchedSurfaces.touched_surfaces, ["source"]);
  expect("facts classify new files", facts.derived.newFileClasses.files_by_class, { source: ["src/feature.mjs"] });
  expect("pipeline runs existing checks", result.violations.some((violation) => violation.rule.startsWith("cochange:")), true);
}

console.log("\n--- pipeline accepts only canonical ChangeIntent input ---");
{
  const changeIntent = {
    change_type: "refactor",
    must_touch: [],
    must_not_touch: ["src/**"],
    expected_effects: ["exercise ChangeIntent boundary"],
  };
  const canonical = runEquivalentInput({ changeIntent, changeIntentSource: "test" });
  const legacy = runEquivalentInput({ contract: changeIntent, contractSource: "legacy test" });
  expect("canonical ChangeIntent reaches runtime constraints", canonical.violations.some((violation) => violation.rule === "must-not-touch"), true);
  expect("legacy contract input is not a supported alias", legacy.violations.some((violation) => violation.rule === "must-not-touch"), false);
}

console.log("\n--- equivalent command inputs share one result shape ---");
{
  const checkDiffStyle = runEquivalentInput();
  const checkPrStyle = runEquivalentInput({
    mode: "check-pr",
    changeIntentSource: "pr body",
    initialChecks: [{ name: "change-intent", check: { ok: true } }],
  });
  const integrationRepo = makeIntegrationKernelRepo();
  const validateIntegrationStyle = createIntegrationAnalysisReport({ packageRoot: projectRoot, repoRoot: integrationRepo, enforcementMode: null }, { format: "json" });
  const checkDiffFacts = buildEquivalentFacts();
  const checkPrFacts = buildEquivalentFacts({ mode: "check-pr", changeIntentSource: "pr body" });

  expectCanonicalEnvelope("check-diff report", checkDiffStyle, "check-diff");
  expectCanonicalEnvelope("check-pr report", checkPrStyle, "check-pr");
  expectCanonicalEnvelope("validate-integration report", validateIntegrationStyle, "validate-integration");
  expect("check-pr initial validation check stays first", checkPrStyle.ruleResults[0]?.rule, "change-intent");
  expect("equivalent facts keep mode-specific provenance", { mode: checkPrFacts.mode, changeIntentSource: checkPrFacts.changeIntentSource }, { mode: "check-pr", changeIntentSource: "pr body" });
  expect("equivalent facts share checked diff paths", checkPrFacts.derived.changedPaths, checkDiffFacts.derived.changedPaths);
  expect("check-pr style input adds ChangeIntent validation without changing policy check result", checkPrStyle.violations.map((violation) => violation.rule), checkDiffStyle.violations.map((violation) => violation.rule));
  rmSync(integrationRepo, { recursive: true });
}

console.log("\n--- check-pr style pipeline evaluates size rules ---");
{
  const sizeResult = runEquivalentInput({
    mode: "check-pr",
    policy: {
      ...policy,
      size_rules: [{ id: "max-feature-lines", scope: "file", metric: "lines", glob: "src/feature.mjs", max: 0, count: "changed_only" }],
    },
    readFile: (path) => path === "src/feature.mjs" ? "export const value = 1;\n" : "",
  });

  const violation = sizeResult.violations.find((item) => item.rule === "size-rules");
  expect("check-pr pipeline reports size-rules violation", Boolean(violation), true);
  expect("check-pr pipeline reports offending file", violation?.data?.size_violations?.[0]?.path, "src/feature.mjs");
  expect("check-pr pipeline reports measured lines", violation?.data?.size_violations?.[0]?.actual, 1);
}

console.log("\n--- scalar document relations execute through Constraint Program ---");
{
  const relationPolicy = {
    ...policy,
    document_relations: {
      documents: {
        contract: { path: "contracts/contract.json", format: "json" },
        conformance: { path: "contracts/conformance.yaml", format: "yaml" },
      },
      rules: [
        {
          id: "contract-id-matches",
          kind: "scalar_equal",
          left: { document: "conformance", pointer: "/contract", type: "string" },
          right: { document: "contract", pointer: "/id", type: "string" },
        },
        {
          id: "root-is-infinity",
          kind: "scalar_equals_literal",
          source: { document: "contract", pointer: "/root", type: "string" },
          value: "∞",
        },
      ],
    },
  };
  const files = {
    "contracts/contract.json": JSON.stringify({ id: "mts-v0.7", root: "∞" }),
    "contracts/conformance.yaml": "contract: mts-v0.7\nenabled: true\n",
  };
  const readFile = (path) => files[path];
  const passing = runEquivalentInput({ policy: relationPolicy, readFile });
  expect("JSON/YAML scalar equality passes", passing.ruleResults.find((item) => item.rule === "document-relation:contract-id-matches")?.ok, true);
  expect("scalar literal relation passes", passing.ruleResults.find((item) => item.rule === "document-relation:root-is-infinity")?.ok, true);

  const mismatch = runEquivalentInput({
    policy: relationPolicy,
    readFile: (path) => path === "contracts/conformance.yaml" ? "contract: other\n" : files[path],
  });
  const mismatchViolation = mismatch.violations.find((item) => item.rule === "document-relation:contract-id-matches");
  expect("scalar mismatch fails in same pipeline", Boolean(mismatchViolation), true);
  expect("scalar mismatch exposes relation kind", mismatchViolation?.data?.kind, "scalar_equal");
  expect("scalar mismatch exposes normalized left value", mismatchViolation?.data?.left?.value, "other");
  expect("scalar mismatch exposes normalized right value", mismatchViolation?.data?.right?.value, "mts-v0.7");

  const missingDocument = runEquivalentInput({ policy: relationPolicy, readFile: (path) => path === "contracts/contract.json" ? undefined : files[path] });
  const missingViolation = missingDocument.violations.find((item) => item.rule === "document-relation:contract-id-matches");
  expect("missing document fails relation implicitly", Boolean(missingViolation), true);
  expect("missing document surfaces structured read error", missingViolation?.data?.right?.error?.code, "document_read_error");

  const malformedPointerPolicy = structuredClone(relationPolicy);
  malformedPointerPolicy.document_relations.rules[0].left.pointer = "/contract~2";
  const malformedPointer = runEquivalentInput({ policy: malformedPointerPolicy, readFile });
  const pointerViolation = malformedPointer.violations.find((item) => item.rule === "document-relation:contract-id-matches");
  expect("malformed pointer fails closed", pointerViolation?.data?.left?.error?.code, "malformed_pointer");

  const wrongTypePolicy = structuredClone(relationPolicy);
  wrongTypePolicy.document_relations.rules[0].left = { document: "conformance", pointer: "/enabled", type: "string" };
  const wrongType = runEquivalentInput({ policy: wrongTypePolicy, readFile });
  const typeViolation = wrongType.violations.find((item) => item.rule === "document-relation:contract-id-matches");
  expect("wrong scalar type fails closed", typeViolation?.data?.left?.error?.code, "fact_type_mismatch");
}

console.log("\n--- referenced repository paths execute through Constraint Program ---");
{
  const relationPolicy = {
    ...policy,
    document_relations: {
      documents: { contract: { path: "contracts/contract.json", format: "json" } },
      rules: [
        {
          id: "owners-exist",
          kind: "referenced_paths_exist",
          source: { document: "contract", pointer: "/owners", projection: "object_values", type: "repository_path_set" },
        },
        {
          id: "gates-exist",
          kind: "referenced_paths_exist",
          source: { document: "contract", pointer: "/gates", projection: "array_items", type: "repository_path_set" },
        },
      ],
    },
  };
  const contract = {
    owners: { spec: "./docs/spec.md", verify: "tests/verify.mjs", duplicate: "docs/spec.md" },
    gates: ["tests/gate.mjs", "docs/spec.md", "tests/gate.mjs"],
  };
  const readFile = (path) => path === "contracts/contract.json" ? JSON.stringify(contract) : undefined;
  const trackedFiles = ["docs/spec.md", "tests/verify.mjs", "tests/gate.mjs"];
  const passing = runEquivalentInput({ policy: relationPolicy, readFile, trackedFiles });
  const ownersPass = passing.ruleResults.find((item) => item.rule === "document-relation:owners-exist");
  const gatesPass = passing.ruleResults.find((item) => item.rule === "document-relation:gates-exist");
  expect("object_values path references pass", ownersPass?.ok, true);
  expect("array_items path references pass", gatesPass?.ok, true);
  expect("repository path set normalizes and deduplicates object values", ownersPass?.data?.referenced_paths, ["docs/spec.md", "tests/verify.mjs"]);
  expect("repository path set normalizes and deduplicates array items", gatesPass?.data?.referenced_paths, ["docs/spec.md", "tests/gate.mjs"]);

  const missing = runEquivalentInput({ policy: relationPolicy, readFile, trackedFiles: ["docs/spec.md"] });
  expect("missing object reference fails", missing.violations.find((item) => item.rule === "document-relation:owners-exist")?.data?.missing_paths, ["tests/verify.mjs"]);
  expect("missing array reference fails", missing.violations.find((item) => item.rule === "document-relation:gates-exist")?.data?.missing_paths, ["tests/gate.mjs"]);

  const invalidContract = { ...contract, gates: ["../escape.mjs"] };
  const invalid = runEquivalentInput({
    policy: relationPolicy,
    readFile: (path) => path === "contracts/contract.json" ? JSON.stringify(invalidContract) : undefined,
    trackedFiles,
  });
  expect("invalid repository path stays a structured R1 failure", invalid.violations.find((item) => item.rule === "document-relation:gates-exist")?.data?.source?.error?.code, "invalid_repository_path");

  const noTrackedFacts = runEquivalentInput({ policy: relationPolicy, readFile, trackedFiles: undefined });
  const noTrackedViolation = noTrackedFacts.violations.find((item) => item.rule === "document-relation:owners-exist");
  expect("missing tracked repository facts fail closed", Boolean(noTrackedViolation), true);
  expect("missing tracked repository facts are explicit", noTrackedViolation?.data?.tracked_repository_available, false);
}

console.log(`\n${failures === 0 ? "All tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
