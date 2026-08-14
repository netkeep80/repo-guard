import { normalizeDocumentFact } from "./document-facts.mjs";

type LooseObject = Record<string, unknown>;
type SemanticDiagnostic = { message: string } & LooseObject;
type IntegrationSection = "workflows" | "templates" | "docs" | "profiles";

interface ContentRuleProjection {
  id?: unknown;
  forbid_regex?: unknown;
}
interface AnchorSourceProjection {
  kind?: unknown;
  pattern: string;
}
interface AnchorTypeProjection {
  sources?: unknown;
}
interface TraceRuleProjection extends LooseObject {
  id?: unknown;
  kind?: unknown;
  change_intent_field?: unknown;
}
interface IntegrationProjection extends LooseObject {
  workflows?: unknown;
  templates?: unknown;
  docs?: unknown;
  profiles?: unknown;
}
interface PolicyProjection {
  change_profiles?: unknown;
  surfaces?: unknown;
  new_file_classes?: unknown;
  anchors?: { types?: unknown };
  trace_rules?: unknown;
  integration?: unknown;
  paths?: { public_api?: unknown };
  content_rules?: unknown;
  document_relations?: unknown;
  evidence_bindings?: unknown;
}
interface IntegrationReference {
  section: IntegrationSection;
  index: number;
  field: "profiles" | "must_mention_profiles";
  profileId: unknown;
}

const list = <T = unknown,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const object = (value: unknown): LooseObject => value && typeof value === "object" && !Array.isArray(value) ? value as LooseObject : {};

export function compileForbidRegex(contentRules: unknown = []): SemanticDiagnostic[] {
  const errors: SemanticDiagnostic[] = [];
  for (const rule of list<ContentRuleProjection>(contentRules)) for (const pattern of list<string>(rule?.forbid_regex)) {
    try { new RegExp(pattern); }
    catch (error) { errors.push({ rule_id: rule?.id, pattern, message: (error as Error).message }); }
  }
  return errors;
}

export function compileChangeProfiles(policy: PolicyProjection = {}): SemanticDiagnostic[] {
  const errors: SemanticDiagnostic[] = [], profiles = object(policy.change_profiles);
  const surfaces = new Set<unknown>(Object.keys(object(policy.surfaces)));
  const classes = new Set<unknown>(Object.keys(object(policy.new_file_classes)));
  for (const [changeType, profile] of Object.entries(profiles)) {
    const p = object(profile), allowed = new Set<unknown>(list(p.allow_surfaces));
    for (const field of ["allow_surfaces", "forbid_surfaces", "require_surfaces"] as const) for (const surface of list(p[field])) {
      if (!surfaces.has(surface)) errors.push({ change_type: changeType, surface, message: `change_profiles["${changeType}"].${field} references unknown surface "${surface}"` });
    }
    for (const surface of list(p.forbid_surfaces)) if (allowed.has(surface)) errors.push({ change_type: changeType, surface, message: `change_profiles["${changeType}"] lists surface "${surface}" in both allow_surfaces and forbid_surfaces` });
    const newFiles = object(p.new_files);
    for (const fileClass of [...list(newFiles.allow_classes), ...Object.keys(object(newFiles.max_per_class))]) if (!classes.has(fileClass)) {
      errors.push({ change_type: changeType, class: fileClass, message: `change_profiles["${changeType}"].new_files references unknown class "${fileClass}"` });
    }
  }
  return errors;
}

export function compileAnchorPolicy(policy: PolicyProjection = {}): SemanticDiagnostic[] {
  const errors: SemanticDiagnostic[] = [], types = object(policy.anchors?.types), typeNames = new Set<unknown>(Object.keys(types)), ids = new Set<unknown>();
  for (const [anchorType, config] of Object.entries(types)) for (const [sourceIndex, source] of list<AnchorSourceProjection>((config as AnchorTypeProjection | null | undefined)?.sources).entries()) {
    if (source?.kind !== "regex") continue;
    try { new RegExp(source.pattern); }
    catch (error) { errors.push({ anchor_type: anchorType, source_index: sourceIndex, pattern: source.pattern, message: `anchors.types["${anchorType}"].sources[${sourceIndex}].pattern is invalid: ${(error as Error).message}` }); }
  }
  for (const [index, rule] of list<TraceRuleProjection>(policy.trace_rules).entries()) {
    if (ids.has(rule?.id)) errors.push({ trace_rule: rule?.id, message: `trace_rules[${index}].id duplicates trace rule "${rule?.id}"` });
    ids.add(rule?.id);
    if (rule?.kind === "must_resolve") for (const field of ["from_anchor_type", "to_anchor_type"] as const) {
      if (!typeNames.has(rule[field])) errors.push({ trace_rule: rule.id, anchor_type: rule[field], message: `trace_rules[${index}].${field} references unknown anchor type "${rule[field]}"` });
    }
    if (rule?.kind === "declared_anchors_require_evidence" && !["anchors.affects", "anchors.implements", "anchors.verifies"].includes(rule.change_intent_field as string)) {
      errors.push({ trace_rule: rule.id, change_intent_field: rule.change_intent_field, message: `trace_rules[${index}].change_intent_field references unsupported ChangeIntent anchor field` });
    }
  }
  return errors;
}

