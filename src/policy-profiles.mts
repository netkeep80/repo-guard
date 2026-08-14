import { normalizeDocumentFact } from "./document-facts.mjs";
import { matchesAny } from "./utils/path-patterns.mjs";

const REQUIREMENT_ID = "(?:BR|SR|FR|NFR|CR|IR)-[0-9]{3}";

const PACKS = {
  "requirements-strict": {
    defaults: {
      requirement_json_globs: [
        "requirements/business/*.json", "requirements/stakeholder/*.json", "requirements/functional/*.json",
        "requirements/nonfunctional/*.json", "requirements/constraints/*.json", "requirements/interface/*.json",
      ],
      code_reference_globs: [
        "scripts/**/*.js", "include/**/*.{h,hpp,hh}", "src/**/*.{h,hpp,hh,c,cc,cpp,cxx}",
        "tests/**/*.{h,hpp,hh,c,cc,cpp,cxx,js,mjs}", "examples/**/*.{h,hpp,hh,c,cc,cpp,cxx,js,mjs}",
      ],
      doc_reference_globs: ["*.md", "docs/**/*.md", "requirements/**/*.md", ".github/**/*.md"],
      strict_heading_docs: ["docs/**/*.md"],
      evidence_surfaces: ["src/**", "tests/**", "docs/**", "README.md", "requirements/README.md"],
      implementation_evidence_surfaces: ["include/**", "src/**", "scripts/**", ".github/workflows/**"],
      verification_evidence_surfaces: ["tests/**", "experiments/**", "scripts/**", ".github/workflows/**"],
    },
    anchors: {
      requirement_id: { kind: "json_field", globs: "$requirement_json_globs", field: "id" },
      requirement_json_req_ref: { kind: "regex", globs: "$requirement_json_globs", pattern: `"(${REQUIREMENT_ID})"` },
      code_req_ref: { kind: "regex", globs: "$code_reference_globs", pattern: `(?:@req\\s+|,\\s*)(${REQUIREMENT_ID})` },
      doc_req_ref: { kind: "regex", globs: "$doc_reference_globs", pattern: `(?:^|[^A-Z0-9])(${REQUIREMENT_ID})(?![0-9])` },
      doc_heading_req_ref: { kind: "regex", globs: "$strict_heading_docs", pattern: `(?:^|\\n)#{1,6}\\s+[^\\n]*?\\[(${REQUIREMENT_ID})\\]` },
      doc_heading_without_req_ref: { kind: "regex", globs: "$strict_heading_docs", pattern: `(?:^|\\n)(#{1,6}\\s+(?![^\\n]*\\[${REQUIREMENT_ID}\\])[^\\n]*)` },
    },
    trace_rules: [
      { id: "requirement-json-req-refs-must-resolve", kind: "must_resolve", from_anchor_type: "requirement_json_req_ref", to_anchor_type: "requirement_id" },
      { id: "code-req-refs-must-resolve", kind: "must_resolve", from_anchor_type: "code_req_ref", to_anchor_type: "requirement_id" },
      { id: "doc-req-refs-must-resolve", kind: "must_resolve", from_anchor_type: "doc_req_ref", to_anchor_type: "requirement_id" },
      { id: "doc-heading-req-refs-must-resolve", kind: "must_resolve", from_anchor_type: "doc_heading_req_ref", to_anchor_type: "requirement_id" },
      { id: "doc-headings-must-have-req-ref", kind: "must_resolve", from_anchor_type: "doc_heading_without_req_ref", to_anchor_type: "requirement_id" },
      { id: "changed-requirements-need-evidence", kind: "changed_files_require_evidence", if_changed: "$requirement_json_globs", must_touch_any: "$changed_requirement_evidence_surfaces" },
      { id: "declared-affected-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.affects", must_touch_any: "$affected_evidence_surfaces" },
      { id: "declared-implemented-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.implements", must_touch_any: "$implementation_evidence_surfaces" },
      { id: "declared-verified-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.verifies", must_touch_any: "$verification_evidence_surfaces" },
    ],
  },
};

type ProfileSource = { kind: string; globs: string | string[]; field?: string; pattern?: string };
type ProfileRule = Record<string, unknown>;
interface ProfileSpec {
  defaults: Record<string, string[]>;
  anchors: Record<string, ProfileSource>;
  trace_rules: ProfileRule[];
}
type ProfileConfig = Record<string, unknown>;
type ContractRole = "current.contract" | "current.conformance";
interface PolicyProjection extends Record<string, unknown> {
  profile?: string;
  profile_overrides?: unknown;
  anchors?: unknown;
  trace_rules?: unknown;
  contract_conformance?: unknown;
  document_relations?: unknown;
  cochange_rules?: unknown;
  paths?: Record<string, unknown>;
}
interface ProfileValidationError {
  field: string;
  profile?: string;
  message: string;
}

