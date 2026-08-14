import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { calculateDiffGrowth } from "../../diff/growth.mjs";
import { selectPaths } from "../../diff/classification.mjs";
import { readDocumentFact, type DocumentFactSelector, type DocumentReader } from "../../document-facts.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";
import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { integrationConstraintEntries } from "../integration-constraints.mjs";
import type { RuleFamily } from "../rule-registry.mjs";
import { checkTraceRuleResult } from "../trace-rules.mjs";
import { checkChangeProfile } from "./change-profiles.mjs";
import { checkRegistryRules } from "./registry-rules.mjs";
import type { SizeRule } from "./size-rules.mjs";
import { checkSizeRules } from "./size-rules.mjs";

interface BudgetResult {
  ok: boolean;
  actual?: number;
  limit?: number;
  files?: string[];
}

interface SurfaceDebt {
  repayment_issue?: unknown;
  expected_delta?: { max_new_files?: number; max_net_added_lines?: number };
  [key: string]: unknown;
}

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
  | "document_scalar_equal"
  | "document_scalar_equals_literal"
  | "document_referenced_paths_exist";

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
  left?: DocumentFactSelector;
  right?: DocumentFactSelector;
  source?: DocumentFactSelector;
  value?: unknown;
}

interface ConstraintPolicyProjection {
  paths: { canonical_docs: string[]; operational_paths: string[] };
  [key: string]: unknown;
}

interface ConstraintFacts {
  repositoryRoot?: string;
  trackedFiles?: string[];
  readFile?: (filePath: string) => unknown;
  documents?: DocumentReader;
  policy: ConstraintPolicyProjection;
  changeIntent?: { change_type?: string } | null;
  diff: { files: { checked: ParsedDiffFile[] } };
  derived?: unknown;
  integration?: unknown;
}

interface ConstraintContext {
  anchorDiagnostics?: { traceRuleResults?: Array<{ id: string; [key: string]: unknown }> };
}

interface ConstraintIR {
  files: ParsedDiffFile[];
  constraints: RuntimeConstraint[];
}

interface RuleResult {
  name: string;
  check: unknown;
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
  if (!source.ok) return {
    ok: false,
    message: `document relation "${constraint.relation_id}" could not read repository path references`,
    data: { kind: "referenced_paths_exist", source },
  };
  if (!Array.isArray(source.value)) return {
    ok: false,
    message: `document relation "${constraint.relation_id}" did not produce a repository path set`,
    data: { kind: "referenced_paths_exist", source },
  };

  const referencedPaths = source.value;
  if (facts.trackedFiles === undefined) return {
    ok: false,
    message: `document relation "${constraint.relation_id}" cannot verify references without tracked repository facts`,
    data: { kind: "referenced_paths_exist", source, referenced_paths: referencedPaths, missing_paths: [], tracked_repository_available: false },
  };

  const tracked = new Set(facts.trackedFiles);
  const missingPaths = referencedPaths.filter((path) => !tracked.has(path)).sort();
  return {
    ok: missingPaths.length === 0,
    message: missingPaths.length ? `document relation "${constraint.relation_id}" references missing repository paths` : undefined,
    data: { kind: "referenced_paths_exist", source, referenced_paths: referencedPaths, missing_paths: missingPaths },
  };
}

export function evaluateConstraintIR(facts: ConstraintFacts, context: ConstraintContext = {}): RuleResult[] {
  const { files, constraints } = compileConstraintIR(facts), results: RuleResult[] = [], cochange: RuntimeConstraint[] = [];
  for (const constraint of constraints) {
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
      const result = checkSizeRules(files, constraint.rules as SizeRule[], {
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
    } else if (constraint.kind === "document_scalar_equal") check = checkDocumentScalarEqual(facts, constraint);
    else if (constraint.kind === "document_scalar_equals_literal") check = checkDocumentScalarLiteral(facts, constraint);
    else if (constraint.kind === "document_referenced_paths_exist") check = checkDocumentReferencedPathsExist(facts, constraint);
    else continue;
    results.push({ name: constraint.name, check });
  }
  results.push(...(cochange.length ? cochange.map((item) => ({ name: `cochange: ${item.if_changed!.join(",")} -> ${item.must_change_any!.join(",")}`, check: { ok: false, must_touch: item.must_change_any } })) : [{ name: "cochange-rules", check: { ok: true } }]));
  return results;
}

export const constraintRuleFamily: RuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts as ConstraintFacts, context as ConstraintContext) };
