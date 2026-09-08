import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { integrationConstraintEntries } from "../integration-constraints.mjs";
import { evaluatePrimitiveRelation, relationDescriptor, } from "../relation-kernel.mjs";
import { checkSizeRules } from "./size-rules.mjs";
const CONSTRAINT_PHASES = {
    size_rules: "both",
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
function projectSizeRules(rules, requested) {
    if (requested === "both")
        return rules;
    return rules.flatMap((rule) => {
        const transactionBound = rule.count === "changed_only" || rule.applies_to_change_types !== undefined;
        if (requested === "state") {
            if (transactionBound || rule.max === undefined)
                return [];
            return [{ ...rule, max_growth: undefined }];
        }
        if (transactionBound)
            return [rule];
        if (rule.max_growth === undefined)
            return [];
        return [{ ...rule, max: undefined }];
    });
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
export function evaluateConstraintIR(facts, context = {}) {
    const executionPhase = requestedExecutionPhase(context);
    const { files, constraints } = compileConstraintIR(facts), results = [];
    for (const constraint of constraints) {
        if (!constraintAppliesToPhase(constraint, executionPhase))
            continue;
        let check;
        if (constraint.kind === "size_rules") {
            const rules = projectSizeRules(constraint.rules, executionPhase);
            if (!rules.length)
                continue;
            const result = checkSizeRules(files, rules, {
                repoRoot: facts.repositoryRoot, trackedFiles: facts.trackedFiles, readFile: facts.readFile,
                ignorePatterns: facts.policy.paths.operational_paths, changeType: facts.changeIntent?.change_type,
            });
            results.push({ name: constraint.name, check: result });
            if (result.advisory_violations.length)
                results.push({ name: "size-rules-advisory", check: { ok: false, advisory: true, size_violations: result.advisory_violations, details: result.advisory_details, growth: result.growth } });
            continue;
        }
        else if (constraint.kind === "integration") {
            results.push(...integrationConstraintEntries(facts.integration));
            continue;
        }
        else if (constraint.kind === "primitive_relation")
            check = evaluatePrimitiveRelation(facts, primitiveRelation(constraint));
        else
            throw new Error(`runtime constraint kind "${constraint.kind}" is unsupported`);
        results.push({ name: constraint.name, check });
    }
    return results;
}
export const constraintRuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts, context) };