function semanticIntegrationEntries(integration: IntegrationProjection | null | undefined) {
  return (["workflows", "templates", "docs", "profiles"] as const).flatMap((section) => list(integration?.[section]).map((entry, index) => ({ section, index, entry: object(entry) })));
}
export function compileIntegrationPolicy(policy: PolicyProjection = {}): SemanticDiagnostic[] {
  const integration = object(policy.integration);
  if (!policy.integration || !Object.keys(integration).length) return [];
  const errors: SemanticDiagnostic[] = [], seen = new Map<string, { section: IntegrationSection; index: number }>(), profileIds = new Set<unknown>(), references: IntegrationReference[] = [];
  for (const { section, index, entry } of semanticIntegrationEntries(integration as IntegrationProjection)) {
    const id = entry.id;
    if (typeof id === "string" && id) {
      if (seen.has(id)) {
        const previous = seen.get(id)!;
        errors.push({ section, id, index, previous_section: previous.section, previous_index: previous.index, message: `integration.${section}[${index}].id duplicates integration.${previous.section}[${previous.index}].id "${id}"` });
      } else seen.set(id, { section, index });
      if (section === "profiles") profileIds.add(id);
    }
    if (section === "workflows" && entry.role === "ci_gate") {
      const expect = object(entry.expect);
      for (const field of ["action", "mode"] as const) if (expect[field] !== undefined) {
        errors.push({ section, id, index, field, message: `integration.workflows[${index}].expect.${field} is not supported for ci_gate` });
      }
      for (const disallowed of list<string>(expect.disallow)) if (disallowed !== "continue_on_error") {
        errors.push({ section, id, index, field: "disallow", message: `integration.workflows[${index}].expect.disallow value "${disallowed}" is repo-guard-specific and not supported for ci_gate` });
      }
    }
    for (const profileId of list(entry.profiles)) references.push({ section, index, field: "profiles", profileId });
    if (section === "docs") for (const profileId of list(entry.must_mention_profiles)) references.push({ section, index, field: "must_mention_profiles", profileId });
  }
  for (const ref of references) if (!profileIds.has(ref.profileId)) errors.push({ section: ref.section, index: ref.index, field: ref.field, profile_id: ref.profileId, message: `integration.${ref.section}[${ref.index}].${ref.field} references unknown integration.profiles id "${ref.profileId}"` });
  return errors;
}

function scalarLiteralMatches(type: unknown, value: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return type === "scalar" && (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)));
}

function normalizeDeclaredDocumentPath(name: string, definition: LooseObject, errors: SemanticDiagnostic[]): string | null {
  try {
    const path = normalizeDocumentFact(definition.path, "repository_path") as string;
    const format = definition.format;
    const matchesFormat = format === "json" ? /\.json$/i.test(path) : format === "yaml" ? /\.ya?ml$/i.test(path) : false;
    if (!matchesFormat) errors.push({ document: name, path, format, message: `document_relations.documents["${name}"] format "${format}" does not match path "${path}"` });
    return path;
  } catch (error) {
    errors.push({ document: name, path: definition.path, message: `document_relations.documents["${name}"].path is invalid: ${(error as Error).message}` });
    return null;
  }
}

function documentSelectorKey(value: unknown): string {
  const selector = object(value);
  return JSON.stringify({ document: selector.document, pointer: selector.pointer, projection: selector.projection, type: selector.type });
}

