import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { evaluatePrimitiveRelation, relationDescriptor, } from "../relation-kernel.mjs";
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
function advisoryCheck(check, advisory) {
    if (!advisory || !check || typeof check !== "object" || Array.isArray(check))
        return check;
    return { ...check, advisory: true };
}
export function evaluateConstraintIR(facts, context = {}) {
    const executionPhase = requestedExecutionPhase(context);
    const { constraints } = compileConstraintIR(facts), results = [];
    for (const constraint of constraints) {
        if (!constraintAppliesToPhase(constraint, executionPhase))
            continue;
        if (constraint.kind !== "primitive_relation")
            throw new Error(`runtime constraint kind "${constraint.kind}" is unsupported`);
        const check = advisoryCheck(evaluatePrimitiveRelation(facts, primitiveRelation(constraint)), constraint.advisory);
        results.push({ name: constraint.name, check });
    }
    return results;
}
export const constraintRuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts, context) };
