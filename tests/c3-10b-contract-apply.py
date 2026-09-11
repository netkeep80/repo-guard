from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


# Production frontend: one closed pack registry, one compile/expand pass.
path = "src/policy-profiles.mts"
s = read(path)
s = once(s, "  contract_conformance?: unknown;\n", "", "remove PolicyProjection legacy field")
s = once(
    s,
    "\nfunction contractMacro(policy: PolicyProjection) {\n  return isObject(policy.contract_conformance) ? policy.contract_conformance : null;\n}\n",
    "\n",
    "remove legacy contractMacro selector",
)
s = once(
    s,
    'const VERSION_GOVERNANCE_PACK = "version-governance";\nconst REPO_GUARD_WORKFLOW_PACK = "repo-guard-workflow";\n\nexport const listBuiltInPacks = (): string[] => [...Object.keys(PACKS), VERSION_GOVERNANCE_PACK, REPO_GUARD_WORKFLOW_PACK].sort();',
    'const VERSION_GOVERNANCE_PACK = "version-governance";\nconst REPO_GUARD_WORKFLOW_PACK = "repo-guard-workflow";\nconst CONTRACT_CONFORMANCE_PACK = "contract-conformance";\n\nexport const listBuiltInPacks = (): string[] => [...Object.keys(PACKS), VERSION_GOVERNANCE_PACK, REPO_GUARD_WORKFLOW_PACK, CONTRACT_CONFORMANCE_PACK].sort();',
    "register contract-conformance pack",
)
s = once(
    s,
    '      for (const [name, config] of entries) {\n        if (name === VERSION_GOVERNANCE_PACK) validateVersionGovernanceConfig(`packs.${name}`, config, source || {}, errors);\n        else if (name === REPO_GUARD_WORKFLOW_PACK) validateRepoGuardWorkflowConfig(`packs.${name}`, config, source || {}, errors);',
    '      for (const [name, config] of entries) {\n        if (name === CONTRACT_CONFORMANCE_PACK) errors.push(...validateContractConformanceConfig(`packs.${name}`, config, source || {}));\n        else if (name === VERSION_GOVERNANCE_PACK) validateVersionGovernanceConfig(`packs.${name}`, config, source || {}, errors);\n        else if (name === REPO_GUARD_WORKFLOW_PACK) validateRepoGuardWorkflowConfig(`packs.${name}`, config, source || {}, errors);',
    "dispatch contract pack validation",
)
old_header = '''export function compileContractConformancePolicy(policy: unknown): ProfileValidationError[] {
  const source = policy as PolicyProjection | null | undefined;
  if (source?.contract_conformance === undefined) return [];
  if (!isObject(source.contract_conformance)) return [{ field: "contract_conformance", message: "contract_conformance must be an object" }];

  const macro = source.contract_conformance, errors: ProfileValidationError[] = [];'''
new_header = '''function validateContractConformanceConfig(fieldPrefix: string, value: unknown, source: PolicyProjection): ProfileValidationError[] {
  if (!isObject(value)) return [{ field: fieldPrefix, message: `${fieldPrefix} must be an object` }];

  const macro = value, errors: ProfileValidationError[] = [];'''
s = once(s, old_header, new_header, "convert contract validator to pack config")
# Pack-local validation paths should report the pack field, while cross-surface collision paths remain canonical.
s = s.replace('field: "contract_conformance"', 'field: fieldPrefix')
s = s.replace('field: `contract_conformance.', 'field: `${fieldPrefix}.')
s = once(
    s,
    '      if (name === VERSION_GOVERNANCE_PACK) {\n        materializeVersionGovernance(base, config);\n        continue;\n      }',
    '      if (name === CONTRACT_CONFORMANCE_PACK) {\n        materializeContractConformance(base, config);\n        continue;\n      }\n      if (name === VERSION_GOVERNANCE_PACK) {\n        materializeVersionGovernance(base, config);\n        continue;\n      }',
    "dispatch contract pack lowering",
)
old_expand = '''export function expandContractConformancePolicy(policy: unknown) {
  const base = clone(policy as PolicyProjection), macro = contractMacro(base);
  if (!macro) return base;
  delete base.contract_conformance;'''
new_expand = '''function materializeContractConformance(base: PolicyProjection, macro: Record<string, unknown>) {'''
s = once(s, old_expand, new_expand, "convert contract expander to pack materializer")
old_resolve = '''export function resolvePolicyProfile(policy: unknown) {
  const errors = [...compileProfilePolicy(policy), ...compileContractConformancePolicy(policy)];
  if (errors.length) return { ok: false, policy: clone(policy), errors };
  return { ok: true, policy: expandContractConformancePolicy(expandPolicyProfile(policy)), errors };
}'''
new_resolve = '''export function resolvePolicyProfile(policy: unknown) {
  const errors = compileProfilePolicy(policy);
  if (errors.length) return { ok: false, policy: clone(policy), errors };
  return { ok: true, policy: expandPolicyProfile(policy), errors };
}'''
s = once(s, old_resolve, new_resolve, "remove second macro pass")
if "contract_conformance" in s:
    raise SystemExit("production source still contains legacy snake-case authoring field")
