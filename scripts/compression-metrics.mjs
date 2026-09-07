#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ref = arg("--ref", "HEAD");
const compareRef = arg("--compare");
const git = (argv) => execFileSync("git", argv, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
const pathsAt = (target, roots) => git(["ls-tree", "-r", "--name-only", target, "--", ...roots]).split(/\r?\n/).filter(Boolean).sort();
const textAt = (target, path) => git(["show", `${target}:${path}`]);
const jsonAt = (target, path) => JSON.parse(textAt(target, path));
const sourceModulePathsAt = (target, stem) => pathsAt(target, ["src"]).filter((path) => path === `${stem}.mts` || path === `${stem}.mjs` || path === `${stem}.js`);
const sourceModuleTextAt = (target, stem) => {
  const paths = sourceModulePathsAt(target, stem);
  if (paths.length !== 1) throw new Error(`expected exactly one source module for ${stem} at ${target}, found ${paths.length}`);
  return textAt(target, paths[0]);
};
const optionalSourceModuleTextAt = (target, stem) => {
  const paths = sourceModulePathsAt(target, stem);
  if (!paths.length) return "";
  if (paths.length !== 1) throw new Error(`expected at most one source module for ${stem} at ${target}, found ${paths.length}`);
  return textAt(target, paths[0]);
};
const lines = (text) => text ? (text.match(/\n/g) || []).length + (text.endsWith("\n") ? 0 : 1) : 0;
const count = (text, pattern) => (text.match(pattern) || []).length;

function physical(target, roots) {
  const files = pathsAt(target, roots);
  return files.reduce((out, path) => {
    const content = textAt(target, path);
    out.lines += lines(content);
    out.bytes += Buffer.byteLength(content);
    return out;
  }, { files: files.length, lines: 0, bytes: 0 });
}

function sourceCorpus(target) {
  return pathsAt(target, ["src"]).filter((path) => /\.(?:mts|mjs|js)$/.test(path)).map((path) => textAt(target, path)).join("\n");
}

function unionMembers(source, typeName) {
  const match = source.match(new RegExp(`type\\s+${typeName}\\s*=\\s*([^;]+);`));
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort() : [];
}

function schemaConstKinds(schema, definitionName) {
  const definition = schema.definitions?.[definitionName];
  return (definition?.oneOf || [])
    .map((entry) => entry?.properties?.kind?.const)
    .filter((value) => typeof value === "string")
    .sort();
}

function descriptorKinds(source) {
  const table = source.match(/const\s+DESCRIPTORS(?:\s*:[^=]+)?\s*=\s*\[([\s\S]*?)\n\];/);
  return table ? [...table[1].matchAll(/\bkind:\s*"([^"]+)"/g)].map((item) => item[1]).sort() : [];
}

function integrationCounts(policy) {
  const integration = policy.integration || {};
  return {
    workflows: (integration.workflows || []).length,
    templates: (integration.templates || []).length,
    docs: (integration.docs || []).length,
    profiles: (integration.profiles || []).length,
  };
}

function ciMetrics(target, pkg) {
  const workflow = textAt(target, ".github/workflows/ci.yml");
  const action = textAt(target, "action.yml");
  const jobsBlock = workflow.split(/\njobs:\s*\n/)[1] || "";
  const jobs = count(jobsBlock, /^  [A-Za-z0-9_-]+:\s*$/gm);
  const npmCiRuns = count(workflow, /^\s*(?:-\s*)?run:\s*npm ci\s*$/gm);
  const explicitCheckDistRuns = count(workflow, /^\s*(?:-\s*)?run:\s*npm run check:dist\s*$/gm);
  const testRuns = count(workflow, /^\s*(?:-\s*)?run:\s*npm test\s*$/gm);
  const pretestCallsCheckDist = /check:dist/.test(pkg.scripts?.pretest || "") ? 1 : 0;
  return {
    jobs,
    npm_ci_runs: npmCiRuns,
    explicit_check_dist_runs: explicitCheckDistRuns,
    effective_check_dist_runs: explicitCheckDistRuns + (testRuns * pretestCallsCheckDist),
    test_runs: testRuns,
    full_history_checkouts: count(workflow, /fetch-depth:\s*0/g),
    self_action_runtime_installs: count(action, /npm install --omit=dev/g),
    setup_node_mentions: count(workflow, /actions\/setup-node@/g) + count(action, /actions\/setup-node@/g),
  };
}

function policyMetrics(target, policy) {
  const text = textAt(target, "repo-policy.json");
  return {
    bytes: Buffer.byteLength(text),
    top_level_concepts: Object.keys(policy).length,
    surfaces: Object.keys(policy.surfaces || {}).length,
    new_file_classes: Object.keys(policy.new_file_classes || {}).length,
    change_profiles: Object.keys(policy.change_profiles || {}).length,
    size_rules: (policy.size_rules || []).length,
    content_rules: (policy.content_rules || []).length,
    cochange_rules: (policy.cochange_rules || []).length,
    integration: integrationCounts(policy),
  };
}

function architecture(target) {
  const policy = jsonAt(target, "repo-policy.json");
  const pkg = jsonAt(target, "package.json");
  const policySchema = jsonAt(target, "schemas/repo-policy.schema.json");
  const coverage = jsonAt(target, "docs/self-hosting-coverage.json");
  const defaults = sourceModuleTextAt(target, "src/checks/default-rule-families");
  const documentFacts = optionalSourceModuleTextAt(target, "src/document-facts");
  const constraintProgram = optionalSourceModuleTextAt(target, "src/checks/constraint-program");
  const relationKernel = optionalSourceModuleTextAt(target, "src/checks/relation-kernel");
  const policyCompiler = optionalSourceModuleTextAt(target, "src/policy-compiler");
  const constraintEvaluator = optionalSourceModuleTextAt(target, "src/checks/rules/constraints");
  const policyProfiles = optionalSourceModuleTextAt(target, "src/policy-profiles");
  const corpus = sourceCorpus(target);
  const parserFiles = pathsAt(target, ["src"]).filter((path) => /\.(?:mts|mjs|js)$/.test(path) && /function parseMarkdown\(|const FENCE_RE|function extractMarkdownSection\(|let inFence = false/.test(textAt(target, path)));
  const relationKinds = schemaConstKinds(policySchema, "document_relation_rule");
  const selectorDefinitions = Object.keys(policySchema.definitions || {}).filter((name) => /^document_.*_selector$/.test(name)).sort();
  const factTypes = unionMembers(documentFacts, "DocumentFactType");
  const evidenceBindingKinds = schemaConstKinds(policySchema, "evidence_binding");
  const relationKernelOperations = [...relationKernel.matchAll(/export\s+(?:function|const)\s+([A-Za-z0-9_]+)/g)].map((item) => item[1]).sort();
  const relationDescriptorKinds = descriptorKinds(relationKernel);
  const relationConsumerSources = {
    policy_compiler: policyCompiler,
    constraint_program: constraintProgram,
    evaluator: constraintEvaluator,
  };
  const independentRelationSwitchFiles = Object.entries(relationConsumerSources)
    .filter(([, source]) => relationKinds.some((kind) => source.includes(`"${kind}"`)))
    .map(([name]) => name)
    .sort();
  const descriptorRegistryCount = count(relationKernel, /const\s+DESCRIPTORS(?:\s*:[^=]+)?\s*=/g);
  const canonicalCore = [constraintProgram, relationKernel, policyCompiler, constraintEvaluator].join("\n");
  const contractRoleVocabulary = count(canonicalCore, /ContractConformanceRole|CONTRACT_CONFORMANCE_DOCUMENT_ROLES|contractConformanceRolesByPath|current\.contract|current\.conformance|previous\.contract|previous\.conformance/g);
  const generatedEdgeHelpers = count(canonicalCore, /CochangeRoleEdge|cochangeRoleEdge|generatedContractConformanceCochange/g);
  const macroCochangeConstraints = count(policyProfiles, /cochangeGroups\.push\(\{\s*id:\s*"contract-conformance"/g);
  const macroPositionalIdentity = count(canonicalCore, /contract-conformance/g);
  const highLevelPackCoreEditSites = count(canonicalCore, /contract_conformance|contract-conformance|current\.contract|current\.conformance|previous\.contract|previous\.conformance/g);

  const metric = {
    // Historical Compression 2 metrics are retained so --compare remains useful.
    rule_families: count(defaults, /\b[A-Za-z][A-Za-z0-9]*RuleFamily\b/g),
    declared_surfaces: Object.keys(policy.surfaces || {}).length,
    declared_new_file_classes: Object.keys(policy.new_file_classes || {}).length,
    markdown_parser_files: parserFiles.length,
    manual_test_script_entries: count(pkg.scripts?.test || "", /node\s+tests\/(?:test-|validate-schemas)/g),
    self_hosting_status_entries: count(JSON.stringify(coverage), /"status":/g),
    self_hosting_exceptions: Object.keys(coverage.exceptions || {}).length,
    runtime_ir_compilers: count(corpus, /function compileConstraintIR\b/g),
    strictness_ir_compilers: count(corpus, /function compilePolicyStrictnessIR\b/g),
    command_dispatch_branches: count(corpus, /command ===/g),
    bespoke_integration_validator: sourceModulePathsAt(target, "src/integration-validator").length,
    privileged_field_workarounds: count(corpus, /stripPrivilegedSchemaUnknownFields|SCHEMA_UNKNOWN_PRIVILEGED_FIELDS/g),

    // Compression 3 inventory: absent historical modules produce an empty inventory.
    registered_rule_families: count(defaults, /^\s*withPhase\(/gm),
    document_relation_kinds: relationKinds,
    document_selector_kinds: selectorDefinitions.length,
    document_selector_definitions: selectorDefinitions,
    document_fact_types: factTypes.length,
    document_fact_type_names: factTypes,
    evidence_binding_kinds: evidenceBindingKinds,
    relation_kernel_operations: relationKernelOperations.length,
    relation_kernel_operation_names: relationKernelOperations,
    execution_phases: ["both", "state", "transaction"],
    constraint_program_knows_contract_conformance_roles: /type ContractConformanceRole\b/.test(constraintProgram),
    policy_profiles_has_contract_conformance_macro: /compileContractConformancePolicy\b/.test(policyProfiles),
    policy_profiles_has_requirements_strict_pack: /"requirements-strict"/.test(policyProfiles),

    // C3.1 targeted amplification metrics. Schema and tests are deliberate structural edit-sites
    // and are therefore excluded from the semantic kernel edit-site count.
    canonical_factref_model_count: count(documentFacts, /export\s+interface\s+FactRef\b/g),
    primitive_descriptor_registry_count: descriptorRegistryCount,
    primitive_descriptor_kinds: relationDescriptorKinds,
    schema_relation_kinds_match_descriptors: JSON.stringify(relationKinds) === JSON.stringify(relationDescriptorKinds),
    primitive_runtime_shape_count: count(constraintProgram, /kind:\s*"primitive_relation"/g),
    independent_document_relation_switches: independentRelationSwitchFiles.length,
    independent_document_relation_switch_files: independentRelationSwitchFiles,
    semantic_edit_sites_per_new_primitive: descriptorRegistryCount + independentRelationSwitchFiles.length,

    // C3.2 structural-compression proof. The high-level pack may exist in policy-profiles,
    // but canonical compilation/evaluation/strictness must not know its domain vocabulary.
    contract_conformance_role_vocabulary_in_canonical_core: contractRoleVocabulary,
    generated_edge_recognition_helpers: generatedEdgeHelpers,
    contract_conformance_cochange_constraints: macroCochangeConstraints,
    macro_generated_positional_identity: macroPositionalIdentity,
    high_level_pack_semantic_edit_sites_in_canonical_core: highLevelPackCoreEditSites,
  };
  metric.semantic_edit_sites = metric.rule_families + metric.runtime_ir_compilers + metric.strictness_ir_compilers + metric.bespoke_integration_validator + metric.command_dispatch_branches;

  return {
    ref: target,
    physical: {
      src: physical(target, ["src"]),
      schemas: physical(target, ["schemas"]),
      tests: physical(target, ["tests"]),
      docs: physical(target, ["docs"]),
      examples: physical(target, ["examples"]),
    },
    architecture: metric,
    policy: policyMetrics(target, policy),
    ci: ciMetrics(target, pkg),
  };
}

function subtract(after, before) {
  if (typeof after === "number" && typeof before === "number") return after - before;
  if (!after || !before || typeof after !== "object" || typeof before !== "object" || Array.isArray(after) || Array.isArray(before)) return undefined;
  return Object.fromEntries(
    Object.keys(after)
      .filter((key) => Object.hasOwn(before, key))
      .map((key) => [key, subtract(after[key], before[key])])
      .filter(([, value]) => value !== undefined),
  );
}

const current = architecture(ref);
if (!compareRef) console.log(JSON.stringify(current, null, 2));
else {
  const baseline = architecture(compareRef);
  console.log(JSON.stringify({ baseline, current, delta: subtract(current, baseline) }, null, 2));
}
