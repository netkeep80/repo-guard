import { normalizeDocumentFact } from "../document-facts.mjs";

type EnforcementMode = "advisory" | "blocking";
type CountMode = "changed_only" | "all_tracked";
type RankRelation = "lower_stricter" | "higher_stricter";
type SetRelation = "superset_stricter" | "subset_stricter";
type StrictnessRelation = RankRelation | SetRelation | "equal_or_incomparable" | "required_entity";
type ComparisonRelation = "equal" | "weaker" | "incomparable" | "stricter";
type DiagnosticValue = string | number | boolean | null | undefined;
type DocumentFactType = "scalar" | "string" | "boolean" | "string_set" | "repository_path" | "repository_path_set";
type ContractConformanceRole = "current.contract" | "current.conformance" | "previous.contract" | "previous.conformance" | "acceptance";

interface StrictnessMetadata {
  owner?: string;
  pointer?: string;
  weakenKind?: string;
  removeKind?: string;
  itemField?: string;
  field?: string;
  rule_id?: string;
  workflow_id?: string;
  integration_doc_id?: string;
  evidence_binding_id?: string;
  raw?: DiagnosticValue;
  removeBefore?: unknown;
  removeAfter?: unknown;
  removeMessage?: string;
  incomparableMessage?: string;
  message?: (before: string | number, after?: string | number) => string;
}

interface RankStrictness extends StrictnessMetadata { relation: RankRelation; value: number; }
interface SetStrictness extends StrictnessMetadata { relation: SetRelation; value: Array<string | number>; }
interface ExactStrictness extends StrictnessMetadata { relation: "equal_or_incomparable"; value: unknown; }
interface EntityStrictness extends StrictnessMetadata { relation: "required_entity"; value: true; }
type StrictnessConstraint = RankStrictness | SetStrictness | ExactStrictness | EntityStrictness;

export interface RuntimeConstraint {
  kind: string;
  name: string;
  [key: string]: unknown;
}

export interface ConstraintProgramEntry {
  key: string;
  runtime: RuntimeConstraint | null;
  strictness: StrictnessConstraint | null;
}

export interface RuntimeProgramConstraint extends RuntimeConstraint { key: string; }
type StrictnessProgramEntry = StrictnessConstraint & { key: string };

interface DiffRulesProjection { max_new_docs?: number; max_new_files?: number; max_net_added_lines?: number; }
interface PathsProjection { forbidden?: unknown; governance_paths?: unknown; operational_paths?: unknown; canonical_docs?: unknown; }
interface SizeRuleProjection {
  id: string; glob?: unknown; max?: number; scope?: unknown; metric?: unknown; applies_to_change_types?: unknown;
  level?: EnforcementMode; count?: CountMode; ignore?: unknown; max_growth?: number;
}
interface IntegrationWorkflowProjection { id: string; kind?: unknown; path?: unknown; role?: unknown; profiles?: unknown; expect?: { enforcement?: EnforcementMode; [key: string]: unknown }; }
interface IntegrationDocProjection { id: string; must_reference_files?: unknown; [key: string]: unknown; }
interface IntegrationProjection { workflows?: IntegrationWorkflowProjection[]; docs?: IntegrationDocProjection[]; [key: string]: unknown; }
interface CochangeRuleProjection { if_changed?: unknown; must_change_any?: unknown; [key: string]: unknown; }
interface CochangeRoleEdge { from: ContractConformanceRole; to: ContractConformanceRole; }
interface DocumentDefinitionProjection { path?: unknown; format?: unknown; }
interface DocumentSelectorProjection { document?: unknown; pointer?: unknown; projection?: unknown; type?: unknown; }
interface DocumentRelationRuleProjection { id?: unknown; kind?: unknown; left?: unknown; right?: unknown; source?: unknown; value?: unknown; }
interface DocumentRelationsProjection { documents?: Record<string, DocumentDefinitionProjection>; rules?: DocumentRelationRuleProjection[]; }
interface EvidenceBindingProjection {
  id?: unknown;
  kind?: unknown;
  source?: DocumentSelectorProjection;
  workflow?: unknown;
  covers?: unknown;
  target_anchor_type?: unknown;
}

