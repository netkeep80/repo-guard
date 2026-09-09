import {
  normalizeDocumentFact,
  type DiffFactSelector,
  type DocumentFactType,
  type FactFormat,
  type FactRef,
  type RepositoryFactSelector,
} from "../document-facts.mjs";
import { relationDescriptor, relationDescriptorForSetComparison, type RelationDocumentTarget } from "./relation-kernel.mjs";

type EnforcementMode = "advisory" | "blocking";
type CountMode = "changed_only" | "all_tracked";
type RankRelation = "lower_stricter" | "higher_stricter";
type SetRelation = "superset_stricter" | "subset_stricter";
type StrictnessRelation = RankRelation | SetRelation | "equal_or_incomparable" | "required_entity";
type ComparisonRelation = "equal" | "weaker" | "incomparable" | "stricter";
type RuntimePhase = "transaction" | "state" | "both";
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
interface CochangeGroupProjection { id?: unknown; members?: unknown; }
interface DocumentDefinitionProjection { path?: unknown; format?: unknown; snapshot?: unknown; }
interface DocumentSelectorProjection { document?: unknown; pointer?: unknown; projection?: unknown; type?: unknown; }
interface DocumentRelationRuleProjection { id?: unknown; kind?: unknown; [key: string]: unknown; }
interface DocumentRelationsProjection { documents?: Record<string, DocumentDefinitionProjection>; rules?: DocumentRelationRuleProjection[]; }
interface EvidenceBindingProjection {
  id?: unknown;
  kind?: unknown;
  source?: DocumentSelectorProjection;
  target_anchor_type?: unknown;
}
interface TraceRuleProjection {
  id?: unknown;
  kind?: unknown;
  from_anchor_type?: unknown;
  to_anchor_type?: unknown;
  if_changed?: unknown;
  must_touch_any?: unknown;
  change_intent_field?: unknown;
}

export interface ConstraintPolicyProjection {
  diff_rules?: DiffRulesProjection;
  paths?: PathsProjection;
  enforcement?: { mode?: EnforcementMode };
  size_rules?: SizeRuleProjection[];
  integration?: IntegrationProjection;
  trace_rules?: TraceRuleProjection[];
  surfaces?: Record<string, unknown>;
  new_file_classes?: Record<string, unknown>;
  change_profiles?: Record<string, unknown>;
  cochange_rules?: CochangeRuleProjection[];
  cochange_groups?: CochangeGroupProjection[];
  document_relations?: DocumentRelationsProjection;
  evidence_bindings?: EvidenceBindingProjection[];
}

interface ChangeIntentProjection {
  change_type?: string;
  budgets?: DiffRulesProjection;
  scope?: unknown;
  must_touch?: unknown;
  must_not_touch?: unknown;
  anchors?: unknown;
}

