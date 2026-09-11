import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import Ajv from "ajv";
import { compileContractConformancePolicy, compileProfilePolicy, resolvePolicyProfile } from "../dist/policy-profiles.mjs";
import { loadJSON, loadPolicyRuntime } from "../dist/runtime/validation.mjs";
import { runPolicyPipeline } from "../dist/runtime/pipeline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

let failures = 0;

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

function expectIncludes(label, value, substring) {
  const actual = String(value || "");
  const passed = actual.includes(substring);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected ${JSON.stringify(actual)} to include ${JSON.stringify(substring)}`);
  }
}

function foundationPolicy() {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "library",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
    },
    diff_rules: { max_new_docs: 2, max_new_files: 10, max_net_added_lines: 1000 },
    content_rules: [],
    cochange_rules: [],
  };
}

const requirementEvidence = [
  "include/**", "src/**", "tests/**", "examples/**", "docs/**", "README.md",
  "requirements/README.md", "scripts/**", ".github/workflows/**",
];

function requirementsPolicy(overrides = {}) {
  return {
    ...foundationPolicy(),
    packs: {
      "requirements-strict": {
        strict_heading_docs: ["docs/architecture.md", "docs/pmm_requirements.md"],
        evidence_surfaces: requirementEvidence,
        ...overrides,
      },
    },
  };
}

function traceRule(policy, id) {
  return policy.trace_rules?.find((rule) => rule.id === id);
}

function contractConformanceMacro(overrides = {}) {
  return {
    current: {
      contract: { path: "contracts/spec-v2.json", format: "json" },
      conformance: { path: "contracts/checks-v2.yaml", format: "yaml" },
    },
    pair_fields: {
      contract_id: "/schema",
      conformance_contract_id: "/contract",
      contract_conformance_path: "/conformanceCorpus",
      contract_status: "/status",
      conformance_status: "/status",
      contract_accepted: "/accepted",
      conformance_accepted: "/accepted",
    },
    accepted_state: { status: "accepted", accepted: true },
    required_paths: [
      { document: "current.contract", pointer: "/owners", projection: "object_values" },
      { document: "current.conformance", pointer: "/requiredGates", projection: "array_items" },
    ],
    cochange: ["current.contract", "current.conformance"],
    control_paths: ["contracts/**"],
    ...overrides,
  };
}

function historyContractConformanceMacro(overrides = {}) {
  return contractConformanceMacro({
    previous: {
      contract: { path: "contracts/spec-v1.json", format: "json" },
      conformance: { path: "contracts/checks-v1.json", format: "json" },
    },
    acceptance: {
      document: { path: "cutover/acceptance.json", format: "json" },
      current_contract_path: "/current/contract",
      current_conformance_path: "/current/conformance",
    },
    cochange: ["current.contract", "current.conformance", "previous.contract", "previous.conformance", "acceptance"],
    control_paths: ["contracts/**", "cutover/**"],
    ...overrides,
  });
}

function contractPolicy(overrides = {}) {
  return {
    ...foundationPolicy(),
    paths: { ...foundationPolicy().paths, governance_paths: ["repo-policy.json", "schemas/**"] },
    contract_conformance: contractConformanceMacro(),
    ...overrides,
  };
}

console.log("\n--- requirements-strict pack validation ---");
{
  expect(
    "pack config rejects non-object values",
    compileProfilePolicy({ packs: { "requirements-strict": ["tests/**"] } }),
    [{ field: "packs.requirements-strict", message: "packs.requirements-strict must be an object" }]
  );
}

console.log("\n--- requirements-strict pack schema and runtime lowering ---");
{
  const schema = loadJSON(resolve(root, "schemas/repo-policy.schema.json"));
  const validatePolicy = new Ajv({ allErrors: true }).compile(schema);
  expect("requirements-strict pack passes schema", validatePolicy(requirementsPolicy()), true);
  expect("legacy profile is rejected", validatePolicy({ ...foundationPolicy(), profile: "requirements-strict" }), false);
  expect("legacy profile_overrides is rejected", validatePolicy({ ...foundationPolicy(), profile_overrides: { evidence_surfaces: ["tests/**"] } }), false);

  const dir = mkdtempSync(join(tmpdir(), "repo-guard-pack-"));
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(requirementsPolicy(), null, 2), "utf-8");
  const runtime = loadPolicyRuntime({ packageRoot: root, repoRoot: dir }, { quiet: true });
  expect("runtime accepts requirements-strict pack", runtime.ok, true);
  expect("pack expands requirement_id anchor", Boolean(runtime.policy.anchors?.types?.requirement_id), true);
  expect(
    "pack config drives strict heading docs",
    runtime.policy.anchors?.types?.doc_heading_req_ref?.sources.map((source) => source.glob),
    ["docs/architecture.md", "docs/pmm_requirements.md"]
  );
  expect(
    "pack config drives changed requirement evidence",
    traceRule(runtime.policy, "changed-requirements-need-evidence")?.must_touch_any,
    requirementEvidence
  );
}

console.log("\n--- requirements-strict pack refinements ---");
{
  const affected = ["include/**", "src/**", "tests/**", "docs/**"];
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-pack-"));
  const policy = requirementsPolicy({ affected_evidence_surfaces: affected });
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(policy, null, 2), "utf-8");
  const runtime = loadPolicyRuntime({ packageRoot: root, repoRoot: dir }, { quiet: true });
  expect("pack can refine affected anchor evidence", traceRule(runtime.policy, "declared-affected-anchors-need-evidence")?.must_touch_any, affected);
  expect(
    "pack keeps default implementation evidence",
    traceRule(runtime.policy, "declared-implemented-anchors-need-evidence")?.must_touch_any,
    ["include/**", "src/**", "scripts/**", ".github/workflows/**"]
  );
  expect(
    "pack keeps default verification evidence",
    traceRule(runtime.policy, "declared-verified-anchors-need-evidence")?.must_touch_any,
    ["tests/**", "experiments/**", "scripts/**", ".github/workflows/**"]
  );
}

console.log("\n--- requirements-strict pack enforces changed requirement evidence ---");
{
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-pack-"));
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(requirementsPolicy(), null, 2), "utf-8");
  const runtime = loadPolicyRuntime({ packageRoot: root, repoRoot: dir }, { quiet: true });
  const files = { "requirements/functional/FR-001.json": JSON.stringify({ id: "FR-001", title: "Feature" }) };
  const diffText = [
    "diff --git a/requirements/functional/FR-001.json b/requirements/functional/FR-001.json",
    "--- a/requirements/functional/FR-001.json",
    "+++ b/requirements/functional/FR-001.json",
    "-{\"id\":\"FR-001\",\"title\":\"Old\"}",
    "+{\"id\":\"FR-001\",\"title\":\"Feature\"}",
  ].join("\n");
  const result = runPolicyPipeline({
    mode: "check-diff",
    repositoryRoot: dir,
    policy: runtime.policy,
    changeIntent: null,
    changeIntentSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText,
    trackedFiles: Object.keys(files),
    readFile: (file) => files[file],
    initialChecks: [],
  }, { quiet: true });
  expect("changed requirement without evidence fails", result.ok, false);
  expectIncludes(
    "pack trace rule reports relation-native missing evidence",
    result.violations.find((item) => item.rule === "trace-rule: changed-requirements-need-evidence")?.message,
    "requires evidence"
  );
}

console.log("\n--- current contract/conformance macro semantic boundary ---");
{
  expect("valid current macro compiles without semantic errors", compileContractConformancePolicy(contractPolicy()), []);

  const samePath = contractPolicy();
  samePath.contract_conformance.current.conformance.path = samePath.contract_conformance.current.contract.path;
  expect("macro rejects identical current pair paths", compileContractConformancePolicy(samePath).some((item) => /duplicates current\.contract/.test(item.message)), true);

  const uncovered = contractPolicy();
  uncovered.contract_conformance.control_paths = ["other/**"];
  expect("macro rejects control paths that do not cover pair", compileContractConformancePolicy(uncovered).some((item) => /do not cover/.test(item.message)), true);

  const duplicateSelector = contractPolicy();
  duplicateSelector.contract_conformance.required_paths.push(structuredClone(duplicateSelector.contract_conformance.required_paths[0]));
  expect("macro rejects duplicate required path selectors", compileContractConformancePolicy(duplicateSelector).some((item) => /duplicates selector/.test(item.message)), true);

  const collision = contractPolicy({
    document_relations: {
      documents: { "contract-conformance.current.contract": { path: "explicit.json", format: "json" } },
      rules: [],
    },
  });
  expect("macro rejects generated namespace collisions", compileContractConformancePolicy(collision).some((item) => /collides/.test(item.message)), true);
}

console.log("\n--- current macro expands to ordinary policy only ---");
{
  const source = contractPolicy({
    document_relations: {
      documents: { explicit: { path: "contracts/extra.json", format: "json" } },
      rules: [{ id: "explicit-state", kind: "scalar_equals_literal", source: { document: "explicit", pointer: "/state", type: "string" }, value: "ok" }],
    },
    cochange_rules: [{ if_changed: ["docs/**"], must_change_any: ["tests/**"] }],
  });
  const resolved = resolvePolicyProfile(source);
  expect("macro resolves", resolved.ok, true);
  expect("macro source field disappears after expansion", resolved.policy.contract_conformance, undefined);
  expect("explicit document relation composes", resolved.policy.document_relations.documents.explicit.path, "contracts/extra.json");
  expect("current contract generated document path", resolved.policy.document_relations.documents["contract-conformance.current.contract"].path, "contracts/spec-v2.json");
  expect("current conformance generated document path", resolved.policy.document_relations.documents["contract-conformance.current.conformance"].path, "contracts/checks-v2.yaml");
  expect("explicit relation remains first", resolved.policy.document_relations.rules[0].id, "explicit-state");
  expect("macro emits six scalar relations plus required-path relations", resolved.policy.document_relations.rules.length, 9);
  expect("existing cochange rule composes", resolved.policy.cochange_rules[0], { if_changed: ["docs/**"], must_change_any: ["tests/**"] });
  expect("macro does not generate directed cochange edges", resolved.policy.cochange_rules.slice(1), []);
  expect("macro adds one semantic current-pair cochange group", resolved.policy.cochange_groups, [{
    id: "contract-conformance",
    members: ["contracts/checks-v2.yaml", "contracts/spec-v2.json"],
  }]);
  expect("control paths compose into stable governance paths", resolved.policy.paths.governance_paths, ["contracts/**", "repo-policy.json", "schemas/**"]);
}

console.log("\n--- synthetic current macro executes through ordinary R2 constraints ---");
{
  const source = contractPolicy();
  const resolved = resolvePolicyProfile(source);
  const files = {
    "contracts/spec-v2.json": JSON.stringify({
      schema: "spec-v2",
      status: "accepted",
      accepted: true,
      conformanceCorpus: "contracts/checks-v2.yaml",
      owners: { spec: "docs/spec.md", tests: "tests/spec.test.mjs" },
    }),
    "contracts/checks-v2.yaml": [
      "contract: spec-v2",
      "status: accepted",
      "accepted: true",
      "requiredGates:",
      "  - tests/gate.mjs",
    ].join("\n"),
    "docs/spec.md": "# Spec\n",
    "tests/spec.test.mjs": "export {};\n",
    "tests/gate.mjs": "export {};\n",
  };
  const run = (trackedFiles = Object.keys(files), diffText = "") => runPolicyPipeline({
    mode: "check-diff",
    repositoryRoot: "/tmp/contract-pack-test",
    policy: resolved.policy,
    changeIntent: null,
    changeIntentSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText,
    trackedFiles,
    readFile: (file) => files[file],
    initialChecks: [],
  }, { quiet: true });

  const passing = run();
  expect("synthetic current topology passes ordinary R2 relations", passing.violations.filter((item) => item.rule.startsWith("document-relation:")).length, 0);

  const missing = run(Object.keys(files).filter((path) => path !== "tests/gate.mjs"));
  expect("required path failure is ordinary referenced_paths_exist", missing.violations.find((item) => item.rule === "document-relation:contract-conformance:required-path:1")?.data?.missing_paths, ["tests/gate.mjs"]);

  const contractOnlyDiff = [
    "diff --git a/contracts/spec-v2.json b/contracts/spec-v2.json",
    "--- a/contracts/spec-v2.json",
    "+++ b/contracts/spec-v2.json",
    "+{}",
  ].join("\n");
  expect("current pair cochange uses semantic cochange group", run(Object.keys(files), contractOnlyDiff).violations.some((item) => item.rule === "cochange-group:contract-conformance"), true);
}

console.log("\n--- synthetic previous pair and acceptance execute through ordinary R2 constraints ---");
{
  const source = contractPolicy({
    contract_conformance: historyContractConformanceMacro(),
    document_relations: {
      documents: { "consumer-context": { path: "cutover/acceptance.json", format: "json" } },
      rules: [{
        id: "historical-runtime-not-selectable",
        kind: "scalar_equals_literal",
        source: { document: "contract-conformance.acceptance", pointer: "/previousReleaseEvidence/liveRuntimeSelectable", type: "boolean" },
        value: false,
      }],
    },
  });
  const resolved = resolvePolicyProfile(source);
  const files = {
    "contracts/spec-v2.json": JSON.stringify({
      schema: "spec-v2",
      status: "accepted",
      accepted: true,
      conformanceCorpus: "contracts/checks-v2.yaml",
      owners: { spec: "docs/spec.md" },
    }),
    "contracts/checks-v2.yaml": [
      "contract: spec-v2",
      "status: accepted",
      "accepted: true",
      "requiredGates:",
      "  - tests/gate.mjs",
    ].join("\n"),
    "contracts/spec-v1.json": JSON.stringify({ schema: "spec-v1", status: "accepted", accepted: true, conformanceCorpus: "contracts/checks-v1.json" }),
    "contracts/checks-v1.json": JSON.stringify({ contract: "spec-v1", status: "accepted", accepted: true }),
    "cutover/acceptance.json": JSON.stringify({
      current: { contract: "contracts/spec-v2.json", conformance: "contracts/checks-v2.yaml" },
      previousReleaseEvidence: { liveRuntimeSelectable: false },
    }),
    "docs/spec.md": "# Spec\n",
    "tests/gate.mjs": "export {};\n",
  };
  const run = (overrides = {}) => {
    const activeFiles = { ...files, ...overrides };
    return runPolicyPipeline({
      mode: "check-diff",
      repositoryRoot: "/tmp/contract-pack-history-test",
      policy: resolved.policy,
      changeIntent: null,
      changeIntentSource: "none",
      enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
      diffText: "",
      trackedFiles: Object.keys(activeFiles),
      readFile: (file) => activeFiles[file],
      initialChecks: [],
    }, { quiet: true });
  };

  const passing = run();
  expect("synthetic history topology passes ordinary R2 relations", passing.violations.filter((item) => item.rule.startsWith("document-relation:")).length, 0);
  expect("current-only required path selectors are not copied to previous pair", resolved.policy.document_relations.rules.filter((rule) => rule.kind === "referenced_paths_exist").map((rule) => rule.id), ["contract-conformance:required-path:0", "contract-conformance:required-path:1"]);

  const brokenPrevious = run({ "contracts/checks-v1.json": JSON.stringify({ contract: "wrong-spec", status: "accepted", accepted: true }) });
  expect("broken previous cross-link fails through ordinary scalar relation", brokenPrevious.violations.some((item) => item.rule === "document-relation:contract-conformance:previous-id"), true);

  const stalePointer = run({
    "cutover/acceptance.json": JSON.stringify({
      current: { contract: "contracts/spec-v1.json", conformance: "contracts/checks-v1.json" },
      previousReleaseEvidence: { liveRuntimeSelectable: false },
    }),
  });
  expect("stale acceptance current pointer fails through ordinary literal relation", stalePointer.violations.some((item) => item.rule === "document-relation:contract-conformance:acceptance-current-contract"), true);

  const consumerVeto = run({
    "cutover/acceptance.json": JSON.stringify({
      current: { contract: "contracts/spec-v2.json", conformance: "contracts/checks-v2.yaml" },
      previousReleaseEvidence: { liveRuntimeSelectable: true },
    }),
  });
  expect("consumer-specific historical veto remains an explicit R2 relation", consumerVeto.violations.some((item) => item.rule === "document-relation:historical-runtime-not-selectable"), true);
}

console.log("\n--- anum_docs-shaped current topology is data only ---");
{
  const source = contractPolicy({
    contract_conformance: contractConformanceMacro({
      current: {
        contract: { path: "contracts/mts-contract-v0.7.json", format: "json" },
        conformance: { path: "contracts/mts-conformance-v0.7.json", format: "json" },
      },
      required_paths: [
        { document: "current.contract", pointer: "/owners", projection: "object_values" },
        { document: "current.conformance", pointer: "/requiredExecutableGates", projection: "array_items" },
      ],
    }),
  });
  const resolved = resolvePolicyProfile(source);
  expect("anum_docs-shaped macro resolves without domain-specific implementation", resolved.ok, true);
  expect("anum_docs contract/conformance cross-link uses configured pointers", resolved.policy.document_relations.rules[0], {
    id: "contract-conformance:current-id",
    kind: "scalar_equal",
    left: { document: "contract-conformance.current.conformance", pointer: "/contract", type: "string" },
    right: { document: "contract-conformance.current.contract", pointer: "/schema", type: "string" },
  });
  expect("anum_docs current conformance path is a literal relation", resolved.policy.document_relations.rules[1].value, "contracts/mts-conformance-v0.7.json");
  expect("anum_docs owners use generic object_values path projection", resolved.policy.document_relations.rules[6].source.projection, "object_values");
  expect("anum_docs executable gates use generic array_items path projection", resolved.policy.document_relations.rules[7].source.projection, "array_items");
}

console.log(`\n${failures === 0 ? "All policy profile tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
