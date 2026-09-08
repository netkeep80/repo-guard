import type { ParsedDiffFile } from "../../diff/parser.mjs";
import type { DocumentReader } from "../../document-facts.mjs";
import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { integrationConstraintEntries } from "../integration-constraints.mjs";
import {
  evaluatePrimitiveRelation,
  relationDescriptor,
  type PrimitiveRelation,
  type RelationEvaluationFacts,
} from "../relation-kernel.mjs";
import type { ExecutionPhase, RuleFamily } from "../rule-registry.mjs";
import type { SizeRule } from "./size-rules.mjs";
import { checkSizeRules } from "./size-rules.mjs";

type RuntimeConstraintKind =
  | "size_rules"
  | "integration"
  | "primitive_relation";

type FixedPhaseConstraintKind = Exclude<RuntimeConstraintKind, "primitive_relation">;

interface RuntimeConstraint {
  kind: RuntimeConstraintKind;
  name: string;
  phase?: ExecutionPhase;
  rules?: unknown;
  relation_id?: string;
  primitive?: string;
  operands?: PrimitiveRelation["operands"];
  parameters?: PrimitiveRelation["parameters"];
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
  size_rules: "both",
  integration: "state",
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

export function compileConstraintIR(facts: ConstraintFacts): ConstraintIR {
  return { files: facts.diff.files.checked, constraints: runtimeConstraints(compileConstraintProgram(facts.policy, facts.changeIntent as never)) as RuntimeConstraint[] };
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
    if (constraint.kind === "size_rules") {
      const rules = projectSizeRules(constraint.rules as SizeRule[], executionPhase);
      if (!rules.length) continue;
      const result = checkSizeRules(files, rules, {
        repoRoot: facts.repositoryRoot, trackedFiles: facts.trackedFiles, readFile: facts.readFile,
        ignorePatterns: facts.policy.paths.operational_paths, changeType: facts.changeIntent?.change_type,
      });
      results.push({ name: constraint.name, check: result });
      if (result.advisory_violations.length) results.push({ name: "size-rules-advisory", check: { ok: false, advisory: true, size_violations: result.advisory_violations, details: result.advisory_details, growth: result.growth } });
      continue;
    } else if (constraint.kind === "integration") {
      results.push(...integrationConstraintEntries(facts.integration as Parameters<typeof integrationConstraintEntries>[0]));
      continue;
    } else if (constraint.kind === "primitive_relation") check = evaluatePrimitiveRelation(facts, primitiveRelation(constraint));
    else throw new Error(`runtime constraint kind "${(constraint as { kind?: unknown }).kind}" is unsupported`);
    results.push({ name: constraint.name, check });
  }
  return results;
}

export const constraintRuleFamily: RuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts as ConstraintFacts, context as ConstraintContext) };