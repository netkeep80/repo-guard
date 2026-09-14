import { isDeepStrictEqual } from "node:util";
import { compileConstraintProgram } from "./constraint-program.mjs";
import { relationDescriptor } from "./relation-kernel.mjs";
import { checkPolicyRelaxation } from "./rules/policy-delta-rules.mjs";
const list = (value) => Array.isArray(value) ? value : [];
const strings = (value) => list(value).filter((item) => typeof item === "string");
const uniqueSorted = (values) => [...new Set(values)].sort();
function runtimePhase(runtime) {
    if (!runtime || runtime.kind !== "primitive_relation" || typeof runtime.primitive !== "string")
        return null;
    if (runtime.phase === "transaction" || runtime.phase === "state" || runtime.phase === "both")
        return runtime.phase;
    return relationDescriptor(runtime.primitive).phase;
}
function pointerOf(entry) {
    const pointer = entry?.strictness?.pointer;
    return typeof pointer === "string" && pointer ? pointer : null;
}
function changedOnlyByParameters(base, head) {
    return base.kind === "primitive_relation"
        && head.kind === "primitive_relation"
        && base.relation_id === head.relation_id
        && base.primitive === head.primitive
        && isDeepStrictEqual(base.operands, head.operands)
        && !isDeepStrictEqual(base.parameters, head.parameters);
}
function policyDeltaPointers(check) {
    return uniqueSorted(list(check.policy_relaxations)
        .map((item) => item.pointer)
        .filter((pointer) => typeof pointer === "string" && pointer.length > 0));
}
export function buildStateObligationPlan(rawFacts) {
    const facts = (rawFacts || {});
    const basePolicy = facts.basePolicy, headPolicy = facts.headPolicy;
    if (!basePolicy || !headPolicy || !isDeepStrictEqual(facts.policy, basePolicy))
        return null;
    const changedFiles = facts.diff?.files?.checked || [];
    const configuredProtectedSurfaces = basePolicy.policy_delta_rules && typeof basePolicy.policy_delta_rules === "object"
        ? basePolicy.policy_delta_rules.protected_surfaces ?? null
        : null;
    const authorization = checkPolicyRelaxation({
        basePolicy,
        headPolicy,
        changedFiles,
        trustedAuthorizer: facts.trustedAuthorizer,
        governanceGrant: facts.governanceGrant,
        changeIntentType: facts.changeIntent?.change_type ?? null,
        configuredProtectedSurfaces,
    });
    const deltaPointers = policyDeltaPointers(authorization);
    if (!deltaPointers.length)
        return null;
    const grantPointers = new Set(strings(facts.governanceGrant?.allow_policy_relaxation));
    const policyDeltaAuthorized = authorization.ok === true;
    const exactPolicyDeltaAuthorized = policyDeltaAuthorized && deltaPointers.every((pointer) => grantPointers.has(pointer));
    const exactAuthorizedPointers = exactPolicyDeltaAuthorized ? deltaPointers : [];
    const authorizationReasons = strings(authorization.blocked_reasons);
    if (policyDeltaAuthorized && !exactPolicyDeltaAuthorized)
        authorizationReasons.push("state_replacement_requires_exact_policy_delta_pointers");
    const baseProgram = compileConstraintProgram(basePolicy, null);
    const headProgram = new Map(compileConstraintProgram(headPolicy, null).map((entry) => [entry.key, entry]));
    const exactPointerSet = new Set(exactAuthorizedPointers), replaced = [];
    let baseStateCount = 0, baseTransactionCount = 0;
    for (const entry of baseProgram) {
        const phase = runtimePhase(entry.runtime);
        if (phase === "state" || phase === "both")
            baseStateCount++;
        if (phase === "transaction" || phase === "both")
            baseTransactionCount++;
        if (phase !== "state" || !entry.runtime)
            continue;
        const pointer = pointerOf(entry), headEntry = headProgram.get(entry.key), headRuntime = headEntry?.runtime || null;
        if (!pointer || !exactPointerSet.has(pointer) || !headRuntime || runtimePhase(headRuntime) !== "state")
            continue;
        if (pointerOf(headEntry) !== pointer || !changedOnlyByParameters(entry.runtime, headRuntime))
            continue;
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
