type EnforcementMode = "advisory" | "blocking";
type CountMode = "changed_only" | "all_tracked";
type RankRelation = "lower_stricter" | "higher_stricter";
type SetRelation = "superset_stricter" | "subset_stricter";
type StrictnessRelation = RankRelation | SetRelation | "equal_or_incomparable" | "required_entity";
type ComparisonRelation = "equal" | "weaker" | "incomparable" | "stricter";
type DiagnosticValue = string | number | boolean | null | undefined;

interface StrictnessMetadata {
  owner?: string;
  pointer?: string;
  weakenKind?: string;
  removeKind?: string;
  itemField?: string;
  field?: string;
  rule_id?: string;
  workflow_id?: string;
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

interface DiffRulesProjection {
  max_new_docs?: number;
  max_new_files?: number;
  max_net_added_lines?: number;
}

interface PathsProjection {
  forbidden?: unknown;
  governance_paths?: unknown;
  operational_paths?: unknown;
  canonical_docs?: unknown;
  [key: string]: unknown;
}

interface SizeRuleProjection {
  id: string;
  glob?: unknown;
  max?: number;
  scope?: unknown;
  metric?: unknown;
  applies_to_change_types?: unknown;
  level?: EnforcementMode;
  count?: CountMode;
  ignore?: unknown;
  max_growth?: number;
}

interface IntegrationWorkflowProjection {
  id: string;
  kind?: unknown;
  path?: unknown;
  role?: unknown;
  profiles?: unknown;
  expect?: ({ enforcement?: EnforcementMode } & Record<string, unknown>);
}

interface IntegrationProjection extends Record<string, unknown> {
  workflows?: IntegrationWorkflowProjection[];
}

interface CochangeRuleProjection extends Record<string, unknown> {
  if_changed?: unknown;
  must_change_any?: unknown;
}

export interface ConstraintPolicyProjection extends Record<string, unknown> {
  diff_rules?: DiffRulesProjection;
  paths?: PathsProjection;
  enforcement?: { mode?: EnforcementMode };
  size_rules?: SizeRuleProjection[];
  integration?: IntegrationProjection;
  registry_rules?: unknown[];
  trace_rules?: unknown[];
  change_profiles?: unknown;
  cochange_rules?: CochangeRuleProjection[];
}

interface ChangeIntentProjection {
  budgets?: DiffRulesProjection;
  surface_debt?: unknown;
  scope?: unknown;
  must_touch?: unknown;
  must_not_touch?: unknown;
}

export interface PolicyRelaxation {
  kind: string;
  pointer?: string;
  before: unknown;
  after: unknown;
  message?: string;
  rule_id?: string;
  field?: string;
  workflow_id?: string;
  [key: string]: unknown;
}

export interface PolicyIncomparableChange {
  kind: "policy_incomparable";
  pointer?: string;
  before: unknown;
  after: unknown;
  message: string;
}

export interface ConstraintProgramComparison {
  relation: ComparisonRelation;
  relaxations: PolicyRelaxation[];
  incomparable: PolicyIncomparableChange[];
}

const RANKS = {
  enforcement: { advisory: 0, blocking: 1 },
  count: { changed_only: 0, all_tracked: 1 },
};
const array = <T,>(value: T[] | null | undefined): T[] => Array.isArray(value) ? value : [];
const compare = (relation: StrictnessRelation, value: unknown, metadata: StrictnessMetadata = {}) => ({ relation, value, ...metadata });
const scalar = (relation: RankRelation, value: number, metadata: StrictnessMetadata): RankStrictness => compare(relation, value, metadata) as RankStrictness;
const set = (relation: SetRelation, value: unknown, metadata: StrictnessMetadata): SetStrictness => compare(relation, array(value as Array<string | number> | undefined), metadata) as SetStrictness;
const exact = (value: unknown, metadata: StrictnessMetadata): ExactStrictness => compare("equal_or_incomparable", value, metadata) as ExactStrictness;
const entity = (metadata: StrictnessMetadata): EntityStrictness => compare("required_entity", true, metadata) as EntityStrictness;

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

  if (array(policy.size_rules).length) add("runtime:size-rules", { kind: "size_rules", name: "size-rules", rules: policy.size_rules });
  if (array(policy.registry_rules).length) add("runtime:registry-rules", { kind: "registry_rules", name: "registry-rules", rules: policy.registry_rules });
  if (array(policy.trace_rules).length) add("runtime:trace-rules", { kind: "trace_rules", name: "trace-rules" });
  if (policy.change_profiles) add("runtime:change-profile", { kind: "change_profile", name: "change-profiles" });
  if (policy.integration) add("runtime:integration", { kind: "integration", name: "integration" });
  add("surface-debt", { kind: "surface_debt", name: "surface-debt", debt: changeIntent?.surface_debt });
  array(policy.cochange_rules).forEach((rule, index) => add(`cochange:${index}`, { kind: "implies_nonempty", name: "cochange", ...rule }));
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
  const copy = clone(policy) || {}; delete copy.enforcement; delete copy.diff_rules; delete copy.size_rules;
  if (copy.paths) { for (const field of ["forbidden", "governance_paths", "operational_paths", "canonical_docs"]) delete copy.paths[field]; if (!Object.keys(copy.paths).length) delete copy.paths; }
  if (copy.integration) { delete copy.integration.workflows; if (!Object.keys(copy.integration).length) delete copy.integration; }
  return copy;
}
const relaxation = (entry: StrictnessProgramEntry, before: unknown, after: unknown = null, kind = entry.weakenKind as string, message: string | null = null, extra: Record<string, unknown> = {}): PolicyRelaxation => ({
  kind, ...(entry.rule_id ? { rule_id: entry.rule_id } : {}), ...(entry.field ? { field: entry.field } : {}), ...(entry.workflow_id ? { workflow_id: entry.workflow_id } : {}), pointer: entry.pointer, before, after,
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