write(path, s)

# Public schema: contract conformance is only a member of packs.
path = "schemas/repo-policy.schema.json"
s = read(path)
s = once(s, '    "contract_conformance": {\n      "$ref": "#/definitions/contract_conformance"\n    },\n', "", "remove top-level contract_conformance")
s = once(
    s,
    '        "repo-guard-workflow": { "$ref": "#/definitions/repo_guard_workflow_pack" }',
    '        "repo-guard-workflow": { "$ref": "#/definitions/repo_guard_workflow_pack" },\n        "contract-conformance": { "$ref": "#/definitions/contract_conformance_pack" }',
    "add contract pack schema",
)
s = once(s, '    "contract_conformance": {\n', '    "contract_conformance_pack": {\n', "rename private contract schema definition")
write(path, s)

# Main policy-profile corpus: keep semantics, migrate authoring to the pack.
path = "tests/test-policy-profiles.mjs"
s = read(path)
s = once(
    s,
    'import { compileContractConformancePolicy, compileProfilePolicy, resolvePolicyProfile } from "../dist/policy-profiles.mjs";',
    'import { compileProfilePolicy, resolvePolicyProfile } from "../dist/policy-profiles.mjs";',
    "remove legacy compiler import",
)
s = once(s, 'const root = resolve(__dirname, "..");\n', 'const root = resolve(__dirname, "..");\nconst contractErrors = (policy) => resolvePolicyProfile(policy).errors;\n', "add pack validation helper")
s = once(s, '    contract_conformance: contractConformanceMacro(),\n', '    packs: { "contract-conformance": contractConformanceMacro() },\n', "contractPolicy pack authoring")
s = s.replace("compileContractConformancePolicy(", "contractErrors(")
s = s.replace('.contract_conformance', '.packs["contract-conformance"]')
s = once(
    s,
    '  expect("macro source field disappears after expansion", resolved.policy.packs["contract-conformance"], undefined);',
    '  expect("pack source field disappears after expansion", resolved.policy.packs, undefined);',
    "resolved pack source assertion",
)
s = s.replace('    contract_conformance: historyContractConformanceMacro(),\n', '    packs: { "contract-conformance": historyContractConformanceMacro() },\n')
write(path, s)

# Policy-delta corpus: same macro semantics, new public authoring path.
path = "tests/test-policy-delta-rules.mjs"
s = read(path)
s = once(
    s,
    'import { compileContractConformancePolicy, resolvePolicyProfile } from "../dist/policy-profiles.mjs";',
    'import { resolvePolicyProfile } from "../dist/policy-profiles.mjs";',
    "delta remove legacy compiler import",
)
s = once(s, 'const file = (path, extra = {}) =>', 'const contractErrors = (policy) => resolvePolicyProfile(policy).errors;\nconst file = (path, extra = {}) =>', "delta validation helper")
start = s.index('const macroPolicy = () => ({')
end = s.index('\n});', start) + len('\n});')
block = s[start:end]
block = once(block, '  contract_conformance: {\n', '  packs: { "contract-conformance": {\n', "delta macro pack property")
block = once(block, '  },\n});', '  } },\n});', "delta macro pack close")
s = s[:start] + block + s[end:]
s = s.replace('.contract_conformance', '.packs["contract-conformance"]')
s = once(
    s,
    '  contract_conformance: structuredClone(contractConformance),\n',
    '  packs: { "contract-conformance": structuredClone(contractConformance) },\n',
    "delta schema pack property",
)
s = s.replace("compileContractConformancePolicy(", "contractErrors(")
write(path, s)

# Current-promotion corpus: preserve strictness assertions while changing authoring path.
path = "tests/test-contract-conformance-current-promotion.mjs"
s = read(path)
start = s.index('function sourcePolicy(version) {')
end = s.index('\n}\n\nfunction resolve(source)', start) + len('\n}')
block = s[start:end]
block = once(block, '    contract_conformance: {\n', '    packs: { "contract-conformance": {\n', "promotion source pack property")
block = once(block, '    },\n  };\n}', '    } },\n  };\n}', "promotion source pack close")
s = s[:start] + block + s[end:]
s = s.replace('.contract_conformance', '.packs["contract-conformance"]')
s = once(
    s,
    '    contract_conformance: structuredClone(source.packs["contract-conformance"]),\n',
    '    packs: { "contract-conformance": structuredClone(source.packs["contract-conformance"]) },\n',
    "promotion schema pack property",
)
s = s.replace('contract_conformance.', 'packs.contract-conformance.')
write(path, s)

print("C3.10b contract-conformance pack cutover patch applied")
