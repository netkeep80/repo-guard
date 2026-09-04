import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { calculateDiffGrowth } from "../../diff/growth.mjs";
import { selectPaths } from "../../diff/classification.mjs";
import { DocumentFactFailure, readDocumentFact, resolveJsonPointer, type DocumentFactSelector, type DocumentReader } from "../../document-facts.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";
import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { checkWorkflowPathCoverage, integrationConstraintEntries } from "../integration-constraints.mjs";
import { compareSets } from "../relation-kernel.mjs";
import type { ExecutionPhase, RuleFamily } from "../rule-registry.mjs";
import { checkTraceRuleResult } from "../trace-rules.mjs";
import { checkChangeProfile } from "./change-profiles.mjs";
import { checkRegistryRules } from "./registry-rules.mjs";
import type { SizeRule } from "./size-rules.mjs";
import { checkSizeRules } from "./size-rules.mjs";

interface BudgetResult { ok: boolean; actual?: number; limit?: number; files?: string[]; }
interface SurfaceDebt {
  repayment_issue?: unknown;
  expected_delta?: { max_new_files?: number; max_net_added_lines?: number };
  [key: string]: unknown;
}
interface AnchorEvidenceInstance { value?: unknown; file?: unknown; line?: unknown; column?: unknown; }
interface DocumentPointerTarget { document?: string; path?: string; format?: unknown; }
interface RuntimeDocumentSelector extends DocumentFactSelector { format?: unknown; snapshot?: unknown; }

type RuntimeConstraintKind =
  | "max_metric"
  | "surface_debt"
  | "scope_paths"
  | "require_paths"
  | "forbid_paths"
  | "implies_nonempty"
  | "size_rules"
  | "registry_rules"
  | "change_profile"
  | "trace_rules"
  | "integration"
  | "document_scalar_strictly_greater"
  | "document_scalar_equal"
  | "document_scalar_equals_literal"
  | "document_referenced_paths_exist"
  | "document_set_equal"
  | "document_set_subset"
  | "document_referenced_pointer_exists"
  | "evidence_workflow_path_coverage"
  | "evidence_anchor_value_coverage";

interface RuntimeConstraint {
  kind: RuntimeConstraintKind;
  name: string;
  metric?: "new_docs" | "new_files" | "net_added_lines";
  max?: number;
  debt?: SurfaceDebt | null;
  patterns?: string[];
  changeIntent?: unknown;
  if_changed?: string[];
  must_change_any?: string[];
  rules?: unknown;
  relation_id?: string;
  binding_id?: string;
  left?: RuntimeDocumentSelector;
  right?: RuntimeDocumentSelector;
  source?: RuntimeDocumentSelector;
  target?: DocumentPointerTarget;
  value?: unknown;
  comparator?: unknown;
  workflow?: string;
  covers?: string[];
  target_anchor_type?: string;
}

interface ConstraintPolicyProjection {
  paths: { canonical_docs: string[]; operational_paths: string[] };
  [key: string]: unknown;
}
interface ConstraintFacts {
  repositoryRoot?: string;
  trackedFiles?: string[];
  readFile?: (filePath: string) => unknown;
  readFileAtRef?: (ref: string, filePath: string) => unknown;
  baseRef?: string | null;
  headRef?: string | null;
  documents?: DocumentReader;
  policy: ConstraintPolicyProjection;
  changeIntent?: { change_type?: string } | null;
  diff: { files: { checked: ParsedDiffFile[] } };
  derived?: unknown;
  integration?: unknown;
  anchors?: { byType?: Record<string, AnchorEvidenceInstance[]> };
}
interface ConstraintContext {
  executionPhase?: ExecutionPhase;
  anchorDiagnostics?: { traceRuleResults?: Array<{ id: string; [key: string]: unknown }> };
}
interface ConstraintIR { files: ParsedDiffFile[]; constraints: RuntimeConstraint[]; }
interface RuleResult { name: string; check: unknown; }

