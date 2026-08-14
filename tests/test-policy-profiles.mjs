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

function basePolicy() {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "library",
    profile: "requirements-strict",
    profile_overrides: {
      strict_heading_docs: [
        "docs/architecture.md",
        "docs/pmm_requirements.md",
      ],
      evidence_surfaces: [
        "include/**",
        "src/**",
        "tests/**",
        "examples/**",
        "docs/**",
        "README.md",
        "requirements/README.md",
        "scripts/**",
        ".github/workflows/**",
      ],
    },
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
    },
    diff_rules: {
      max_new_docs: 2,
      max_new_files: 10,
      max_net_added_lines: 1000,
    },
    content_rules: [],
    cochange_rules: [],
  };
}

const pjsonEvidenceSurfaces = [
  "include/**",
  "src/**",
  "tests/**",
  "examples/**",
  "docs/**",
  "README.md",
  "requirements/README.md",
  "scripts/**",
  ".github/workflows/**",
];

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

function contractPolicy(overrides = {}) {
  return {
    ...basePolicy(),
    profile: undefined,
    profile_overrides: undefined,
    paths: { ...basePolicy().paths, governance_paths: ["repo-policy.json", "schemas/**"] },
    contract_conformance: contractConformanceMacro(),
    ...overrides,
  };
}

console.log("\n--- profile compiler runtime narrowing ---");
{
  expect(
    "profile overrides reject non-object values",
    compileProfilePolicy({ profile: "requirements-strict", profile_overrides: ["tests/**"] }),
    [{ field: "profile_overrides", message: "profile_overrides must be an object" }]
  );
  expect(
    "profile overrides require a top-level profile",
    compileProfilePolicy({ profile_overrides: { evidence_surfaces: ["tests/**"] } }),
    [{ field: "profile_overrides", message: "profile_overrides requires top-level profile" }]
  );
}

console.log("\n--- profile schema support ---");
{
  const schema = loadJSON(resolve(root, "schemas/repo-policy.schema.json"));
  const ajv = new Ajv({ allErrors: true });
  const validatePolicy = ajv.compile(schema);
  const valid = validatePolicy(basePolicy());

  expect("policy with requirements-strict profile passes schema", valid, true);
}

console.log("\n--- profile expansion in runtime policy load ---");
{
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-profile-"));
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(basePolicy(), null, 2), "utf-8");

  const runtime = loadPolicyRuntime({ packageRoot: root, repoRoot: dir }, { quiet: true });
  expect("runtime accepts profile policy", runtime.ok, true);
  expect("profile expands requirement_id anchor", Boolean(runtime.policy.anchors?.types?.requirement_id), true);
  expect(
    "profile override drives strict heading docs",
    runtime.policy.anchors?.types?.doc_heading_req_ref?.sources.map((source) => source.glob),
    ["docs/architecture.md", "docs/pmm_requirements.md"]
  );
  expect(
    "profile override drives changed requirement evidence surfaces",
    traceRule(runtime.policy, "changed-requirements-need-evidence")?.must_touch_any,
    basePolicy().profile_overrides.evidence_surfaces
  );
}

console.log("\n--- pjson-style strict profile overrides ---");
{
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-profile-"));
  const policy = {
    ...basePolicy(),
    profile_overrides: {
      strict_heading_docs: [
        "docs/architecture.md",
        "docs/pmm_requirements.md",
      ],
      evidence_surfaces: pjsonEvidenceSurfaces,
      affected_evidence_surfaces: [
        "include/**",
        "src/**",
        "tests/**",
        "examples/**",
        "docs/**",
        "README.md",
        "requirements/README.md",
        "scripts/**",
      ],
    },
  };
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(policy, null, 2), "utf-8");

  const runtime = loadPolicyRuntime({ packageRoot: root, repoRoot: dir }, { quiet: true });
  expect(
    "pjson-style profile keeps conventional requirement JSON globs",
    runtime.policy.anchors?.types?.requirement_id?.sources.map((source) => source.glob),
    [
      "requirements/business/*.json",
      "requirements/stakeholder/*.json",
      "requirements/functional/*.json",
      "requirements/nonfunctional/*.json",
      "requirements/constraints/*.json",
      "requirements/interface/*.json",
    ]
  );
  expect(
    "pjson-style profile can refine changed requirement evidence",
    traceRule(runtime.policy, "changed-requirements-need-evidence")?.must_touch_any,
    pjsonEvidenceSurfaces
  );
  expect(
    "pjson-style profile can refine affected anchor evidence separately",
    traceRule(runtime.policy, "declared-affected-anchors-need-evidence")?.must_touch_any,
    policy.profile_overrides.affected_evidence_surfaces
  );
  expect(
    "pjson-style profile defaults implementation evidence to implementation surfaces",
    traceRule(runtime.policy, "declared-implemented-anchors-need-evidence")?.must_touch_any,
    ["include/**", "src/**", "scripts/**", ".github/workflows/**"]
  );
  expect(
    "pjson-style profile defaults verification evidence to verification surfaces",
    traceRule(runtime.policy, "declared-verified-anchors-need-evidence")?.must_touch_any,
    ["tests/**", "experiments/**", "scripts/**", ".github/workflows/**"]
  );
}

console.log("\n--- explicit expanded sections remain compatible ---");
{
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-profile-"));
  const policy = {
    ...basePolicy(),
    anchors: {
      types: {
        custom_requirement_id: {
          sources: [
            { kind: "json_field", glob: "specs/*.json", field: "id" },
          ],
        },
      },
    },
    trace_rules: [],
  };
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(policy, null, 2), "utf-8");

  const runtime = loadPolicyRuntime({ packageRoot: root, repoRoot: dir }, { quiet: true });
  expect("explicit anchors remain valid with profile", runtime.ok, true);
  expect("explicit anchors take precedence over generated profile anchors", Boolean(runtime.policy.anchors?.types?.requirement_id), false);
  expect("explicit trace_rules take precedence over generated profile trace_rules", runtime.policy.trace_rules, []);
}

console.log("\n--- profile trace rules enforce changed requirement evidence ---");
{
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-profile-"));
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(basePolicy(), null, 2), "utf-8");
  const runtime = loadPolicyRuntime({ packageRoot: root, repoRoot: dir }, { quiet: true });

  const files = {
    "requirements/functional/FR-001.json": JSON.stringify({ id: "FR-001", title: "Feature" }),
  };
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
  expect("changed requirement without evidence is blocking", result.exitCode, 1);
  expectIncludes(
    "profile trace rule reports missing evidence",
    result.violations.find((item) => item.data?.trace_rule === "changed-requirements-need-evidence")?.message,
    "missing evidence"
  );
}

console.log("\n--- current contract/conformance macro semantic boundary ---");
{
  expect("valid current macro compiles without semantic errors", compileContractConformancePolicy(contractPolicy()), []);

  const samePath = contractPolicy();
  samePath.contract_conformance.current.conformance.path = samePath.contract_conformance.current.contract.path;
  expect("macro rejects identical current pair paths", compileContractConformancePolicy(samePath).some((item) => item.field === "contract_conformance.current"), true);

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
  expect("macro adds bidirectional current pair cochange", resolved.policy.cochange_rules.slice(1), [
    { if_changed: ["contracts/spec-v2.json"], must_change_any: ["contracts/checks-v2.yaml"] },
    { if_changed: ["contracts/checks-v2.yaml"], must_change_any: ["contracts/spec-v2.json"] },
  ]);
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
  expect("current pair cochange uses ordinary cochange rule", run(Object.keys(files), contractOnlyDiff).violations.some((item) => item.rule.startsWith("cochange:")), true);
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
