import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { calculateDiffGrowth } from "../../diff/growth.mjs";
import { readFact, type DocumentReader, type FactRef } from "../../document-facts.mjs";
import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { checkWorkflowPathCoverage, integrationConstraintEntries } from "../integration-constraints.mjs";
import {
  evaluatePrimitiveRelation,
  relationDescriptor,
  type PrimitiveRelation,
  type RelationEvaluationFacts,
} from "../relation-kernel.mjs";
import type { ExecutionPhase, RuleFamily } from "../rule-registry.mjs";
import { checkChangeProfile } from "./change-profiles.mjs";
import { checkRegistryRules } from "./registry-rules.mjs";
import type { SizeRule } from "./size-rules.mjs";
import { checkSizeRules } from "./size-rules.mjs";

interface SurfaceDebt {
  repayment_issue?: unknown;
  expected_delta?: { max_new_files?: number; max_net_added_lines?: number };
  [key: string]: unknown;
}

type RuntimeConstraintKind =
  | "surface_debt"
  | "size_rules"
  | "registry_rules"
  | "change_profile"
  | "integration"
  | "primitive_relation"
  | "evidence_workflow_path_coverage";

type FixedPhaseConstraintKind = Exclude<RuntimeConstraintKind, "primitive_relation">;

interface RuntimeConstraint {
  kind: RuntimeConstraintKind;
  name: string;
  phase?: ExecutionPhase;
  debt?: SurfaceDebt | null;
  rules?: unknown;
  relation_id?: string;
  primitive?: string;
  operands?: PrimitiveRelation["operands"];
  parameters?: PrimitiveRelation["parameters"];
  binding_id?: string;
  source?: FactRef;
  workflow?: string;
  covers?: string[];
}

interface ConstraintPolicyProjection {
  paths: { canonical_docs: string[]; operational_paths: string[] };
  [key: string]: unknown;
}
interface ConstraintFacts extends RelationEvaluationFacts {
  repositoryRoot?: string;
  readFile?: (filePath: string) => unknown;
  documents?: DocumentReader;
  policy: ConstraintPolicyProjection;
  changeIntent?: { change_type?: string; [key: string]: unknown } | null;
  diff: { files: { checked: ParsedDiffFile[] } };
  derived?: unknown;
  integration?: unknown;
}
interface ConstraintContext {
  executionPhase?: ExecutionPhase;
}
interface ConstraintIR { files: ParsedDiffFile[]; constraints: RuntimeConstraint[]; }
interface RuleResult { name: string; check: unknown; }

const CONSTRAINT_PHASES: Record<FixedPhaseConstraintKind, ExecutionPhase> = {
  surface_debt: "transaction",
  size_rules: "both",
  registry_rules: "state",
  change_profile: "transaction",
  integration: "state",
  evidence_workflow_path_coverage: "state",
};

function requestedExecutionPhase(context: ConstraintContext): ExecutionPhase {
  const phase = context.executionPhase ?? "both";
  if (phase !== "transaction" && phase !== "state" && phase !== "both") {
    throw new TypeError("execution phase must be transaction, state, or both");
  }
  return phase;
}

function constraintPhase(constraint: RuntimeConstraint): ExecutionPhase {
  if (constraint.kind === "primitive_relation") return constraint.phase ?? relationDescriptor(constraint.primitive || "").phase;
  const phase = CONSTRAINT_PHASES[constraint.kind];
  if (!phase) throw new Error(`runtime constraint kind "${constraint.kind}" has no execution phase`);
  return phase;
}

function constraintAppliesToPhase(constraint: RuntimeConstraint, requested: ExecutionPhase): boolean {
  const phase = constraintPhase(constraint);
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

export function compileConstraintIR(facts: ConstraintFacts): ConstraintIR {
  return { files: facts.diff.files.checked, constraints: runtimeConstraints(compileConstraintProgram(facts.policy, facts.changeIntent as never)) as RuntimeConstraint[] };
}

function factOperand(facts: ConstraintFacts, ref: FactRef | undefined) {
  if (!ref) return { ok: false as const, error: { code: "document_read_error", pointer: "", message: "fact reference is unavailable" } };
  return readFact(facts, ref);
}

function checkEvidenceWorkflowPathCoverage(facts: ConstraintFacts, constraint: RuntimeConstraint) {
  const source = factOperand(facts, constraint.source);
  if (!source.ok) return { ok: false, message: `evidence binding "${constraint.binding_id}" could not read repository path references`, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source } };
  if (!Array.isArray(source.value)) return { ok: false, message: `evidence binding "${constraint.binding_id}" did not produce a repository path set`, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source } };
  const coverage = checkWorkflowPathCoverage(facts.integration as Parameters<typeof checkWorkflowPathCoverage>[0], { workflow: constraint.workflow || "", covers: constraint.covers || [] }, source.value);
  return { ...coverage, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source, ...coverage.data } };
}

function primitiveRelation(constraint: RuntimeConstraint): PrimitiveRelation {
  if (!constraint.relation_id || !constraint.primitive || !constraint.operands || !constraint.parameters) {
    throw new Error(`runtime primitive relation "${constraint.name}" is incomplete`);
  }
  return {
    relation_id: constraint.relation_id,
    primitive: constraint.primitive,
    operands: constraint.operands,
    parameters: constraint.parameters,
  };
}

export function evaluateConstraintIR(facts: ConstraintFacts, context: ConstraintContext = {}): RuleResult[] {
  const executionPhase = requestedExecutionPhase(context);
  const { files, constraints } = compileConstraintIR(facts), results: RuleResult[] = [];
  for (const constraint of constraints) {
    if (!constraintAppliesToPhase(constraint, executionPhase)) continue;
    let check: unknown;
    if (constraint.kind === "surface_debt") check = checkSurfaceDebt(files, constraint.debt);
    else if (constraint.kind === "size_rules") {
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
    else if (constraint.kind === "integration") {
      results.push(...integrationConstraintEntries(facts.integration as Parameters<typeof integrationConstraintEntries>[0]));
      continue;
    } else if (constraint.kind === "primitive_relation") check = evaluatePrimitiveRelation(facts, primitiveRelation(constraint));
    else if (constraint.kind === "evidence_workflow_path_coverage") check = checkEvidenceWorkflowPathCoverage(facts, constraint);
    else throw new Error(`runtime constraint kind "${(constraint as { kind?: unknown }).kind}" is unsupported`);
    results.push({ name: constraint.name, check });
  }
  return results;
}

export const constraintRuleFamily: RuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts as ConstraintFacts, context as ConstraintContext) };
