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
  key: string;
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
  mode?: string;
  baseRef?: string | null;
  headRef?: string | null;
  governanceGrant?: unknown;
  trustedAuthorizer?: { trusted?: boolean; source?: string } | null;
  changeIntent?: { change_type?: string; [key: string]: unknown } | null;
  diff: { files: { checked: ParsedDiffFile[] } };
  derived?: unknown;
}
interface ConstraintContext {
  executionPhase?: ExecutionPhase;
  replacedStateConstraintKeys?: readonly string[];
  satisfiedTransactionConstraintKeys?: readonly string[];
}
interface ConstraintIR { constraints: RuntimeConstraint[]; }
interface RuleResult { name: string; check: unknown; }

const BUDGET_EVIDENCE_FIELDS = ["policy_limit", "intent_limit", "effective_limit"] as const;

interface GrowthRule { id?: string; scope?: string; metric?: string; max?: number; max_growth?: number; count?: string; level?: string; applies_to_change_types?: string[]; }
function sizeGrowthAuthorization(facts: ConstraintFacts): { present: boolean; ok: boolean; limits: Record<string, number>; reasons: string[] } {
  const grantContainer = facts.governanceGrant;
  const grant = grantContainer && typeof grantContainer === "object" && !Array.isArray(grantContainer)
    ? (grantContainer as { size_rule_growth?: unknown }).size_rule_growth : null;
  if (grant === null || grant === undefined) return { present: false, ok: true, limits: {}, reasons: [] };
  const reasons: string[] = [], limits: Record<string, number> = {};
  const value = grant && typeof grant === "object" && !Array.isArray(grant) ? grant as Record<string, unknown> : {};
  const trusted = facts.trustedAuthorizer;
  if (facts.mode !== "check-pr" || !trusted || trusted.trusted !== true || trusted.source !== "repository_permission") reasons.push("growth_authorizer_untrusted");
  const sha = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{40}$/i.test(v);
  if (!sha(value.base_sha) || !sha(value.head_sha) || value.base_sha !== facts.baseRef || value.head_sha !== facts.headRef) reasons.push("growth_snapshot_mismatch");
  const entries = value.limits, seen = new Set<string>();
  const rules: GrowthRule[] = Array.isArray(facts.policy.size_rules) ? facts.policy.size_rules as GrowthRule[] : [];
  if (!Array.isArray(entries) || !entries.length) reasons.push("growth_limits_missing");
  else for (const entry of entries) {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const id = item.rule_id;
    if (typeof id !== "string" || !id || seen.has(id)) { reasons.push("growth_rule_duplicate_or_invalid"); continue; }
    seen.add(id);
    const matches = rules.filter((rule) => rule.id === id);
    if (matches.length !== 1) { reasons.push(`growth_rule_unknown_or_ambiguous:${id}`); continue; }
    const rule = matches[0]!;
    if (rule.scope !== "directory" || !["lines", "files"].includes(String(rule.metric)) || (rule.count && rule.count !== "all_tracked") || rule.level === "advisory" || typeof rule.max_growth !== "number" || !Number.isInteger(rule.max_growth) || typeof rule.max !== "number" || !Number.isInteger(rule.max)) {
      reasons.push(`growth_rule_ineligible:${id}`); continue;
    }
    if (Array.isArray(rule.applies_to_change_types) && !rule.applies_to_change_types.includes(facts.changeIntent?.change_type ?? "")) {
      reasons.push(`growth_rule_not_applicable:${id}`); continue;
    }
    if (typeof item.max_growth !== "number" || !Number.isInteger(item.max_growth) || item.max_growth <= rule.max_growth! || item.max_growth > rule.max!) {
      reasons.push(`growth_limit_invalid:${id}`); continue;
    }
    limits[id] = item.max_growth as number;
  }
  return { present: true, ok: reasons.length === 0, limits: reasons.length ? {} : limits, reasons };
}

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
  return { constraints: runtimeConstraints(compileConstraintProgram(facts.policy, facts.changeIntent as never, { authorizedGrowth: sizeGrowthAuthorization(facts).limits })) as RuntimeConstraint[] };
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

function withConstraintEvidence(check: unknown, constraint: RuntimeConstraint): unknown {
  if (!check || typeof check !== "object" || Array.isArray(check)) return check;
  const parameters = constraint.parameters || {};
  const budget = Object.fromEntries(BUDGET_EVIDENCE_FIELDS.flatMap((field) => Object.hasOwn(parameters, field) ? [[field, parameters[field]]] : []));
  const relation = { relation_id: constraint.relation_id, kind: constraint.primitive, operands: constraint.operands };
  const record = check as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
  return { ...record, ...budget, data: { ...data, ...relation, ...budget } };
}

function advisoryCheck(check: unknown, advisory: boolean | undefined): unknown {
  if (!advisory || !check || typeof check !== "object" || Array.isArray(check)) return check;
  return { ...(check as Record<string, unknown>), advisory: true };
}

export function evaluateConstraintIR(facts: ConstraintFacts, context: ConstraintContext = {}): RuleResult[] {
  const executionPhase = requestedExecutionPhase(context);
  const replacedStateConstraints = new Set(context.replacedStateConstraintKeys || []);
  const satisfiedTransactionConstraints = new Set(context.satisfiedTransactionConstraintKeys || []);
  const authorization = sizeGrowthAuthorization(facts);
  const { constraints } = compileConstraintIR(facts), results: RuleResult[] = [];
  if (authorization.present) results.push({ name: "size-rule-growth-authorization", check: { ok: authorization.ok, message: authorization.ok ? "exact trusted growth exception authorized" : "size rule growth exception rejected", details: authorization.reasons, data: { base_sha: facts.baseRef, head_sha: facts.headRef, effective_limits: authorization.limits } } });
  for (const constraint of constraints) {
    if (!constraintAppliesToPhase(constraint, executionPhase)) continue;
    if (replacedStateConstraints.has(constraint.key) && constraintPhase(constraint) === "state") continue;
    if (satisfiedTransactionConstraints.has(constraint.key) && constraintPhase(constraint) === "transaction") continue;
    if (constraint.kind !== "primitive_relation") throw new Error(`runtime constraint kind "${(constraint as { kind?: unknown }).kind}" is unsupported`);
    const evaluated = evaluatePrimitiveRelation(facts, primitiveRelation(constraint));
    const check = advisoryCheck(withConstraintEvidence(evaluated, constraint), constraint.advisory);
    results.push({ name: constraint.name, check });
  }
  return results;
}

export const constraintRuleFamily: RuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts as ConstraintFacts, context as ConstraintContext) };