const OVERRIDE_FIELDS = new Set([
  ...Object.keys(PACKS["requirements-strict"].defaults),
  "changed_requirement_evidence_surfaces", "affected_evidence_surfaces",
]);
const CONTRACT_ROLES = new Set<ContractRole>(["current.contract", "current.conformance"]);
const GENERATED_DOCUMENTS = {
  "current.contract": "contract-conformance.current.contract",
  "current.conformance": "contract-conformance.current.conformance",
} as const;
const GENERATED_RULE_IDS = [
  "contract-conformance:current-id",
  "contract-conformance:current-conformance-path",
  "contract-conformance:current-contract-status",
  "contract-conformance:current-conformance-status",
  "contract-conformance:current-contract-accepted",
  "contract-conformance:current-conformance-accepted",
];
const clone = <T,>(value: T): T => structuredClone(value);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const ref = (value: unknown, config: ProfileConfig): unknown => typeof value === "string" && value.startsWith("$") ? clone(config[value.slice(1)]) : clone(value);
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function configFor(spec: ProfileSpec, overrides: Record<string, unknown> = {}): ProfileConfig {
  const config: ProfileConfig = clone(spec.defaults);
  for (const [key, value] of Object.entries(overrides)) config[key] = clone(value);
  config.changed_requirement_evidence_surfaces ||= clone(config.evidence_surfaces);
  config.affected_evidence_surfaces ||= clone(config.evidence_surfaces);
  return config;
}

function materializePack(spec: ProfileSpec, overrides: Record<string, unknown>) {
  const config = configFor(spec, overrides), types: Record<string, { sources: Array<Record<string, unknown>> }> = {};
  for (const [name, source] of Object.entries(spec.anchors)) {
    const globs = ref(source.globs, config) as string[];
    types[name] = { sources: globs.map((glob) => source.kind === "json_field"
      ? { kind: source.kind, glob, field: source.field }
      : { kind: source.kind, glob, pattern: source.pattern }) };
  }
  const trace_rules = spec.trace_rules.map((rule) => Object.fromEntries(
    Object.entries(rule).map(([key, value]) => [key, ref(value, config)])
  ));
  return { anchors: { types }, trace_rules };
}

function contractMacro(policy: PolicyProjection) {
  return isObject(policy.contract_conformance) ? policy.contract_conformance : null;
}

function currentRoleDocuments(macro: Record<string, unknown>) {
  const current = isObject(macro.current) ? macro.current : {};
  return {
    "current.contract": isObject(current.contract) ? current.contract : {},
    "current.conformance": isObject(current.conformance) ? current.conformance : {},
  } satisfies Record<ContractRole, Record<string, unknown>>;
}

function normalizeDocumentPath(value: unknown): string | null {
  try { return normalizeDocumentFact(value, "repository_path") as string; }
  catch { return null; }
}

function generatedRuleIds(macro: Record<string, unknown>): string[] {
  return [
    ...GENERATED_RULE_IDS,
    ...((Array.isArray(macro.required_paths) ? macro.required_paths : []).map((_, index) => `contract-conformance:required-path:${index}`)),
  ];
}

export const listBuiltInProfiles = (): string[] => Object.keys(PACKS).sort();

export function compileProfilePolicy(policy: unknown): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [], profile = (policy as PolicyProjection | null | undefined)?.profile, overrides = (policy as PolicyProjection | null | undefined)?.profile_overrides;
  if (overrides !== undefined && !profile) errors.push({ field: "profile_overrides", message: "profile_overrides requires top-level profile" });
  if (profile !== undefined && !(PACKS as unknown as Record<string, ProfileSpec>)[profile]) errors.push({ field: "profile", profile, message: `profile "${profile}" is not supported; use ${listBuiltInProfiles().join(", ")}` });
  if (overrides !== undefined) {
    if (!isObject(overrides)) errors.push({ field: "profile_overrides", message: "profile_overrides must be an object" });
    else for (const [field, value] of Object.entries(overrides)) {
      if (!OVERRIDE_FIELDS.has(field)) errors.push({ field: `profile_overrides.${field}`, message: `profile_overrides.${field} is not supported` });
      else if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) {
        errors.push({ field: `profile_overrides.${field}`, message: `profile_overrides.${field} must be a non-empty array of non-empty strings` });
      }
    }
  }
  return errors;
}