interface ConstraintProgramOptions {
  emitRuntime?: boolean;
}

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
const array = <T,>(value: T[] | null | undefined): T[] => Array.isArray(value) ? value : [];
const compare = (relation: StrictnessRelation, value: unknown, metadata: StrictnessMetadata = {}) => ({ relation, value, ...metadata });
const scalar = (relation: RankRelation, value: number, metadata: StrictnessMetadata): RankStrictness => compare(relation, value, metadata) as RankStrictness;
const set = (relation: SetRelation, value: unknown, metadata: StrictnessMetadata): SetStrictness => compare(relation, array(value as Array<string | number> | undefined), metadata) as SetStrictness;
const exact = (value: unknown, metadata: StrictnessMetadata): ExactStrictness => compare("equal_or_incomparable", value, metadata) as ExactStrictness;
const entity = (metadata: StrictnessMetadata): EntityStrictness => compare("required_entity", true, metadata) as EntityStrictness;
const leftSubsetPrimitive = relationDescriptorForSetComparison("left_subset").kind;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function canonicalDocumentPath(value: unknown): string {
  try { return normalizeDocumentFact(value, "repository_path") as string; }
  catch { return typeof value === "string" ? value : String(value ?? ""); }
}
function compileFactRef(selectorValue: unknown, documents: Record<string, DocumentDefinitionProjection>): FactRef {
  const selector = object(selectorValue), name = typeof selector.document === "string" ? selector.document : "", definition = documents[name] || {};
  const snapshot = definition.snapshot === "base" || definition.snapshot === "head" ? definition.snapshot : "state";
  const documentSelector: Extract<FactRef, { source: "document" }>["selector"] = {
    path: canonicalDocumentPath(definition.path),
    format: definition.format as FactFormat,
    snapshot,
    pointer: typeof selector.pointer === "string" ? selector.pointer : "",
    projection: selector.projection as Extract<FactRef, { source: "document" }>["selector"]["projection"],
  };
  return { source: "document", selector: documentSelector, type: selector.type as DocumentFactType };
}
function diffFact(type: DocumentFactType, selector: DiffFactSelector): FactRef {
  return { source: "diff", selector, type };
}
function repositoryAnchorFact(anchorType: unknown): FactRef {
  return { source: "repository", selector: { kind: "anchor_values", anchor_type: String(anchorType ?? "") }, type: "string_set" };
}
function repositoryPathMetricFact(selector: Extract<RepositoryFactSelector, { kind: "path_metric" }>): FactRef {
  return { source: "repository", selector, type: "scalar" };
}
function pointerFromDottedField(value: unknown): string {
  const parts = String(value ?? "").split(".").filter(Boolean);
  return parts.length ? `/${parts.map((part) => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}` : "";
}
function changeIntentFact(type: DocumentFactType, field: unknown): FactRef {
  return { source: "change_intent", selector: { pointer: pointerFromDottedField(field), projection: "array_items" }, type };
}
function compileDocumentTarget(documentValue: unknown, documents: Record<string, DocumentDefinitionProjection>): RelationDocumentTarget {
  const document = typeof documentValue === "string" ? documentValue : "", definition = documents[document] || {};
  return { document, path: canonicalDocumentPath(definition.path), format: definition.format as FactFormat };
}
function primitiveRuntime(
  name: string,
  relationId: string,
  primitive: string,
  operands: Record<string, FactRef | RelationDocumentTarget>,
  parameters: Record<string, unknown> = {},
  phase?: RuntimePhase,
  advisory = false,
): RuntimeConstraint {
  return { kind: "primitive_relation", name, relation_id: relationId, primitive, operands, parameters, ...(phase ? { phase } : {}), ...(advisory ? { advisory: true } : {}) };
}
function strings(value: unknown): string[] {
  return array(value as string[] | undefined).map(String);
}
function selectedSizeRule(rule: SizeRuleProjection, changeIntent: ChangeIntentProjection | null): boolean {
  if (!Array.isArray(rule.applies_to_change_types)) return true;
  return (rule.applies_to_change_types as Array<string | null>).includes(changeIntent?.change_type ?? null);
}
function sizeRuleExclusions(policy: ConstraintPolicyProjection, rule: SizeRuleProjection): string[] {
  return [...new Set([...strings(policy.paths?.operational_paths), ...strings(rule.ignore)])];
}
function addSizeRuleRuntime(
  add: (key: string, runtime?: RuntimeConstraint | null, strictness?: StrictnessConstraint | null) => void,
  policy: ConstraintPolicyProjection,
  rule: SizeRuleProjection,
  changeIntent: ChangeIntentProjection | null,
): void {
  if (!selectedSizeRule(rule, changeIntent)) return;
  const id = String(rule.id), scope = String(rule.scope ?? ""), metric = String(rule.metric ?? ""), glob = String(rule.glob ?? "**");
  const count = rule.count || "all_tracked", advisory = rule.level === "advisory", excludePaths = sizeRuleExclusions(policy, rule);
  if (typeof rule.max !== "number") throw new Error(`size rule "${id}" requires max`);
  if (scope === "file") {
    if (metric !== "lines" && metric !== "bytes") throw new Error(`size rule "${id}" file scope supports only lines or bytes`);
    if (rule.max_growth !== undefined) throw new Error(`size rule "${id}" file scope does not support max_growth`);
    const phase: RuntimePhase = count === "changed_only" || Array.isArray(rule.applies_to_change_types) ? "transaction" : "state";
    const relationId = `size:${id}:max`;
    add(relationId, primitiveRuntime(relationId, relationId, "numeric_bound", {
      source: repositoryPathMetricFact({ kind: "path_metric", patterns: [glob], exclude_paths: excludePaths, population: count === "changed_only" ? "changed" : "tracked", metric, aggregate: "max" }),
    }, { max: rule.max }, phase, advisory));
    return;
  }
  if (scope !== "directory") throw new Error(`size rule "${id}" has unsupported scope "${scope}"`);
  if (count === "changed_only") throw new Error(`size rule "${id}" directory scope does not support count=changed_only`);
  if (metric !== "lines" && metric !== "bytes" && metric !== "files") throw new Error(`size rule "${id}" has unsupported metric "${metric}"`);
  const absolutePhase: RuntimePhase = Array.isArray(rule.applies_to_change_types) ? "transaction" : "state";
  const absoluteId = `size:${id}:max`;
  add(absoluteId, primitiveRuntime(absoluteId, absoluteId, "numeric_bound", {
    source: repositoryPathMetricFact({ kind: "path_metric", patterns: [glob], exclude_paths: excludePaths, population: "tracked", metric, aggregate: "sum" }),
  }, { max: rule.max }, absolutePhase, advisory));
  if (rule.max_growth === undefined) return;
  if (metric === "bytes") throw new Error(`size rule "${id}" directory bytes do not support max_growth`);
  const growthId = `size:${id}:max-growth`;
  add(growthId, primitiveRuntime(growthId, growthId, "numeric_bound", {
    source: diffFact("scalar", {
      kind: "metric",
      metric: metric === "files" ? "net_files" : "net_added_lines",
      patterns: [glob],
      exclude_paths: excludePaths,
    }),
  }, { max: rule.max_growth }, "transaction", advisory));
}