const CONSTRAINT_PHASES: Record<RuntimeConstraintKind, ExecutionPhase> = {
  max_metric: "transaction",
  surface_debt: "transaction",
  scope_paths: "transaction",
  require_paths: "transaction",
  forbid_paths: "transaction",
  implies_nonempty: "transaction",
  size_rules: "both",
  registry_rules: "state",
  change_profile: "transaction",
  trace_rules: "transaction",
  integration: "state",
  document_scalar_strictly_greater: "transaction",
  document_scalar_equal: "state",
  document_scalar_equals_literal: "state",
  document_referenced_paths_exist: "state",
  document_set_equal: "state",
  document_set_subset: "state",
  document_referenced_pointer_exists: "state",
  evidence_workflow_path_coverage: "state",
  evidence_anchor_value_coverage: "state",
};

function requestedExecutionPhase(context: ConstraintContext): ExecutionPhase {
  const phase = context.executionPhase ?? "both";
  if (phase !== "transaction" && phase !== "state" && phase !== "both") {
    throw new TypeError("execution phase must be transaction, state, or both");
  }
  return phase;
}

function constraintAppliesToPhase(constraint: RuntimeConstraint, requested: ExecutionPhase): boolean {
  const phase = CONSTRAINT_PHASES[constraint.kind];
  if (!phase) throw new Error(`runtime constraint kind "${constraint.kind}" has no execution phase`);
  return requested === "both" || phase === "both" || phase === requested;
}

function projectSizeRules(rules: SizeRule[], requested: ExecutionPhase): SizeRule[] {
  if (requested === "both") return rules;
  return rules.flatMap((rule) => {
    const transactionBound = rule.count === "changed_only" || rule.applies_to_change_types !== undefined;
    if (requested === "state") {
      if (transactionBound || rule.max === undefined) return [];
      return [{ ...rule, max_growth: undefined }];
    }
    if (transactionBound) return [rule];
    if (rule.max_growth === undefined) return [];
    return [{ ...rule, max: undefined }];
  });
}