export function compileContractConformancePolicy(policy: unknown): ProfileValidationError[] {
  const source = policy as PolicyProjection | null | undefined;
  if (source?.contract_conformance === undefined) return [];
  if (!isObject(source.contract_conformance)) return [{ field: "contract_conformance", message: "contract_conformance must be an object" }];

  const macro = source.contract_conformance, errors: ProfileValidationError[] = [];
  const roles = currentRoleDocuments(macro), paths = new Map<ContractRole, string>();
  for (const role of CONTRACT_ROLES) {
    const definition = roles[role], path = normalizeDocumentPath(definition.path), format = definition.format;
    if (!path) errors.push({ field: `contract_conformance.current.${role.split(".")[1]}.path`, message: `${role} path must be a canonical repository path` });
    else paths.set(role, path);
    if (format !== "json" && format !== "yaml") errors.push({ field: `contract_conformance.current.${role.split(".")[1]}.format`, message: `${role} format must be json or yaml` });
  }
  if (paths.get("current.contract") && paths.get("current.contract") === paths.get("current.conformance")) {
    errors.push({ field: "contract_conformance.current", message: "current contract and conformance paths must be distinct" });
  }

  const pairFields = isObject(macro.pair_fields) ? macro.pair_fields : {};
  for (const field of ["contract_id", "conformance_contract_id", "contract_conformance_path", "contract_status", "conformance_status", "contract_accepted", "conformance_accepted"]) {
    if (typeof pairFields[field] !== "string") errors.push({ field: `contract_conformance.pair_fields.${field}`, message: `${field} must be a JSON Pointer string` });
  }
  const acceptedState = isObject(macro.accepted_state) ? macro.accepted_state : {};
  if (typeof acceptedState.status !== "string") errors.push({ field: "contract_conformance.accepted_state.status", message: "accepted_state.status must be a string" });
  if (typeof acceptedState.accepted !== "boolean") errors.push({ field: "contract_conformance.accepted_state.accepted", message: "accepted_state.accepted must be a boolean" });

  const selectors = Array.isArray(macro.required_paths) ? macro.required_paths : [], selectorKeys = new Set<string>();
  for (const [index, rawSelector] of selectors.entries()) {
    const selector = isObject(rawSelector) ? rawSelector : {}, role = selector.document as ContractRole;
    if (!CONTRACT_ROLES.has(role)) errors.push({ field: `contract_conformance.required_paths[${index}].document`, message: `required_paths[${index}] references unknown role "${selector.document}"` });
    const key = `${selector.document}|${selector.pointer}|${selector.projection}`;
    if (selectorKeys.has(key)) errors.push({ field: `contract_conformance.required_paths[${index}]`, message: `required_paths[${index}] duplicates selector ${key}` });
    selectorKeys.add(key);
  }

  const cochange = stringList(macro.cochange), seenRoles = new Set<string>();
  for (const [index, role] of cochange.entries()) {
    if (!CONTRACT_ROLES.has(role as ContractRole)) errors.push({ field: `contract_conformance.cochange[${index}]`, message: `cochange references unknown role "${role}"` });
    if (seenRoles.has(role)) errors.push({ field: `contract_conformance.cochange[${index}]`, message: `cochange duplicates role "${role}"` });
    seenRoles.add(role);
  }
  if (cochange.length < 2) errors.push({ field: "contract_conformance.cochange", message: "cochange must contain at least two distinct roles" });

  const controlPaths = stringList(macro.control_paths).map((item) => item.trim()).filter(Boolean);
  if (!controlPaths.length) errors.push({ field: "contract_conformance.control_paths", message: "control_paths must contain at least one non-empty pattern" });
  for (const [role, path] of paths) if (controlPaths.length && !matchesAny(path, controlPaths)) {
    errors.push({ field: "contract_conformance.control_paths", message: `control_paths do not cover ${role} path "${path}"` });
  }

  const explicitRelations = isObject(source.document_relations) ? source.document_relations : {}, explicitDocuments = isObject(explicitRelations.documents) ? explicitRelations.documents : {};
  for (const name of Object.values(GENERATED_DOCUMENTS)) if (Object.hasOwn(explicitDocuments, name)) {
    errors.push({ field: "document_relations.documents", message: `contract_conformance generated document "${name}" collides with explicit document_relations` });
  }
  const explicitRuleIds = new Set((Array.isArray(explicitRelations.rules) ? explicitRelations.rules : []).map((rule) => isObject(rule) ? rule.id : undefined));
  for (const id of generatedRuleIds(macro)) if (explicitRuleIds.has(id)) {
    errors.push({ field: "document_relations.rules", message: `contract_conformance generated rule "${id}" collides with explicit document_relations` });
  }
  return errors;
}