export function compileConstraintProgram(
  policy: ConstraintPolicyProjection = {},
  changeIntent: ChangeIntentProjection | null = null,
  options: ConstraintProgramOptions = {},
): ConstraintProgramEntry[] {
  const emitRuntime = options.emitRuntime !== false;
  const program: ConstraintProgramEntry[] = [], diff = policy.diff_rules || {}, budgets = changeIntent?.budgets || {};
  const add = (key: string, runtime: RuntimeConstraint | null = null, strictness: StrictnessConstraint | null = null) => program.push({ key, runtime: emitRuntime ? runtime : null, strictness });

  const forbidden = strings(policy.paths?.forbidden);
  add("paths:forbidden", primitiveRuntime("forbidden-paths", "paths:forbidden", "numeric_bound", {
    source: diffFact("repository_path_set", { kind: "changed_paths", patterns: forbidden, exclude_statuses: ["deleted"] }),
  }, { max: 0 }),
  set("superset_stricter", policy.paths?.forbidden, { pointer: "/paths/forbidden", weakenKind: "forbidden_path_removed", itemField: "pattern", message: (item) => `paths.forbidden removed: ${item}` }));

  for (const [field, metric, name] of [
    ["max_new_docs", "new_docs", "canonical-docs-budget"], ["max_new_files", "new_files", "max-new-files"], ["max_net_added_lines", "net_added_lines", "max-net-added-lines"],
  ] as const) {
    const value = diff[field], effective = budgets[field] ?? value;
    const runtime = effective === undefined ? null : primitiveRuntime(name, `diff:${field}`, "numeric_bound", {
      source: diffFact("scalar", {
        kind: "metric",
        metric,
        ...(metric === "new_docs" ? { exclude_paths: strings(policy.paths?.canonical_docs) } : {}),
      }),
    }, { max: effective });
    add(`diff:${field}`, runtime, typeof value === "number" ? scalar("lower_stricter", value, {
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
    if (emitRuntime) addSizeRuleRuntime(add, policy, rule, changeIntent);
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
    const descriptor = relationDescriptor(String(rule.kind ?? ""));
    if (!descriptor.public) throw new Error(`document relation "${String(rule.kind ?? "")}" is internal`);
    const identity = descriptor.identity.map((field) => String(rule[field] ?? "")).join(":");
    const id = String(rule.id ?? ""), owner = `document-relation:${identity}`, pointer = `/document_relations/rules/${id}`;
    const documentOperands = new Set(descriptor.documentOperands || []);
    const operands: Record<string, FactRef | RelationDocumentTarget> = {};
    for (const role of descriptor.operands) {
      operands[role] = documentOperands.has(role)
        ? compileDocumentTarget(rule[role], documents)
        : compileFactRef(rule[role], documents);
    }
    const omitted = new Set(["id", "kind", ...descriptor.operands]);
    const parameters = Object.fromEntries(Object.entries(rule).filter(([field, value]) => !omitted.has(field) && value !== undefined));
    const shape = { kind: descriptor.kind, operands, parameters };
    const runtime = primitiveRuntime(owner, id, descriptor.kind, operands, parameters);
    add(owner, runtime, entity({ owner, pointer, removeKind: "document_relation_removed", rule_id: id,
      removeBefore: shape, removeAfter: { present: false }, removeMessage: `document_relations rule "${id}" removed` }));
    if (descriptor.strictness === "incomparable") {
      add(`${owner}:shape`, null, exact(shape, { owner, pointer, rule_id: id, incomparableMessage: `document_relations rule "${id}" changed semantics` }));
    }
  }

  for (const binding of array(policy.evidence_bindings)) {
    const id = String(binding.id ?? ""), owner = `evidence-binding:${id}`, pointer = `/evidence_bindings/${id}`;
    const source = compileFactRef(binding.source, documents);
    const shape = { kind: binding.kind, source, target_anchor_type: binding.target_anchor_type };
    const runtime = binding.kind === "anchor_value_coverage"
      ? primitiveRuntime(owner, `evidence:${id}`, leftSubsetPrimitive, {
        left: source,
        right: repositoryAnchorFact(binding.target_anchor_type),
      })
      : null;
    add(owner, runtime, entity({ owner, pointer, removeKind: "evidence_binding_removed", evidence_binding_id: id,
      removeBefore: shape, removeAfter: { present: false }, removeMessage: `evidence binding "${id}" removed` }));
    add(`${owner}:shape`, null, exact(shape, { owner, pointer, evidence_binding_id: id, incomparableMessage: `evidence binding "${id}" changed semantics` }));
  }

  for (const rule of array(policy.trace_rules)) {
    const id = String(rule.id ?? ""), relationId = `trace:${id}`, name = `trace-rule: ${id}`;
    if (rule.kind === "must_resolve") {
      add(relationId, primitiveRuntime(name, relationId, leftSubsetPrimitive, {
        left: repositoryAnchorFact(rule.from_anchor_type),
        right: repositoryAnchorFact(rule.to_anchor_type),
      }, {}, "transaction"));
    } else if (rule.kind === "changed_files_require_evidence") {
      add(relationId, primitiveRuntime(name, relationId, "set_presence_implies", {
        left: diffFact("repository_path_set", { kind: "changed_paths", patterns: strings(rule.if_changed) }),
        right: diffFact("repository_path_set", { kind: "changed_paths", patterns: strings(rule.must_touch_any) }),
      }));
    } else if (rule.kind === "declared_anchors_require_evidence") {
      add(relationId, primitiveRuntime(name, relationId, "set_presence_implies", {
        left: changeIntentFact("string_set", rule.change_intent_field),
        right: diffFact("repository_path_set", { kind: "changed_paths", patterns: strings(rule.must_touch_any) }),
      }));
    }
  }

  const changeType = changeIntent?.change_type, profiles = object(policy.change_profiles);
  if (changeType && changeType !== "governance" && Object.hasOwn(profiles, changeType)) {
    const profile = object(profiles[changeType]);
    const surfaceEntries = Object.entries(object(policy.surfaces)).map(([name, patterns]) => [name, strings(patterns)] as const);
    const classEntries = Object.entries(object(policy.new_file_classes)).map(([name, patterns]) => [name, strings(patterns)] as const);
    const addPathBound = (suffix: string, patterns: string[], parameters: Record<string, unknown>, options: { outside?: boolean; addedOnly?: boolean } = {}) => {
      const relationId = `change-profile:${changeType}:${suffix}`;
      add(relationId, primitiveRuntime(`change-profile: ${changeType} ${suffix}`, relationId, "numeric_bound", {
        source: diffFact("repository_path_set", {
          kind: "changed_paths",
          patterns,
          ...(options.outside ? { mode: "outside" as const } : {}),
          ...(options.addedOnly ? { exclude_statuses: ["modified", "deleted"] as const } : {}),
        }),
      }, parameters, "transaction"));
    };
    const addMetricBound = (suffix: string, metric: "new_docs" | "new_files" | "net_added_lines", max: number, excludePaths: string[] = []) => {
      const relationId = `change-profile:${changeType}:${suffix}`;
      add(relationId, primitiveRuntime(`change-profile: ${changeType} ${suffix}`, relationId, "numeric_bound", {
        source: diffFact("scalar", { kind: "metric", metric, ...(excludePaths.length ? { exclude_paths: excludePaths } : {}) }),
      }, { max }, "transaction"));
    };

    const allowedSurfaces = strings(profile.allow_surfaces), forbiddenSurfaces = strings(profile.forbid_surfaces), requiredSurfaces = strings(profile.require_surfaces);
    const surfacesByName = new Map(surfaceEntries), surfaceForbids = new Set(forbiddenSurfaces);
    for (const name of requiredSurfaces) addPathBound(`surface-required:${name}`, surfacesByName.get(name) || [], { min: 1 });
    if (allowedSurfaces.length) {
      const allowed = new Set(allowedSurfaces);
      for (const [name] of surfaceEntries) if (!allowed.has(name)) surfaceForbids.add(name);
    }
    for (const name of surfaceForbids) addPathBound(`surface-forbidden:${name}`, surfacesByName.get(name) || [], { max: 0 });
    if ((allowedSurfaces.length || forbiddenSurfaces.length || requiredSurfaces.length) && profile.allow_unclassified_surfaces !== true) {
      addPathBound("surface-unclassified", surfaceEntries.flatMap(([, patterns]) => patterns), { max: 0 }, { outside: true });
    }

    if (profile.new_files !== undefined) {
      const newFiles = object(profile.new_files), allowedClasses = new Set(strings(newFiles.allow_classes)), classesByName = new Map(classEntries);
      for (const [name, patterns] of classEntries) if (!allowedClasses.has(name)) addPathBound(`new-class-forbidden:${name}`, patterns, { max: 0 }, { addedOnly: true });
      addPathBound("new-class-unclassified", classEntries.flatMap(([, patterns]) => patterns), { max: 0 }, { outside: true, addedOnly: true });
      for (const [name, limit] of Object.entries(object(newFiles.max_per_class))) if (typeof limit === "number") {
        addPathBound(`new-class-max:${name}`, classesByName.get(name) || [], { max: limit }, { addedOnly: true });
      }
      if (typeof newFiles.max_new_files === "number") addMetricBound("new-files-max", "new_files", newFiles.max_new_files);
    }

    const profileBudgets = object(profile.budgets);
    if (typeof profileBudgets.max_new_docs === "number") addMetricBound("budget:max-new-docs", "new_docs", profileBudgets.max_new_docs, strings(policy.paths?.canonical_docs));
    if (typeof profileBudgets.max_new_files === "number") addMetricBound("budget:max-new-files", "new_files", profileBudgets.max_new_files);
    if (typeof profileBudgets.max_net_added_lines === "number") addMetricBound("budget:max-net-added-lines", "net_added_lines", profileBudgets.max_net_added_lines);
  }

  if (policy.integration) add("runtime:integration", { kind: "integration", name: "integration" });

  for (const group of array(policy.cochange_groups)) {
    const id = String(group.id ?? ""), owner = `cochange-group:${id}`, pointer = `/cochange_groups/${id}`;
    const members = strings(group.members).map(canonicalDocumentPath).sort();
    add(owner, primitiveRuntime(owner, owner, "set_all_or_none", {
      source: diffFact("repository_path_set", { kind: "changed_paths", patterns: members }),
    }, { universe: members, group_id: id }), entity({
      owner, pointer, removeKind: "cochange_group_removed", removeBefore: { id, members }, removeAfter: { present: false }, removeMessage: `cochange group "${id}" removed`,
    }));
    add(`${owner}:shape`, null, exact({ members }, { owner, pointer, incomparableMessage: `cochange group "${id}" changed members` }));
  }

  array(policy.cochange_rules).forEach((rule, index) => {
    const pointer = `/cochange_rules/${index}`, owner = `cochange-policy:${index}`;
    const changed = strings(rule.if_changed), required = strings(rule.must_change_any);
    add(`cochange:${index}`, primitiveRuntime(
      `cochange: ${changed.join(",")} -> ${required.join(",")}`,
      `cochange:${index}`,
      "set_presence_implies",
      {
        left: diffFact("repository_path_set", { kind: "changed_paths", patterns: changed }),
        right: diffFact("repository_path_set", { kind: "changed_paths", patterns: required }),
      },
    ));
    add(owner, null, entity({ owner, pointer, removeKind: "cochange_rule_removed", removeBefore: rule, removeAfter: { present: false }, removeMessage: `cochange_rules[${index}] removed` }));
    add(`${owner}:shape`, null, exact(rule, { owner, pointer, incomparableMessage: `cochange_rules[${index}] changed semantics` }));
  });

  if (changeIntent) {
    const scope = strings(changeIntent.scope), mustTouch = strings(changeIntent.must_touch), mustNotTouch = strings(changeIntent.must_not_touch);
    if (scope.length) add("change-intent:scope", primitiveRuntime("change-intent-scope", "change-intent:scope", "numeric_bound", {
      source: diffFact("repository_path_set", { kind: "changed_paths", patterns: scope, mode: "outside" }),
    }, { max: 0 }));
    if (mustTouch.length) add("change-intent:must-touch", primitiveRuntime("must-touch", "change-intent:must-touch", "numeric_bound", {
      source: diffFact("repository_path_set", { kind: "changed_paths", patterns: mustTouch }),
    }, { min: 1 }));
    if (mustNotTouch.length) add("change-intent:must-not-touch", primitiveRuntime("must-not-touch", "change-intent:must-not-touch", "numeric_bound", {
      source: diffFact("repository_path_set", { kind: "changed_paths", patterns: mustNotTouch }),
    }, { max: 0 }));
  }
  return program;
}

export const runtimeConstraints = (program: ConstraintProgramEntry[]): RuntimeProgramConstraint[] => program.flatMap((entry) => entry.runtime ? [{ key: entry.key, ...entry.runtime }] : []);
const comparisonConstraints = (policy: ConstraintPolicyProjection): StrictnessProgramEntry[] => compileConstraintProgram(policy, null, { emitRuntime: false }).flatMap((entry) => entry.strictness ? [{ key: entry.key, ...entry.strictness }] : []) as StrictnessProgramEntry[];
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])); return value; }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const clone = <T,>(value: T): T | undefined => value === undefined ? undefined : structuredClone(value);
function unknownProjection(policy: ConstraintPolicyProjection = {}): ConstraintPolicyProjection {
  const copy = clone(policy) || {}; delete copy.enforcement; delete copy.diff_rules; delete copy.size_rules; delete copy.cochange_rules; delete copy.cochange_groups; delete copy.document_relations; delete copy.evidence_bindings;
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
