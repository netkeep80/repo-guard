import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { integrationConstraintEntries } from "../integration-constraints.mjs";
import { evaluatePrimitiveRelation, relationDescriptor, } from "../relation-kernel.mjs";
const CONSTRAINT_PHASES = {
    integration: "state",
};
function requestedExecutionPhase(context) {
    const phase = context.executionPhase ?? "both";
    if (phase !== "transaction" && phase !== "state" && phase !== "both") {
        throw new TypeError("execution phase must be transaction, state, or both");
    }
    return phase;
}
function constraintPhase(constraint) {
    if (constraint.kind === "primitive_relation")
        return constraint.phase ?? relationDescriptor(constraint.primitive || "").phase;
    const phase = CONSTRAINT_PHASES[constraint.kind];
    if (!phase)
        throw new Error(`runtime constraint kind "${constraint.kind}" has no execution phase`);
    return phase;
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
        let check;
        if (constraint.kind === "integration") {
            results.push(...integrationConstraintEntries(facts.integration));
            continue;
        }
        else if (constraint.kind === "primitive_relation") {
            check = advisoryCheck(evaluatePrimitiveRelation(facts, primitiveRelation(constraint)), constraint.advisory);
        }
        else
            throw new Error(`runtime constraint kind "${constraint.kind}" is unsupported`);
        results.push({ name: constraint.name, check });
    }
    return results;
}
export const constraintRuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts, context) };