export interface ConstraintPolicyProjection {
  diff_rules?: DiffRulesProjection;
  paths?: PathsProjection;
  enforcement?: { mode?: EnforcementMode };
  size_rules?: SizeRuleProjection[];
  integration?: IntegrationProjection;
  registry_rules?: unknown[];
  trace_rules?: unknown[];
  change_profiles?: unknown;
  cochange_rules?: CochangeRuleProjection[];
  document_relations?: DocumentRelationsProjection;
  evidence_bindings?: EvidenceBindingProjection[];
}

interface ChangeIntentProjection { budgets?: DiffRulesProjection; surface_debt?: unknown; scope?: unknown; must_touch?: unknown; must_not_touch?: unknown; }

export interface PolicyRelaxation {
  kind: string; pointer?: string; before: unknown; after: unknown; message?: string; rule_id?: string; field?: string;
  workflow_id?: string; integration_doc_id?: string; evidence_binding_id?: string; [key: string]: unknown;
}
export interface PolicyIncomparableChange { kind: "policy_incomparable"; pointer?: string; before: unknown; after: unknown; message: string; }
export interface ConstraintProgramComparison { relation: ComparisonRelation; relaxations: PolicyRelaxation[]; incomparable: PolicyIncomparableChange[]; }

const RANKS = {
  enforcement: { advisory: 0, blocking: 1 },
  count: { changed_only: 0, all_tracked: 1 },
};
const CONTRACT_CONFORMANCE_DOCUMENT_ROLES = new Map<string, ContractConformanceRole>([
  ["contract-conformance.current.contract", "current.contract"],
  ["contract-conformance.current.conformance", "current.conformance"],
  ["contract-conformance.previous.contract", "previous.contract"],
  ["contract-conformance.previous.conformance", "previous.conformance"],
  ["contract-conformance.acceptance", "acceptance"],
]);
const array = <T,>(value: T[] | null | undefined): T[] => Array.isArray(value) ? value : [];
const compare = (relation: StrictnessRelation, value: unknown, metadata: StrictnessMetadata = {}) => ({ relation, value, ...metadata });
const scalar = (relation: RankRelation, value: number, metadata: StrictnessMetadata): RankStrictness => compare(relation, value, metadata) as RankStrictness;
const set = (relation: SetRelation, value: unknown, metadata: StrictnessMetadata): SetStrictness => compare(relation, array(value as Array<string | number> | undefined), metadata) as SetStrictness;
const exact = (value: unknown, metadata: StrictnessMetadata): ExactStrictness => compare("equal_or_incomparable", value, metadata) as ExactStrictness;
const entity = (metadata: StrictnessMetadata): EntityStrictness => compare("required_entity", true, metadata) as EntityStrictness;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function canonicalDocumentPath(value: unknown): string {
  try { return normalizeDocumentFact(value, "repository_path") as string; }
  catch { return typeof value === "string" ? value : String(value ?? ""); }
}
function compileDocumentSelector(selectorValue: unknown, documents: Record<string, DocumentDefinitionProjection>) {
  const selector = object(selectorValue), name = typeof selector.document === "string" ? selector.document : "", definition = documents[name] || {};
  return {
    document: name,
    path: canonicalDocumentPath(definition.path),
    format: definition.format,
    pointer: typeof selector.pointer === "string" ? selector.pointer : "",
    projection: selector.projection,
    type: selector.type as DocumentFactType,
  };
}
function contractConformanceRolesByPath(documents: Record<string, DocumentDefinitionProjection>): Map<string, ContractConformanceRole> {
  const roles = new Map<string, ContractConformanceRole>();
  for (const [document, role] of CONTRACT_CONFORMANCE_DOCUMENT_ROLES) {
    const definition = documents[document];
    if (definition?.path !== undefined) roles.set(canonicalDocumentPath(definition.path), role);
  }
  return roles;
}
function cochangeRoleEdge(rule: CochangeRuleProjection, rolesByPath: Map<string, ContractConformanceRole>): CochangeRoleEdge | null {
  if (Object.keys(rule).some((field) => field !== "if_changed" && field !== "must_change_any")) return null;
  const changed = array(rule.if_changed as string[] | undefined), required = array(rule.must_change_any as string[] | undefined);
  if (changed.length !== 1 || required.length !== 1) return null;
  const from = rolesByPath.get(canonicalDocumentPath(changed[0])), to = rolesByPath.get(canonicalDocumentPath(required[0]));
  return from && to && from !== to ? { from, to } : null;
}
function generatedContractConformanceCochange(rules: CochangeRuleProjection[], documents: Record<string, DocumentDefinitionProjection>): Map<number, CochangeRoleEdge> {
  const rolesByPath = contractConformanceRolesByPath(documents), roleCount = rolesByPath.size;
  for (let count = 2; count <= roleCount; count++) {
    const edgeCount = count * (count - 1);
    if (edgeCount > rules.length) continue;
    const start = rules.length - edgeCount, edges = rules.slice(start).map((rule) => cochangeRoleEdge(rule, rolesByPath));
    if (edges.some((edge) => edge === null)) continue;
    const typed = edges as CochangeRoleEdge[], order = [...new Set(typed.map((edge) => edge.from))];
    if (order.length !== count) continue;
    const expected = order.flatMap((from) => order.filter((to) => to !== from).map((to) => ({ from, to })));
    if (expected.some((edge, index) => edge.from !== typed[index].from || edge.to !== typed[index].to)) continue;
    return new Map(typed.map((edge, offset) => [start + offset, edge]));
  }
  return new Map();
}

