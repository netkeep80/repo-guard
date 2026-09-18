import { isDeepStrictEqual } from "node:util";
import type { ParsedDiffFile } from "../diff/parser.mjs";
import { compileConstraintProgram, type ConstraintPolicyProjection, type ConstraintProgramEntry, type RuntimeConstraint } from "./constraint-program.mjs";
import { relationDescriptor } from "./relation-kernel.mjs";
import { checkPolicyRelaxation } from "./rules/policy-delta-rules.mjs";

type LooseObject = Record<string, unknown>;
type RuntimePhase = "transaction" | "state" | "both";
type PolicyRelaxationInput = Parameters<typeof checkPolicyRelaxation>[0];

interface StatePlanFacts {
  policy?: unknown;
  basePolicy?: PolicyRelaxationInput["basePolicy"];
  headPolicy?: PolicyRelaxationInput["headPolicy"];
  diff?: { files?: { checked?: ParsedDiffFile[] } };
  trustedAuthorizer?: PolicyRelaxationInput["trustedAuthorizer"];
  governanceGrant?: PolicyRelaxationInput["governanceGrant"] & { allow_policy_relaxation?: unknown };
  changeIntent?: { change_type?: string } | null;
}

export interface ReplacedStateConstraint {
  key: string;
  pointer: string;
  relation_id: string;
  primitive: string;
}

export interface StateObligationPlan {
  contract: "scoped_state_replacement_v1";
  policy_delta_authorized: boolean;
  exact_policy_delta_authorized: boolean;
  authorization_reasons: string[];
  policy_delta_pointers: string[];
  exact_authorized_policy_pointers: string[];
  base_state_constraint_count: number;
  base_transaction_constraint_count: number;
  replaced_base_state_constraints: ReplacedStateConstraint[];
  unreplaced_authorized_state_pointers: string[];
}

const list = <T = unknown,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === "string");
const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort();

function runtimePhase(runtime: RuntimeConstraint | null): RuntimePhase | null {
  if (!runtime || runtime.kind !== "primitive_relation" || typeof runtime.primitive !== "string") return null;
  if (runtime.phase === "transaction" || runtime.phase === "state" || runtime.phase === "both") return runtime.phase;
  return relationDescriptor(runtime.primitive).phase;
}

function pointerOf(entry: ConstraintProgramEntry | undefined): string | null {
  const pointer = entry?.strictness?.pointer;
  return typeof pointer === "string" && pointer ? pointer : null;
}

function changedOnlyByParameters(base: RuntimeConstraint, head: RuntimeConstraint): boolean {
  return base.kind === "primitive_relation"
    && head.kind === "primitive_relation"
    && base.relation_id === head.relation_id
    && base.primitive === head.primitive
    && isDeepStrictEqual(base.operands, head.operands)
    && !isDeepStrictEqual(base.parameters, head.parameters);
}

function policyDeltaPointers(check: LooseObject): string[] {
  return uniqueSorted(list<LooseObject>(check.policy_relaxations)
    .map((item) => item.pointer)
    .filter((pointer): pointer is string => typeof pointer === "string" && pointer.length > 0));
}

export function buildStateObligationPlan(rawFacts: unknown): StateObligationPlan | null {
  const facts = (rawFacts || {}) as StatePlanFacts;
  const basePolicy = facts.basePolicy, headPolicy = facts.headPolicy;
  if (!basePolicy || !headPolicy || !isDeepStrictEqual(facts.policy, basePolicy)) return null;

  const changedFiles = facts.diff?.files?.checked || [];
  const configuredProtectedSurfaces = (basePolicy as LooseObject).policy_delta_rules && typeof (basePolicy as LooseObject).policy_delta_rules === "object"
    ? ((basePolicy as LooseObject).policy_delta_rules as { protected_surfaces?: string[] }).protected_surfaces ?? null
    : null;
  const authorization = checkPolicyRelaxation({
    basePolicy,
    headPolicy,
    changedFiles,
    trustedAuthorizer: facts.trustedAuthorizer,
    governanceGrant: facts.governanceGrant,
    changeIntentType: facts.changeIntent?.change_type ?? null,
    configuredProtectedSurfaces,
  }) as LooseObject;
  const deltaPointers = policyDeltaPointers(authorization);
  if (!deltaPointers.length) return null;

  const grantPointers = new Set(strings(facts.governanceGrant?.allow_policy_relaxation));
  const policyDeltaAuthorized = authorization.ok === true;
  const exactPolicyDeltaAuthorized = policyDeltaAuthorized && deltaPointers.every((pointer) => grantPointers.has(pointer));
  const exactAuthorizedPointers = exactPolicyDeltaAuthorized ? deltaPointers : [];
  const authorizationReasons = strings(authorization.blocked_reasons);
  if (policyDeltaAuthorized && !exactPolicyDeltaAuthorized) authorizationReasons.push("state_replacement_requires_exact_policy_delta_pointers");

  const baseProgram = compileConstraintProgram(basePolicy as ConstraintPolicyProjection, null);
  const headProgram = new Map(compileConstraintProgram(headPolicy as ConstraintPolicyProjection, null).map((entry) => [entry.key, entry]));
  const exactPointerSet = new Set(exactAuthorizedPointers), replaced: ReplacedStateConstraint[] = [];
  let baseStateCount = 0, baseTransactionCount = 0;

  for (const entry of baseProgram) {
    const phase = runtimePhase(entry.runtime);
    if (phase === "state" || phase === "both") baseStateCount++;
    if (phase === "transaction" || phase === "both") baseTransactionCount++;
    if (phase !== "state" || !entry.runtime) continue;

    const pointer = pointerOf(entry), headEntry = headProgram.get(entry.key), headRuntime = headEntry?.runtime || null;
    if (!pointer || !exactPointerSet.has(pointer) || !headRuntime || runtimePhase(headRuntime) !== "state") continue;
    if (pointerOf(headEntry) !== pointer || !changedOnlyByParameters(entry.runtime, headRuntime)) continue;
    replaced.push({
      key: entry.key,
      pointer,
      relation_id: String(entry.runtime.relation_id || ""),
      primitive: String(entry.runtime.primitive || ""),
    });
  }

  const replacedPointers = new Set(replaced.map((item) => item.pointer));
  return {
    contract: "scoped_state_replacement_v1",
    policy_delta_authorized: policyDeltaAuthorized,
    exact_policy_delta_authorized: exactPolicyDeltaAuthorized,
    authorization_reasons: uniqueSorted(authorizationReasons),
    policy_delta_pointers: deltaPointers,
    exact_authorized_policy_pointers: exactAuthorizedPointers,
    base_state_constraint_count: baseStateCount,
    base_transaction_constraint_count: baseTransactionCount,
    replaced_base_state_constraints: replaced,
    unreplaced_authorized_state_pointers: exactAuthorizedPointers.filter((pointer) => !replacedPointers.has(pointer)),
  };
}