function budget(selected: ParsedDiffFile[], max: number | undefined): BudgetResult {
  if (max === undefined) return { ok: true };
  return { ok: selected.length <= max, actual: selected.length, limit: max, files: selected.map((file) => file.path) };
}
export const checkCanonicalDocsBudget = (files: ParsedDiffFile[], canonicalDocs: string[] = [], max?: number): BudgetResult => budget(files.filter((file) => file.status === "added" && /\.md$/i.test(file.path) && !canonicalDocs.includes(file.path)), max);
export const checkNewFilesBudget = (files: ParsedDiffFile[], max?: number): BudgetResult => budget(files.filter((file) => file.status === "added"), max);
export function checkNetAddedLinesBudget(files: ParsedDiffFile[], max?: number): BudgetResult {
  if (max === undefined) return { ok: true };
  const actual = files.reduce((sum, file) => sum + (file.addedLines?.length || 0) - (file.deletedLines?.length || 0), 0);
  return { ok: actual <= max, actual, limit: max };
}
export function checkSurfaceDebt(files: ParsedDiffFile[], debt: SurfaceDebt | null | undefined) {
  const growth = calculateDiffGrowth(files);
  if (growth.new_files <= 0 && growth.net_added_lines <= 0) return { ok: true, status: "not_needed", growth };
  if (!debt) return { ok: true, status: "undeclared", growth, details: [`new files: ${growth.new_files}`, `net added lines: ${growth.net_added_lines}`] };
  if (!debt.repayment_issue) return { ok: false, status: "missing_repayment_target", message: "declared surface debt is missing repayment target: repayment_issue", growth, surface_debt: debt, details: ["missing repayment_issue"], hint: "Set repayment_issue to the issue number where the temporary growth will be repaid." };
  const expected = debt.expected_delta || {}, exceeded: string[] = [];
  if (expected.max_new_files !== undefined && growth.new_files > expected.max_new_files) exceeded.push(`new files ${growth.new_files} exceeds declared debt ${expected.max_new_files}`);
  if (expected.max_net_added_lines !== undefined && growth.net_added_lines > expected.max_net_added_lines) exceeded.push(`net added lines ${growth.net_added_lines} exceeds declared debt ${expected.max_net_added_lines}`);
  return { ok: !exceeded.length, status: exceeded.length ? "declared_debt_exceeded" : "declared", message: exceeded.length ? "declared surface debt is smaller than actual diff growth" : undefined, growth, surface_debt: debt, details: exceeded, hint: exceeded.length ? "Update expected_delta to match intentional temporary growth or reduce the diff." : undefined };
}
export const checkForbiddenPaths = (files: ParsedDiffFile[], patterns: string[]): string[] => selectPaths(files, patterns, { excludeStatuses: ["deleted"] });
export function checkScope(files: ParsedDiffFile[], patterns?: string[]) {
  if (!patterns?.length) return { ok: true };
  const out = files.filter((file) => !matchesAny(file.path, patterns)).map((file) => file.path).sort();
  return { ok: !out.length, declared_scope: patterns, out_of_scope_paths: out, message: out.length ? "changed files fall outside declared ChangeIntent scope" : undefined, details: out.map((path) => `out of scope: ${path}`) };
}
export function checkMustTouch(files: ParsedDiffFile[], patterns?: string[]) {
  if (!patterns?.length) return { ok: true };
  const ok = selectPaths(files, patterns).length > 0;
  return { ok, must_touch: patterns, changed: files.map((file) => file.path), hint: ok ? undefined : "must_touch uses any-of semantics: at least one pattern must match a changed file" };
}
export function checkMustNotTouch(files: ParsedDiffFile[], patterns?: string[]) {
  if (!patterns?.length) return { ok: true };
  const touched = selectPaths(files, patterns);
  return { ok: !touched.length, touched, must_not_touch: patterns };
}
export const checkCochangeRules = (files: ParsedDiffFile[], rules: Array<{ if_changed: string[]; must_change_any: string[] }> = []) => rules.flatMap((rule) => selectPaths(files, rule.if_changed).length && !selectPaths(files, rule.must_change_any).length ? [{ if_changed: rule.if_changed, must_change_any: rule.must_change_any }] : []);
export function compileConstraintIR(facts: ConstraintFacts): ConstraintIR {
  return { files: facts.diff.files.checked, constraints: runtimeConstraints(compileConstraintProgram(facts.policy, facts.changeIntent as never)) as RuntimeConstraint[] };
}
function evaluateMetric(files: ParsedDiffFile[], constraint: RuntimeConstraint, policy: ConstraintPolicyProjection) {
  if (constraint.metric === "new_docs") return checkCanonicalDocsBudget(files, policy.paths.canonical_docs, constraint.max);
  if (constraint.metric === "new_files") return checkNewFilesBudget(files, constraint.max);
  return checkNetAddedLinesBudget(files, constraint.max);
}
function factOperand(reader: DocumentReader | undefined, selector: DocumentFactSelector | undefined) {
  if (!reader || !selector) return { ok: false as const, error: { code: "document_read_error", pointer: selector?.pointer || "", message: "document reader or selector is unavailable" } };
  return readDocumentFact(reader, selector);
}
function snapshotOperand(facts: ConstraintFacts, selector: RuntimeDocumentSelector | undefined) {
  const snapshot = selector?.snapshot, label = snapshot === "base" ? "BASE" : snapshot === "head" ? "HEAD" : "snapshot";
  const ref = snapshot === "base" ? facts.baseRef : snapshot === "head" ? facts.headRef : null;
  const path = selector?.path || "";
  if (!selector || selector.format !== "plain_text" || selector.pointer !== "" || selector.type !== "string" || (snapshot !== "base" && snapshot !== "head")) {
    return { ok: false as const, label, path, error: `invalid ${label} plain-text scalar selector` };
  }
  if (!ref) return { ok: false as const, label, path, error: `missing ${label} ref` };
  if (!facts.readFileAtRef) return { ok: false as const, label, path, error: `snapshot reader unavailable for ${label}` };
  try {
    const raw = facts.readFileAtRef(ref, path);
    if (raw === null || raw === undefined) return { ok: false as const, label, path, error: `missing ${label} file` };
    return { ok: true as const, label, path, value: String(raw).trim() };
  } catch (error: unknown) {
    return { ok: false as const, label, path, error: `${label} read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
function parseSemverCore(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  return tuple.every(Number.isSafeInteger) ? tuple : null;
}
function tupleGreater(left: [number, number, number], right: [number, number, number]): boolean {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}
function checkDocumentScalarStrictlyGreater(facts: ConstraintFacts, constraint: RuntimeConstraint) {
  const left = snapshotOperand(facts, constraint.left), right = snapshotOperand(facts, constraint.right);
  const base = left.label === "BASE" ? left : right.label === "BASE" ? right : null;
  const head = left.label === "HEAD" ? left : right.label === "HEAD" ? right : null;
  const path = head?.path || base?.path || constraint.left?.path || constraint.right?.path || "";
  const baseValue = base?.ok ? base.value : undefined, headValue = head?.ok ? head.value : undefined;
  const diagnostic = { rule_id: constraint.relation_id, path, base_value: baseValue, head_value: headValue, expected_relation: "strictly_greater", comparator: constraint.comparator };
  if (!base || !head) return { ok: false, message: `document relation "${constraint.relation_id}" requires one BASE and one HEAD operand`, ...diagnostic, data: { left, right } };
  if (base.path !== head.path) return { ok: false, message: `document relation "${constraint.relation_id}" requires BASE and HEAD of the same path`, ...diagnostic, data: { left, right } };
  if (!base.ok) return { ok: false, message: `document relation "${constraint.relation_id}" could not read BASE: ${base.error}`, ...diagnostic, data: { left, right } };
  if (!head.ok) return { ok: false, message: `document relation "${constraint.relation_id}" could not read HEAD: ${head.error}`, ...diagnostic, data: { left, right } };
  if (constraint.comparator !== "semver") return { ok: false, message: `document relation "${constraint.relation_id}" has unsupported comparator`, ...diagnostic, data: { left, right } };
  const baseTuple = parseSemverCore(base.value), headTuple = parseSemverCore(head.value);
  if (!baseTuple) return { ok: false, message: `document relation "${constraint.relation_id}" has malformed BASE semver`, ...diagnostic, data: { left, right } };
  if (!headTuple) return { ok: false, message: `document relation "${constraint.relation_id}" has malformed HEAD semver`, ...diagnostic, data: { left, right } };
  const ok = tupleGreater(headTuple, baseTuple);
  return { ok, message: ok ? undefined : `document relation "${constraint.relation_id}" expected HEAD > BASE`, ...diagnostic, data: { left, right } };
}
function checkDocumentScalarEqual(facts: ConstraintFacts, constraint: RuntimeConstraint) {
  const left = factOperand(facts.documents, constraint.left), right = factOperand(facts.documents, constraint.right);
  const data = { kind: "scalar_equal", left, right };
  if (!left.ok || !right.ok) return { ok: false, message: `document relation "${constraint.relation_id}" could not read scalar operands`, data };
  const ok = left.value === right.value;
  return { ok, message: ok ? undefined : `document relation "${constraint.relation_id}" scalar values differ`, data };
}
function checkDocumentScalarLiteral(facts: ConstraintFacts, constraint: RuntimeConstraint) {
  const source = factOperand(facts.documents, constraint.source), expected = constraint.value;
  const data = { kind: "scalar_equals_literal", source, expected };
  if (!source.ok) return { ok: false, message: `document relation "${constraint.relation_id}" could not read scalar operand`, data };
  const ok = source.value === expected;
  return { ok, message: ok ? undefined : `document relation "${constraint.relation_id}" scalar value does not match literal`, data };
}
function checkDocumentReferencedPathsExist(facts: ConstraintFacts, constraint: RuntimeConstraint) {
  const source = factOperand(facts.documents, constraint.source);
  if (!source.ok) return { ok: false, message: `document relation "${constraint.relation_id}" could not read repository path references`, data: { kind: "referenced_paths_exist", source } };
  if (!Array.isArray(source.value)) return { ok: false, message: `document relation "${constraint.relation_id}" did not produce a repository path set`, data: { kind: "referenced_paths_exist", source } };
  const referencedPaths = source.value;
  if (facts.trackedFiles === undefined) return {
    ok: false,
    message: `document relation "${constraint.relation_id}" cannot verify references without tracked repository facts`,
    data: { kind: "referenced_paths_exist", source, referenced_paths: referencedPaths, missing_paths: [], tracked_repository_available: false },
  };
  const tracked = new Set(facts.trackedFiles);
  const missingPaths = referencedPaths.filter((path) => !tracked.has(path)).sort();
  return { ok: missingPaths.length === 0, message: missingPaths.length ? `document relation "${constraint.relation_id}" references missing repository paths` : undefined, data: { kind: "referenced_paths_exist", source, referenced_paths: referencedPaths, missing_paths: missingPaths } };
}
function checkDocumentSetRelation(facts: ConstraintFacts, constraint: RuntimeConstraint, relation: "equal" | "left_subset") {
  const left = factOperand(facts.documents, constraint.left), right = factOperand(facts.documents, constraint.right);
  const kind = relation === "equal" ? "set_equal" : "set_subset";
  if (!left.ok || !right.ok) return { ok: false, message: `document relation "${constraint.relation_id}" could not read string-set operands`, data: { kind, left, right } };
  if (!Array.isArray(left.value) || !Array.isArray(right.value)) return { ok: false, message: `document relation "${constraint.relation_id}" did not produce string sets`, data: { kind, left, right } };
  const compared = compareSets(left.value, right.value, relation);
  return {
    ok: compared.ok,
    message: compared.ok ? undefined : `document relation "${constraint.relation_id}" failed ${kind}`,
    data: { kind, left, right, missing_values: compared.missing, extra_values: compared.extra },
  };
}
function pointerTargetError(error: unknown, pointer: string) {
  if (error instanceof DocumentFactFailure) return { code: error.code, pointer: error.pointer, ...(error.segment === undefined ? {} : { segment: error.segment }), message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: "document_read_error", pointer, message: String(message || "document read failed").replace(/\s+/g, " ").trim() };
}
function readReferencedPointerTarget(reader: DocumentReader | undefined, target: DocumentPointerTarget | undefined, pointer: string) {
  if (!reader || !target?.path) return { ok: false as const, error: { code: "document_read_error", pointer, message: "document reader or target document is unavailable" } };
  try {
    const document = target.format === "yaml" ? reader.yaml(target.path) : target.format === "json" ? reader.json(target.path) : (() => { throw new DocumentFactFailure("unsupported_document_type", `unsupported document type for "${target.path}"`, pointer); })();
    resolveJsonPointer(document, pointer);
    return { ok: true as const, document: target.document, path: target.path, pointer };
  } catch (error: unknown) {
    return { ok: false as const, error: pointerTargetError(error, pointer) };
  }
}
function checkDocumentReferencedPointerExists(facts: ConstraintFacts, constraint: RuntimeConstraint) {
  const source = factOperand(facts.documents, constraint.source);
  if (!source.ok || typeof source.value !== "string") return { ok: false, message: `document relation "${constraint.relation_id}" could not read JSON Pointer source`, data: { kind: "referenced_pointer_exists", source } };
  const target = readReferencedPointerTarget(facts.documents, constraint.target, source.value);
  return { ok: target.ok, message: target.ok ? undefined : `document relation "${constraint.relation_id}" references a missing target pointer`, data: { kind: "referenced_pointer_exists", source, target } };
}
function checkEvidenceWorkflowPathCoverage(facts: ConstraintFacts, constraint: RuntimeConstraint) {
  const source = factOperand(facts.documents, constraint.source);
  if (!source.ok) return { ok: false, message: `evidence binding "${constraint.binding_id}" could not read repository path references`, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source } };
  if (!Array.isArray(source.value)) return { ok: false, message: `evidence binding "${constraint.binding_id}" did not produce a repository path set`, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source } };
  const coverage = checkWorkflowPathCoverage(facts.integration as Parameters<typeof checkWorkflowPathCoverage>[0], { workflow: constraint.workflow || "", covers: constraint.covers || [] }, source.value);
  return { ...coverage, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source, ...coverage.data } };
}
function checkEvidenceAnchorValueCoverage(facts: ConstraintFacts, constraint: RuntimeConstraint) {
  const source = factOperand(facts.documents, constraint.source), target = constraint.target_anchor_type || "";
  if (!source.ok) return { ok: false, message: `evidence binding "${constraint.binding_id}" could not read semantic evidence ids`, data: { kind: "anchor_value_coverage", binding_id: constraint.binding_id, target_anchor_type: target, source } };
  if (!Array.isArray(source.value)) return { ok: false, message: `evidence binding "${constraint.binding_id}" did not produce a string set`, data: { kind: "anchor_value_coverage", binding_id: constraint.binding_id, target_anchor_type: target, source } };
  const byType = facts.anchors?.byType;
  if (!byType) return {
    ok: false,
    message: `evidence binding "${constraint.binding_id}" cannot verify ids without anchor facts`,
    data: { kind: "anchor_value_coverage", binding_id: constraint.binding_id, target_anchor_type: target, source, source_values: source.value, missing_values: source.value, anchor_facts_available: false },
  };
  const instances = Array.isArray(byType[target]) ? byType[target] : [], locations = new Map<string, Array<{ file: string; line?: number; column?: number }>>();
  for (const instance of instances) {
    if (typeof instance.value !== "string" || typeof instance.file !== "string") continue;
    const location: { file: string; line?: number; column?: number } = { file: instance.file };
    if (typeof instance.line === "number") location.line = instance.line;
    if (typeof instance.column === "number") location.column = instance.column;
    const found = locations.get(instance.value) || [];
    found.push(location);
    locations.set(instance.value, found);
  }
  const sourceValues = source.value as string[], missingValues = sourceValues.filter((value) => !locations.has(value)).sort();
  const evidenceLocations = sourceValues.filter((value) => locations.has(value)).map((value) => ({ value, locations: locations.get(value) }));
  return {
    ok: missingValues.length === 0,
    message: missingValues.length ? `evidence binding "${constraint.binding_id}" has declared ids without evidence anchors` : undefined,
    data: { kind: "anchor_value_coverage", binding_id: constraint.binding_id, target_anchor_type: target, source, source_values: sourceValues, missing_values: missingValues, evidence_locations: evidenceLocations },
  };
}

export function evaluateConstraintIR(facts: ConstraintFacts, context: ConstraintContext = {}): RuleResult[] {
  const executionPhase = requestedExecutionPhase(context);
  const { files, constraints } = compileConstraintIR(facts), results: RuleResult[] = [], cochange: RuntimeConstraint[] = [];
  for (const constraint of constraints) {
    if (!constraintAppliesToPhase(constraint, executionPhase)) continue;
    let check: unknown;
    if (constraint.kind === "max_metric") check = evaluateMetric(files, constraint, facts.policy);
    else if (constraint.kind === "surface_debt") check = checkSurfaceDebt(files, constraint.debt);
    else if (constraint.kind === "scope_paths") check = checkScope(files, constraint.patterns);
    else if (constraint.kind === "require_paths") check = checkMustTouch(files, constraint.patterns);
    else if (constraint.kind === "forbid_paths") {
      if (constraint.changeIntent) check = checkMustNotTouch(files, constraint.patterns);
      else { const found = checkForbiddenPaths(files, constraint.patterns!); check = { ok: !found.length, files: found }; }
    } else if (constraint.kind === "implies_nonempty") {
      if (selectPaths(files, constraint.if_changed!).length && !selectPaths(files, constraint.must_change_any!).length) cochange.push(constraint);
      continue;
    } else if (constraint.kind === "size_rules") {
      const rules = projectSizeRules(constraint.rules as SizeRule[], executionPhase);
      if (!rules.length) continue;
      const result = checkSizeRules(files, rules, {
        repoRoot: facts.repositoryRoot, trackedFiles: facts.trackedFiles, readFile: facts.readFile,
        ignorePatterns: facts.policy.paths.operational_paths, changeType: facts.changeIntent?.change_type,
      });
      results.push({ name: constraint.name, check: result });
      if (result.advisory_violations.length) results.push({ name: "size-rules-advisory", check: { ok: false, advisory: true, size_violations: result.advisory_violations, details: result.advisory_details, growth: result.growth } });
      continue;
    } else if (constraint.kind === "registry_rules") check = checkRegistryRules(constraint.rules as Parameters<typeof checkRegistryRules>[0], { repoRoot: facts.repositoryRoot, readFile: facts.readFile, documents: facts.documents });
    else if (constraint.kind === "change_profile") check = checkChangeProfile(files, facts.policy as Parameters<typeof checkChangeProfile>[1], facts.changeIntent?.change_type, facts.derived as Parameters<typeof checkChangeProfile>[3]);
    else if (constraint.kind === "trace_rules") {
      for (const trace of context.anchorDiagnostics?.traceRuleResults || []) results.push({ name: `trace-rule: ${trace.id}`, check: checkTraceRuleResult(trace) });
      continue;
    } else if (constraint.kind === "integration") {
      results.push(...integrationConstraintEntries(facts.integration as Parameters<typeof integrationConstraintEntries>[0]));
      continue;
    } else if (constraint.kind === "document_scalar_strictly_greater") check = checkDocumentScalarStrictlyGreater(facts, constraint);
    else if (constraint.kind === "document_scalar_equal") check = checkDocumentScalarEqual(facts, constraint);
    else if (constraint.kind === "document_scalar_equals_literal") check = checkDocumentScalarLiteral(facts, constraint);
    else if (constraint.kind === "document_referenced_paths_exist") check = checkDocumentReferencedPathsExist(facts, constraint);
    else if (constraint.kind === "document_set_equal") check = checkDocumentSetRelation(facts, constraint, "equal");
    else if (constraint.kind === "document_set_subset") check = checkDocumentSetRelation(facts, constraint, "left_subset");
    else if (constraint.kind === "document_referenced_pointer_exists") check = checkDocumentReferencedPointerExists(facts, constraint);
    else if (constraint.kind === "evidence_workflow_path_coverage") check = checkEvidenceWorkflowPathCoverage(facts, constraint);
    else if (constraint.kind === "evidence_anchor_value_coverage") check = checkEvidenceAnchorValueCoverage(facts, constraint);
    else throw new Error(`runtime constraint kind "${(constraint as { kind?: unknown }).kind}" is unsupported`);
    results.push({ name: constraint.name, check });
  }
  if (executionPhase !== "state") {
    results.push(...(cochange.length ? cochange.map((item) => ({ name: `cochange: ${item.if_changed!.join(",")} -> ${item.must_change_any!.join(",")}`, check: { ok: false, must_touch: item.must_change_any } })) : [{ name: "cochange-rules", check: { ok: true } }]));
  }
  return results;
}

export const constraintRuleFamily: RuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts as ConstraintFacts, context as ConstraintContext) };