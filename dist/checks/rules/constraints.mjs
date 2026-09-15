import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { evaluatePrimitiveRelation, relationDescriptor, } from "../relation-kernel.mjs";
const BUDGET_EVIDENCE_FIELDS = ["policy_limit", "intent_limit", "effective_limit"];
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
    return { files: facts.diff.files.checked, constraints: runtimeConstraints(compileConstraintProgram(facts.policy, facts.changeIntent)) };
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
    const { constraints } = compileConstraintIR(facts), results = [];
    for (const constraint of constraints) {
        if (!constraintAppliesToPhase(constraint, executionPhase))
            continue;
        if (replacedStateConstraints.has(constraint.key) && constraintPhase(constraint) === "state")
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
