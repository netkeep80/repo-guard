import type { ParsedDiffFile } from "../../diff/parser.mjs";
import type { DocumentReader } from "../../document-facts.mjs";
import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import {
  evaluatePrimitiveRelation,
  relationDescriptor,
  type PrimitiveRelation,
  type RelationEvaluationFacts,
} from "../relation-kernel.mjs";
import type { ExecutionPhase, RuleFamily } from "../rule-registry.mjs";

type RuntimeConstraintKind = "primitive_relation";

interface RuntimeConstraint {
  kind: RuntimeConstraintKind;
  name: string;
  phase?: ExecutionPhase;
  advisory?: boolean;
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
}
interface ConstraintContext {
  executionPhase?: ExecutionPhase;
}
interface ConstraintIR { files: ParsedDiffFile[]; constraints: RuntimeConstraint[]; }
interface RuleResult { name: string; check: unknown; }

function requestedExecutionPhase(context: ConstraintContext): ExecutionPhase {
  const phase = context.executionPhase ?? "both";
  if (phase !== "transaction" && phase !== "state" && phase !== "both") {
    throw new TypeError("execution phase must be transaction, state, or both");
  }
  return phase;
}

function constraintPhase(constraint: RuntimeConstraint): ExecutionPhase {
  if (constraint.kind !== "primitive_relation") throw new Error(`runtime constraint kind "${(constraint as { kind?: unknown }).kind}" is unsupported`);
  return constraint.phase ?? relationDescriptor(constraint.primitive || "").phase;
}

function constraintAppliesToPhase(constraint: RuntimeConstraint, requested: ExecutionPhase): boolean {
  const phase = constraintPhase(constraint);
  return requested === "both" || phase === "both" || phase === requested;
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

function advisoryCheck(check: unknown, advisory: boolean | undefined): unknown {
  if (!advisory || !check || typeof check !== "object" || Array.isArray(check)) return check;
  return { ...(check as Record<string, unknown>), advisory: true };
}

export function evaluateConstraintIR(facts: ConstraintFacts, context: ConstraintContext = {}): RuleResult[] {
  const executionPhase = requestedExecutionPhase(context);
  const { constraints } = compileConstraintIR(facts), results: RuleResult[] = [];
  for (const constraint of constraints) {
    if (!constraintAppliesToPhase(constraint, executionPhase)) continue;
    if (constraint.kind !== "primitive_relation") throw new Error(`runtime constraint kind "${(constraint as { kind?: unknown }).kind}" is unsupported`);
    const check = advisoryCheck(evaluatePrimitiveRelation(facts, primitiveRelation(constraint)), constraint.advisory);
    results.push({ name: constraint.name, check });
  }
  return results;
}

export const constraintRuleFamily: RuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts as ConstraintFacts, context as ConstraintContext) };
