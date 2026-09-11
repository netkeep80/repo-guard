from pathlib import Path


def replace_once(path, before, after):
    p = Path(path)
    text = p.read_text()
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{path}: expected fragment exactly once, got {count}")
    p.write_text(text.replace(before, after, 1))


source = "src/policy-profiles.mts"
replace_once(source, '''interface PolicyProjection extends Record<string, unknown> {
  profile?: string;
  profile_overrides?: unknown;
  packs?: unknown;''', '''interface PolicyProjection extends Record<string, unknown> {
  packs?: unknown;''')
replace_once(source, '''interface ProfileValidationError {
  field: string;
  profile?: string;
  message: string;
}''', '''interface ProfileValidationError {
  field: string;
  message: string;
}''')
replace_once(source, '''export const listBuiltInPacks = (): string[] => [...Object.keys(PACKS), VERSION_GOVERNANCE_PACK, REPO_GUARD_WORKFLOW_PACK].sort();
export const listBuiltInProfiles = (): string[] => Object.keys(PACKS).sort();''', '''export const listBuiltInPacks = (): string[] => [...Object.keys(PACKS), VERSION_GOVERNANCE_PACK, REPO_GUARD_WORKFLOW_PACK].sort();''')
replace_once(source, '''export function compileProfilePolicy(policy: unknown): ProfileValidationError[] {
  const source = policy as PolicyProjection | null | undefined;
  const errors: ProfileValidationError[] = [], profile = source?.profile, overrides = source?.profile_overrides, packs = source?.packs;
  if (overrides !== undefined && !profile) errors.push({ field: "profile_overrides", message: "profile_overrides requires top-level profile" });
  if (profile !== undefined && !(PACKS as unknown as Record<string, ProfileSpec>)[profile]) errors.push({ field: "profile", profile, message: `profile "${profile}" is not supported; use ${listBuiltInProfiles().join(", ")}` });
  if (overrides !== undefined) validateRequirementsConfig("profile_overrides", overrides, errors);

  if (packs !== undefined) {
    if (profile !== undefined || overrides !== undefined) errors.push({ field: "packs", message: "packs cannot be combined with profile or profile_overrides" });''', '''export function compileProfilePolicy(policy: unknown): ProfileValidationError[] {
  const source = policy as PolicyProjection | null | undefined;
  const errors: ProfileValidationError[] = [], packs = source?.packs;

  if (packs !== undefined) {''')
replace_once(source, '''    return base;
  }
  const spec = (PACKS as unknown as Record<string, ProfileSpec>)[base.profile as string];
  if (!spec) return base;
  const patch = materializePack(spec, (base.profile_overrides as Record<string, unknown>) || {});
  return { ...base, anchors: base.anchors || patch.anchors, trace_rules: base.trace_rules || patch.trace_rules };
}''', '''    return base;
  }
  return base;
}''')

schema = "schemas/repo-policy.schema.json"
replace_once(schema, '''  "dependencies": {
    "change_profiles": ["surfaces"],
    "profile_overrides": ["profile"]
  },''', '''  "dependencies": {
    "change_profiles": ["surfaces"]
  },''')
replace_once(schema, '''    "profile": {
      "type": "string",
      "enum": ["requirements-strict"],
      "description": "Optional built-in policy profile expanded before runtime checks. Explicit anchors or trace_rules in the policy override the generated profile sections."
    },
    "profile_overrides": {
      "$ref": "#/definitions/profile_overrides",
      "description": "Profile-specific refinements applied while expanding a built-in profile."
    },
''', '')
replace_once(schema, '''"requirements-strict": { "$ref": "#/definitions/profile_overrides" }''', '''"requirements-strict": { "$ref": "#/definitions/requirements_strict_pack" }''')
replace_once(schema, '''    "profile_overrides": {
      "type": "object",''', '''    "requirements_strict_pack": {
      "type": "object",''')

validate_path = Path("tests/validate-schemas.mjs")
validate_text = validate_path.read_text()
old_schema_tests = '''expect("requirements-strict profile", policy({ ...validPolicy, profile: "requirements-strict", profile_overrides: { evidence_surfaces: ["src/**"] } }));
expect("profile overrides require profile", policy({ ...validPolicy, profile_overrides: { evidence_surfaces: ["src/**"] } }), false);'''
new_schema_tests = '''expect("requirements-strict pack", policy({ ...validPolicy, packs: { "requirements-strict": { evidence_surfaces: ["src/**"] } } }));
expect("removed top-level profile rejected", policy({ ...validPolicy, profile: "requirements-strict" }), false);
expect("removed top-level profile_overrides rejected", policy({ ...validPolicy, profile_overrides: { evidence_surfaces: ["src/**"] } }), false);'''
if validate_text.count(old_schema_tests) != 1:
    raise SystemExit("validate-schemas: legacy schema assertions not found exactly once")
validate_path.write_text(validate_text.replace(old_schema_tests, new_schema_tests, 1))

policy_test = Path("tests/test-policy-profiles.mjs")
text = policy_test.read_text()
marker = 'console.log("\\n--- current contract/conformance macro semantic boundary ---");'
pos = text.find(marker)
if pos < 0 or text.find(marker, pos + 1) >= 0:
    raise SystemExit("test-policy-profiles: contract marker must occur exactly once")
suffix = text[pos:]
prefix = r'''import { mkdtempSync, writeFileSync } from "node:fs";
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

'''
policy_test.write_text(prefix + suffix)

print("C3.10b profile frontend deletion patch applied")
