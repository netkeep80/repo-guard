import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { evaluatePrimitiveRelation, relationDescriptor, } from "../relation-kernel.mjs";
const BUDGET_EVIDENCE_FIELDS = ["policy_limit", "intent_limit", "effective_limit"];
function sizeGrowthAuthorization(facts) {
    const grantContainer = facts.governanceGrant;
    const grant = grantContainer && typeof grantContainer === "object" && !Array.isArray(grantContainer)
        ? grantContainer.size_rule_growth : null;
    if (grant === null || grant === undefined)
        return { present: false, ok: true, limits: {}, reasons: [] };
    const reasons = [], limits = {};
    const value = grant && typeof grant === "object" && !Array.isArray(grant) ? grant : {};
    const trusted = facts.trustedAuthorizer;
    if (facts.mode !== "check-pr" || !trusted || trusted.trusted !== true || trusted.source !== "repository_permission")
        reasons.push("growth_authorizer_untrusted");
    const sha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/i.test(v);
    if (!sha(value.base_sha) || !sha(value.head_sha) || value.base_sha !== facts.baseRef || value.head_sha !== facts.headRef)
        reasons.push("growth_snapshot_mismatch");
    const entries = value.limits, seen = new Set();
    const rules = Array.isArray(facts.policy.size_rules) ? facts.policy.size_rules : [];
    if (!Array.isArray(entries) || !entries.length)
        reasons.push("growth_limits_missing");
    else
        for (const entry of entries) {
            const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
            const id = item.rule_id;
            if (typeof id !== "string" || !id || seen.has(id)) {
                reasons.push("growth_rule_duplicate_or_invalid");
                continue;
            }
            seen.add(id);
            const matches = rules.filter((rule) => rule.id === id);
            if (matches.length !== 1) {
                reasons.push(`growth_rule_unknown_or_ambiguous:${id}`);
                continue;
            }
            const rule = matches[0];
            if (rule.scope !== "directory" || !["lines", "files"].includes(String(rule.metric)) || (rule.count && rule.count !== "all_tracked") || rule.level === "advisory" || !Number.isInteger(rule.max_growth) || !Number.isInteger(rule.max)) {
                reasons.push(`growth_rule_ineligible:${id}`);
                continue;
            }
            if (Array.isArray(rule.applies_to_change_types) && !rule.applies_to_change_types.includes(facts.changeIntent?.change_type ?? "")) {
                reasons.push(`growth_rule_not_applicable:${id}`);
                continue;
            }
            if (!Number.isInteger(item.max_growth) || item.max_growth <= rule.max_growth || item.max_growth > rule.max) {
                reasons.push(`growth_limit_invalid:${id}`);
                continue;
            }
            limits[id] = item.max_growth;
        }
    return { present: true, ok: reasons.length === 0, limits: reasons.length ? {} : limits, reasons };
}
function requestedExecutionPhase(context) {
    const phase = context.executionPhase ?? "both";
    if (phase !== "transaction" && phase !== "state" && phase !== "both") {
        throw new TypeError("execution phase must be transaction, state, or both");
    }
    return phase;
}
function constraintPhase(constraint) {
    if (constraint.kind !== "primitive_relation")
        throw new Error(`runtime constraint kind "${constraint.kind}" is unsupported`);
    return constraint.phase ?? relationDescriptor(constraint.primitive || "").phase;
}
function constraintAppliesToPhase(constraint, requested) {
    const phase = constraintPhase(constraint);
    return requested === "both" || phase === "both" || phase === requested;
}
export function compileConstraintIR(facts) {
    return { constraints: runtimeConstraints(compileConstraintProgram(facts.policy, facts.changeIntent, { authorizedGrowth: sizeGrowthAuthorization(facts).limits })) };
}
function primitiveRelation(constraint) {
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
function withConstraintEvidence(check, constraint) {
    if (!check || typeof check !== "object" || Array.isArray(check))
        return check;
    const parameters = constraint.parameters || {};
    const budget = Object.fromEntries(BUDGET_EVIDENCE_FIELDS.flatMap((field) => Object.hasOwn(parameters, field) ? [[field, parameters[field]]] : []));
    const relation = { relation_id: constraint.relation_id, kind: constraint.primitive, operands: constraint.operands };
    const record = check;
    const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
    return { ...record, ...budget, data: { ...data, ...relation, ...budget } };
}
function advisoryCheck(check, advisory) {
    if (!advisory || !check || typeof check !== "object" || Array.isArray(check))
        return check;
    return { ...check, advisory: true };
}
export function evaluateConstraintIR(facts, context = {}) {
    const executionPhase = requestedExecutionPhase(context);
    const replacedStateConstraints = new Set(context.replacedStateConstraintKeys || []);
    const satisfiedTransactionConstraints = new Set(context.satisfiedTransactionConstraintKeys || []);
    const authorization = sizeGrowthAuthorization(facts);
    const { constraints } = compileConstraintIR(facts), results = [];
    if (authorization.present)
        results.push({ name: "size-rule-growth-authorization", check: { ok: authorization.ok, message: authorization.ok ? "exact trusted growth exception authorized" : "size rule growth exception rejected", details: authorization.reasons, data: { base_sha: facts.baseRef, head_sha: facts.headRef, effective_limits: authorization.limits } } });
    for (const constraint of constraints) {
        if (!constraintAppliesToPhase(constraint, executionPhase))
            continue;
        if (replacedStateConstraints.has(constraint.key) && constraintPhase(constraint) === "state")
            continue;
        if (satisfiedTransactionConstraints.has(constraint.key) && constraintPhase(constraint) === "transaction")
            continue;
        if (constraint.kind !== "primitive_relation")
            throw new Error(`runtime constraint kind "${constraint.kind}" is unsupported`);
        const evaluated = evaluatePrimitiveRelation(facts, primitiveRelation(constraint));
        const check = advisoryCheck(withConstraintEvidence(evaluated, constraint), constraint.advisory);
        results.push({ name: constraint.name, check });
    }
    return results;
}
export const constraintRuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts, context) };