export function expandPolicyProfile(policy: unknown) {
  const base: PolicyProjection = clone(policy as PolicyProjection), spec = (PACKS as unknown as Record<string, ProfileSpec>)[base.profile as string];
  if (!spec) return base;
  const patch = materializePack(spec, (base.profile_overrides as Record<string, unknown>) || {});
  return { ...base, anchors: base.anchors || patch.anchors, trace_rules: base.trace_rules || patch.trace_rules };
}

export function expandContractConformancePolicy(policy: unknown) {
  const base = clone(policy as PolicyProjection), macro = contractMacro(base);
  if (!macro) return base;
  delete base.contract_conformance;

  const roleDefinitions = currentRoleDocuments(macro);
  const rolePaths = Object.fromEntries(Object.entries(roleDefinitions).map(([role, definition]) => [role, normalizeDocumentPath(definition.path)!])) as Record<ContractRole, string>;
  const relations = isObject(base.document_relations) ? clone(base.document_relations) : {}, documents = isObject(relations.documents) ? clone(relations.documents) : {};
  const rules = Array.isArray(relations.rules) ? clone(relations.rules) : [], pairFields = macro.pair_fields as Record<string, string>, acceptedState = macro.accepted_state as { status: string; accepted: boolean };
  for (const role of CONTRACT_ROLES) {
    documents[GENERATED_DOCUMENTS[role]] = { path: rolePaths[role], format: roleDefinitions[role].format };
  }
  const selector = (role: ContractRole, pointer: string, type: "string" | "boolean") => ({ document: GENERATED_DOCUMENTS[role], pointer, type });
  rules.push(
    { id: GENERATED_RULE_IDS[0], kind: "scalar_equal", left: selector("current.conformance", pairFields.conformance_contract_id, "string"), right: selector("current.contract", pairFields.contract_id, "string") },
    { id: GENERATED_RULE_IDS[1], kind: "scalar_equals_literal", source: selector("current.contract", pairFields.contract_conformance_path, "string"), value: rolePaths["current.conformance"] },
    { id: GENERATED_RULE_IDS[2], kind: "scalar_equals_literal", source: selector("current.contract", pairFields.contract_status, "string"), value: acceptedState.status },
    { id: GENERATED_RULE_IDS[3], kind: "scalar_equals_literal", source: selector("current.conformance", pairFields.conformance_status, "string"), value: acceptedState.status },
    { id: GENERATED_RULE_IDS[4], kind: "scalar_equals_literal", source: selector("current.contract", pairFields.contract_accepted, "boolean"), value: acceptedState.accepted },
    { id: GENERATED_RULE_IDS[5], kind: "scalar_equals_literal", source: selector("current.conformance", pairFields.conformance_accepted, "boolean"), value: acceptedState.accepted },
  );
  for (const [index, rawSelector] of (macro.required_paths as Array<Record<string, unknown>> || []).entries()) {
    const source = rawSelector as { document: ContractRole; pointer: string; projection: "array_items" | "object_values" };
    rules.push({ id: `contract-conformance:required-path:${index}`, kind: "referenced_paths_exist", source: { document: GENERATED_DOCUMENTS[source.document], pointer: source.pointer, projection: source.projection, type: "repository_path_set" } });
  }
  base.document_relations = { ...relations, documents, rules };

  const cochange = macro.cochange as ContractRole[], cochangeRules = Array.isArray(base.cochange_rules) ? clone(base.cochange_rules) : [];
  for (const role of cochange) for (const peer of cochange) if (peer !== role) cochangeRules.push({ if_changed: [rolePaths[role]], must_change_any: [rolePaths[peer]] });
  base.cochange_rules = cochangeRules;

  const paths = isObject(base.paths) ? clone(base.paths) : {}, governance = stringList(paths.governance_paths), controlPaths = stringList(macro.control_paths);
  paths.governance_paths = [...new Set([...governance, ...controlPaths])].sort();
  base.paths = paths;
  return base;
}

export function resolvePolicyProfile(policy: unknown) {
  const errors = [...compileProfilePolicy(policy), ...compileContractConformancePolicy(policy)];
  if (errors.length) return { ok: false, policy: clone(policy), errors };
  return { ok: true, policy: expandContractConformancePolicy(expandPolicyProfile(policy)), errors };
}