export function compileDocumentRelationsPolicy(policy: PolicyProjection = {}): SemanticDiagnostic[] {
  if (!policy.document_relations) return [];
  const section = object(policy.document_relations), documents = object(section.documents), rules = list<LooseObject>(section.rules);
  const errors: SemanticDiagnostic[] = [], seenRuleIds = new Set<unknown>(), usedDocuments = new Set<string>();

  for (const [name, rawDefinition] of Object.entries(documents)) normalizeDeclaredDocumentPath(name, object(rawDefinition), errors);

  const useSelector = (ruleId: unknown, field: string, rawSelector: unknown) => {
    const selector = object(rawSelector), document = selector.document;
    if (typeof document !== "string" || !Object.hasOwn(documents, document)) {
      errors.push({ rule_id: ruleId, field, document, message: `document_relations rule "${ruleId}" ${field} references unknown document "${document}"` });
      return;
    }
    usedDocuments.add(document);
  };

  for (const [index, rule] of rules.entries()) {
    const id = rule.id;
    if (seenRuleIds.has(id)) errors.push({ rule_id: id, index, message: `document_relations.rules[${index}].id duplicates rule "${id}"` });
    seenRuleIds.add(id);
    if (rule.kind === "scalar_equal") {
      useSelector(id, "left", rule.left);
      useSelector(id, "right", rule.right);
    } else if (rule.kind === "scalar_equals_literal") {
      useSelector(id, "source", rule.source);
      const selector = object(rule.source);
      if (!scalarLiteralMatches(selector.type, rule.value)) {
        errors.push({ rule_id: id, type: selector.type, value: rule.value, message: `document_relations rule "${id}" literal is incompatible with source type "${selector.type}"` });
      }
    } else if (rule.kind === "referenced_paths_exist") {
      useSelector(id, "source", rule.source);
    }
  }

  for (const name of Object.keys(documents)) if (!usedDocuments.has(name)) {
    errors.push({ document: name, message: `document_relations.documents["${name}"] is declared but unused` });
  }
  return errors;
}

export function compileEvidenceBindingsPolicy(policy: PolicyProjection = {}): SemanticDiagnostic[] {
  const bindings = list<LooseObject>(policy.evidence_bindings);
  if (!bindings.length) return [];
  const errors: SemanticDiagnostic[] = [], seenIds = new Set<unknown>();
  const relationSection = object(policy.document_relations), documents = object(relationSection.documents), relationRules = list<LooseObject>(relationSection.rules);
  const pathExistenceSelectors = new Set(relationRules.filter((rule) => rule.kind === "referenced_paths_exist").map((rule) => documentSelectorKey(rule.source)));
  const workflows = new Map<string, LooseObject>();
  for (const workflow of list<LooseObject>(object(policy.integration).workflows)) if (typeof workflow.id === "string" && workflow.id) workflows.set(workflow.id, workflow);

  for (const [index, binding] of bindings.entries()) {
    const id = binding.id;
    if (seenIds.has(id)) errors.push({ evidence_binding: id, index, message: `evidence_bindings[${index}].id duplicates binding "${id}"` });
    seenIds.add(id);
    if (binding.kind !== "workflow_path_coverage") continue;

    const source = object(binding.source), document = source.document;
    if (typeof document !== "string" || !Object.hasOwn(documents, document)) {
      errors.push({ evidence_binding: id, document, message: `evidence binding "${id}" source references unknown document "${document}"` });
    }

    const workflowId = binding.workflow;
    const workflow = typeof workflowId === "string" ? workflows.get(workflowId) : undefined;
    if (!workflow) {
      errors.push({ evidence_binding: id, workflow: workflowId, message: `evidence binding "${id}" references unknown integration workflow "${workflowId}"` });
    } else if (object(workflow.expect).enforcement !== "blocking") {
      errors.push({ evidence_binding: id, workflow: workflowId, message: `evidence binding "${id}" requires integration workflow "${workflowId}" to declare expect.enforcement "blocking"` });
    }

    if (!pathExistenceSelectors.has(documentSelectorKey(source))) {
      errors.push({ evidence_binding: id, message: `evidence binding "${id}" requires an equivalent referenced_paths_exist relation for the same source selector` });
    }
  }
  return errors;
}

export function warnReservedPolicyFields(policy: PolicyProjection = {}): string[] {
  return list(policy.paths?.public_api).length ? ["paths.public_api: defined but reserved for future use; not enforced at runtime"] : [];
}