export function compileConstraintProgram(policy: ConstraintPolicyProjection = {}, changeIntent: ChangeIntentProjection | null = null): ConstraintProgramEntry[] {
  const program: ConstraintProgramEntry[] = [], diff = policy.diff_rules || {}, budgets = changeIntent?.budgets || {};
  const add = (key: string, runtime: RuntimeConstraint | null = null, strictness: StrictnessConstraint | null = null) => program.push({ key, runtime, strictness });

  add("paths:forbidden", { kind: "forbid_paths", name: "forbidden-paths", patterns: policy.paths?.forbidden || [] },
    set("superset_stricter", policy.paths?.forbidden, { pointer: "/paths/forbidden", weakenKind: "forbidden_path_removed", itemField: "pattern", message: (item) => `paths.forbidden removed: ${item}` }));

  for (const [field, metric, name] of [
    ["max_new_docs", "new_docs", "canonical-docs-budget"], ["max_new_files", "new_files", "max-new-files"], ["max_net_added_lines", "net_added_lines", "max-net-added-lines"],
  ] as const) {
    const value = diff[field];
    add(`diff:${field}`, { kind: "max_metric", name, metric, max: budgets[field] ?? value }, typeof value === "number" ? scalar("lower_stricter", value, {
      pointer: `/diff_rules/${field}`, weakenKind: "diff_rule_budget_increased", removeKind: "diff_rule_budget_removed", field,
      message: (before, after) => `diff_rules.${field}: ${before} -> ${after}`, removeMessage: `diff_rules.${field} removed (was ${value})`,
    }) : null);
  }

  for (const [key, field, relation, kind, message] of [
    ["paths:governance", "governance_paths", "superset_stricter", "governance_path_removed", (item: string | number) => `paths.governance_paths removed: ${item}`],
    ["paths:operational", "operational_paths", "subset_stricter", "operational_path_added", (item: string | number) => `paths.operational_paths added exclusion: ${item}`],
    ["paths:canonical_docs", "canonical_docs", "subset_stricter", "canonical_doc_added", (item: string | number) => `paths.canonical_docs added exemption: ${item}`],
  ] as const) add(key, null, set(relation, policy.paths?.[field], { pointer: `/paths/${field}`, weakenKind: kind, itemField: "pattern", message }));

  const mode = policy.enforcement?.mode;
  if (mode) add("enforcement", null, scalar("higher_stricter", RANKS.enforcement[mode], {
    raw: mode, pointer: "/enforcement/mode", weakenKind: "enforcement_weakened", removeKind: "enforcement_removed",
    message: (before, after) => `enforcement.mode: ${before} -> ${after}`, removeMessage: `enforcement.mode removed (was ${mode})`,
  }));

  for (const rule of array(policy.size_rules)) {
    const owner = `size:${rule.id}`, pointer = `/size_rules/${rule.id}`;
    add(owner, null, entity({ owner, pointer, removeKind: "size_rule_removed", rule_id: rule.id,
      removeBefore: { present: true, glob: rule.glob, max: rule.max }, removeAfter: { present: false }, removeMessage: `size_rules entry "${rule.id}" removed (glob: ${rule.glob ?? "?"}, max: ${rule.max ?? "?"})` }));
    add(`${owner}:shape`, null, exact({ scope: rule.scope, metric: rule.metric, glob: rule.glob, applies_to_change_types: rule.applies_to_change_types }, { owner, pointer, incomparableMessage: `size_rules[${rule.id}] changed selector/scope semantics` }));
    add(`${owner}:max`, null, scalar("lower_stricter", rule.max as number, { owner, pointer: `${pointer}/max`, weakenKind: "size_rule_max_increased", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].max: ${a} -> ${b}` }));
    add(`${owner}:level`, null, scalar("higher_stricter", RANKS.enforcement[rule.level || "blocking"], { owner, raw: rule.level || "blocking", pointer: `${pointer}/level`, weakenKind: "size_rule_level_weakened", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].level: ${a} -> ${b}` }));
    add(`${owner}:count`, null, scalar("higher_stricter", RANKS.count[rule.count || "all_tracked"], { owner, raw: rule.count || "all_tracked", pointer: `${pointer}/count`, weakenKind: "size_rule_count_weakened", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].count: ${a} -> ${b}` }));
    add(`${owner}:ignore`, null, set("subset_stricter", rule.ignore, { owner, pointer: `${pointer}/ignore`, weakenKind: "size_rule_ignore_added", itemField: "pattern", message: (item) => `size_rules[${rule.id}].ignore added: ${item}` }));
    if (rule.max_growth !== undefined) add(`${owner}:max_growth`, null, scalar("lower_stricter", rule.max_growth, {
      owner, pointer: `${pointer}/max_growth`, weakenKind: "size_rule_max_growth_increased", removeKind: "size_rule_max_growth_removed", rule_id: rule.id,
      message: (a, b) => `size_rules[${rule.id}].max_growth: ${a} -> ${b}`, removeMessage: `size_rules[${rule.id}].max_growth removed (was ${rule.max_growth})`,
    }));
  }

  for (const workflow of array(policy.integration?.workflows)) {
    const owner = `workflow:${workflow.id}`, pointer = `/integration/workflows/${workflow.id}`;
    add(owner, null, entity({ owner, pointer, removeKind: "integration_workflow_removed", workflow_id: workflow.id,
      removeBefore: { present: true, role: workflow.role, path: workflow.path }, removeAfter: { present: false }, removeMessage: `integration.workflows entry "${workflow.id}" removed` }));
    const { enforcement, ...otherExpect } = workflow.expect || {};
    add(`${owner}:shape`, null, exact({ kind: workflow.kind, path: workflow.path, role: workflow.role, profiles: workflow.profiles, expect: otherExpect }, { owner, pointer, incomparableMessage: `integration.workflows[${workflow.id}] changed non-monotonic wiring semantics` }));
    if (enforcement) add(`${owner}:enforcement`, null, scalar("higher_stricter", RANKS.enforcement[enforcement], {
      owner, raw: enforcement, pointer: `${pointer}/expect/enforcement`, weakenKind: "integration_workflow_expectation_weakened", removeKind: "integration_workflow_expectation_removed", workflow_id: workflow.id,
      message: (a, b) => `integration.workflows[${workflow.id}].expect.enforcement: ${a} -> ${b}`, removeMessage: `integration.workflows[${workflow.id}].expect.enforcement removed (was ${enforcement})`,
    }));
  }

  for (const doc of array(policy.integration?.docs)) {
    const id = String(doc.id ?? ""), owner = `integration-doc:${id}`, pointer = `/integration/docs/${id}`;
    add(owner, null, entity({ owner, pointer, removeKind: "integration_doc_removed", integration_doc_id: id,
      removeBefore: { present: true, must_reference_files: array(doc.must_reference_files as string[] | undefined) }, removeAfter: { present: false }, removeMessage: `integration.docs entry "${id}" removed` }));
    add(`${owner}:must_reference_files`, null, set("superset_stricter", doc.must_reference_files, {
      owner, pointer: `${pointer}/must_reference_files`, weakenKind: "integration_doc_required_file_removed", itemField: "file", integration_doc_id: id,
      message: (item) => `integration.docs[${id}].must_reference_files removed: ${item}`,
    }));
  }

  const documentRelations = policy.document_relations, documents = documentRelations?.documents || {};
  for (const rule of array(documentRelations?.rules)) {
    const id = String(rule.id ?? ""), owner = `document-relation:${id}`, pointer = `/document_relations/rules/${id}`;
    const runtimeBase = { name: owner, relation_id: id };
    let runtime: RuntimeConstraint | null = null, shape: unknown = { kind: rule.kind };
    if (rule.kind === "scalar_equal") {
      const left = compileDocumentSelector(rule.left, documents), right = compileDocumentSelector(rule.right, documents);
      runtime = { ...runtimeBase, kind: "document_scalar_equal", left, right };
      shape = { kind: rule.kind, left, right };
    } else if (rule.kind === "scalar_equals_literal") {
      const source = compileDocumentSelector(rule.source, documents);
      runtime = { ...runtimeBase, kind: "document_scalar_equals_literal", source, value: rule.value };
      shape = { kind: rule.kind, source, value: rule.value };
    } else if (rule.kind === "referenced_paths_exist") {
      const source = compileDocumentSelector(rule.source, documents);
      runtime = { ...runtimeBase, kind: "document_referenced_paths_exist", source };
      shape = { kind: rule.kind, source };
    }
    add(owner, runtime, entity({ owner, pointer, removeKind: "document_relation_removed", rule_id: id,
      removeBefore: shape, removeAfter: { present: false }, removeMessage: `document_relations rule "${id}" removed` }));
    add(`${owner}:shape`, null, exact(shape, { owner, pointer, rule_id: id, incomparableMessage: `document_relations rule "${id}" changed semantics` }));
  }

  for (const binding of array(policy.evidence_bindings)) {
    const id = String(binding.id ?? ""), owner = `evidence-binding:${id}`, pointer = `/evidence_bindings/${id}`;
    const source = compileDocumentSelector(binding.source, documents);
    const shape = binding.kind === "anchor_value_coverage"
      ? { kind: binding.kind, source, target_anchor_type: binding.target_anchor_type }
      : { kind: binding.kind, source, workflow: binding.workflow, covers: binding.covers };
    const runtime = binding.kind === "workflow_path_coverage" ? {
      kind: "evidence_workflow_path_coverage", name: owner, binding_id: id, source,
      workflow: binding.workflow, covers: array(binding.covers as string[] | undefined),
    } : binding.kind === "anchor_value_coverage" ? {
      kind: "evidence_anchor_value_coverage", name: owner, binding_id: id, source,
      target_anchor_type: binding.target_anchor_type,
    } : null;
    add(owner, runtime, entity({ owner, pointer, removeKind: "evidence_binding_removed", evidence_binding_id: id,
      removeBefore: shape, removeAfter: { present: false }, removeMessage: `evidence binding "${id}" removed` }));
    add(`${owner}:shape`, null, exact(shape, { owner, pointer, evidence_binding_id: id, incomparableMessage: `evidence binding "${id}" changed semantics` }));
  }

  if (array(policy.size_rules).length) add("runtime:size-rules", { kind: "size_rules", name: "size-rules", rules: policy.size_rules });
  if (array(policy.registry_rules).length) add("runtime:registry-rules", { kind: "registry_rules", name: "registry-rules", rules: policy.registry_rules });
  if (array(policy.trace_rules).length) add("runtime:trace-rules", { kind: "trace_rules", name: "trace-rules" });
  if (policy.change_profiles) add("runtime:change-profile", { kind: "change_profile", name: "change-profiles" });
  if (policy.integration) add("runtime:integration", { kind: "integration", name: "integration" });
  add("surface-debt", { kind: "surface_debt", name: "surface-debt", debt: changeIntent?.surface_debt });
  const cochangeRules = array(policy.cochange_rules), generatedCochange = generatedContractConformanceCochange(cochangeRules, documents);
  cochangeRules.forEach((rule, index) => {
    const generated = generatedCochange.get(index), shape = generated ? { source: "contract_conformance.cochange", ...generated } : rule, pointer = `/cochange_rules/${index}`;
    const owner = generated ? `cochange-policy:contract-conformance:${generated.from}->${generated.to}` : `cochange-policy:${index}`;
    add(`cochange:${index}`, { kind: "implies_nonempty", name: "cochange", ...rule });
    add(owner, null, entity({
      owner, pointer, removeKind: "cochange_rule_removed", removeBefore: shape, removeAfter: { present: false },
      removeMessage: generated ? `contract_conformance.cochange generated edge ${generated.from} -> ${generated.to} removed` : `cochange_rules[${index}] removed`,
    }));
    add(`${owner}:shape`, null, exact(shape, {
      owner, pointer,
      incomparableMessage: generated ? `contract_conformance.cochange generated edge ${generated.from} -> ${generated.to} changed semantics` : `cochange_rules[${index}] changed semantics`,
    }));
  });
  if (changeIntent) {
    add("change-intent:scope", { kind: "scope_paths", name: "change-intent-scope", patterns: changeIntent.scope });
    add("change-intent:must-touch", { kind: "require_paths", name: "must-touch", patterns: changeIntent.must_touch });
    add("change-intent:must-not-touch", { kind: "forbid_paths", name: "must-not-touch", patterns: changeIntent.must_not_touch, changeIntent: true });
  }
  return program;
}

export const runtimeConstraints = (program: ConstraintProgramEntry[]): RuntimeProgramConstraint[] => program.flatMap((entry) => entry.runtime ? [{ key: entry.key, ...entry.runtime }] : []);
const comparisonConstraints = (policy: ConstraintPolicyProjection): StrictnessProgramEntry[] => compileConstraintProgram(policy).flatMap((entry) => entry.strictness ? [{ key: entry.key, ...entry.strictness }] : []) as StrictnessProgramEntry[];
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])); return value; }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const clone = <T,>(value: T): T | undefined => value === undefined ? undefined : structuredClone(value);
function unknownProjection(policy: ConstraintPolicyProjection = {}): ConstraintPolicyProjection {
  const copy = clone(policy) || {}; delete copy.enforcement; delete copy.diff_rules; delete copy.size_rules; delete copy.cochange_rules; delete copy.document_relations; delete copy.evidence_bindings;
  if (copy.paths) { for (const field of ["forbidden", "governance_paths", "operational_paths", "canonical_docs"]) delete copy.paths[field as keyof PathsProjection]; if (!Object.keys(copy.paths).length) delete copy.paths; }
  if (copy.integration) {
    delete copy.integration.workflows;
    if (copy.integration.docs) copy.integration.docs = copy.integration.docs.map((doc) => { const unknownDoc = { ...doc }; delete unknownDoc.must_reference_files; return unknownDoc; });
    if (!Object.keys(copy.integration).length) delete copy.integration;
  }
  return copy;
}
const relaxation = (entry: StrictnessProgramEntry, before: unknown, after: unknown = null, kind = entry.weakenKind as string, message: string | null = null, extra: Record<string, unknown> = {}): PolicyRelaxation => ({
  kind, ...(entry.rule_id ? { rule_id: entry.rule_id } : {}), ...(entry.field ? { field: entry.field } : {}), ...(entry.workflow_id ? { workflow_id: entry.workflow_id } : {}), ...(entry.integration_doc_id ? { integration_doc_id: entry.integration_doc_id } : {}), ...(entry.evidence_binding_id ? { evidence_binding_id: entry.evidence_binding_id } : {}), pointer: entry.pointer, before, after,
  message: message || entry.message?.(before as string | number, after as string | number) || entry.removeMessage, ...extra,
});
const incomparable = (entry: StrictnessProgramEntry, before: unknown, after: unknown): PolicyIncomparableChange => ({ kind: "policy_incomparable", pointer: entry.pointer, before, after, message: entry.incomparableMessage || `policy constraint ${entry.key} changed with no proven monotonic ordering` });

export function compareConstraintPrograms(basePolicy: ConstraintPolicyProjection | null | undefined, headPolicy: ConstraintPolicyProjection | null | undefined): ConstraintProgramComparison {
  if (!basePolicy || !headPolicy) return { relation: "equal", relaxations: [], incomparable: [] };
  const base = comparisonConstraints(basePolicy), head = new Map(comparisonConstraints(headPolicy).map((item) => [item.key, item]));
  const relaxations: PolicyRelaxation[] = [], incomparableChanges: PolicyIncomparableChange[] = [], removedOwners = new Set<string>(); let tightened = false, changed = false;
  for (const entry of base) {
    if (entry.owner && removedOwners.has(entry.owner)) continue;
    const next = head.get(entry.key);
    if (!next) { if (entry.removeKind) { relaxations.push(relaxation(entry, entry.removeBefore ?? entry.raw ?? entry.value, entry.removeAfter ?? null, entry.removeKind, entry.removeMessage)); changed = true; if (entry.relation === "required_entity") removedOwners.add(entry.key); } continue; }
    if (entry.relation === "lower_stricter" || entry.relation === "higher_stricter") {
      const weaker = entry.relation === "lower_stricter" ? next.value as number > entry.value : next.value as number < entry.value;
      const stricter = entry.relation === "lower_stricter" ? next.value as number < entry.value : next.value as number > entry.value;
      if (weaker) relaxations.push(relaxation(entry, entry.raw ?? entry.value, next.raw ?? next.value)); tightened ||= stricter; changed ||= next.value !== entry.value;
    } else if (["superset_stricter", "subset_stricter"].includes(entry.relation)) {
      const before = new Set(entry.value as Array<string | number>), after = new Set(next.value as Array<string | number>), removed = (entry.value as Array<string | number>).filter((item) => !after.has(item)), added = (next.value as Array<string | number>).filter((item) => !before.has(item));
      const weaker = entry.relation === "superset_stricter" ? removed : added;
      for (const item of weaker) relaxations.push(relaxation(entry, item, null, entry.weakenKind, entry.message!(item), { [entry.itemField!]: item }));
      tightened ||= (entry.relation === "superset_stricter" ? added : removed).length > 0; changed ||= removed.length > 0 || added.length > 0;
    } else if (entry.relation === "equal_or_incomparable" && !same(entry.value, next.value)) { incomparableChanges.push(incomparable(entry, entry.value, next.value)); changed = true; }
  }
  const baseKeys = new Set(base.map((entry) => entry.key));
  for (const item of head.values()) if (!baseKeys.has(item.key)) {
    changed = true;
    if (["required_entity", "lower_stricter", "higher_stricter"].includes(item.relation)) tightened = true;
    else if (item.relation === "subset_stricter" && (item as SetStrictness).value.length) for (const added of (item as SetStrictness).value) incomparableChanges.push(incomparable(item, [], [added]));
    else if (item.relation === "equal_or_incomparable" && !item.owner) incomparableChanges.push(incomparable(item, null, item.value));
  }
  const beforeUnknown = unknownProjection(basePolicy), afterUnknown = unknownProjection(headPolicy);
  if (!same(beforeUnknown, afterUnknown)) { incomparableChanges.push({ kind: "policy_incomparable", pointer: "/", before: beforeUnknown, after: afterUnknown, message: "policy sections outside the Constraint Program changed and require explicit governance review" }); changed = true; }
  const relation: ComparisonRelation = relaxations.length ? "weaker" : incomparableChanges.length ? "incomparable" : tightened || changed ? "stricter" : "equal";
  return { relation, relaxations, incomparable: incomparableChanges };
}
