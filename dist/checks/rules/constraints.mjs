import { calculateDiffGrowth } from "../../diff/growth.mjs";
import { readFact } from "../../document-facts.mjs";
import { compileConstraintProgram, runtimeConstraints } from "../constraint-program.mjs";
import { checkWorkflowPathCoverage, integrationConstraintEntries } from "../integration-constraints.mjs";
import { evaluatePrimitiveRelation, relationDescriptor, } from "../relation-kernel.mjs";
import { checkTraceRuleResult } from "../trace-rules.mjs";
import { checkChangeProfile } from "./change-profiles.mjs";
import { checkRegistryRules } from "./registry-rules.mjs";
import { checkSizeRules } from "./size-rules.mjs";
const CONSTRAINT_PHASES = {
    surface_debt: "transaction",
    size_rules: "both",
    registry_rules: "state",
    change_profile: "transaction",
    trace_rules: "transaction",
    integration: "state",
    evidence_workflow_path_coverage: "state",
    evidence_anchor_value_coverage: "state",
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
        return relationDescriptor(constraint.primitive || "").phase;
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
export function checkSurfaceDebt(files, debt) {
    const growth = calculateDiffGrowth(files);
    if (growth.new_files <= 0 && growth.net_added_lines <= 0)
        return { ok: true, status: "not_needed", growth };
    if (!debt)
        return { ok: true, status: "undeclared", growth, details: [`new files: ${growth.new_files}`, `net added lines: ${growth.net_added_lines}`] };
    if (!debt.repayment_issue)
        return { ok: false, status: "missing_repayment_target", message: "declared surface debt is missing repayment target: repayment_issue", growth, surface_debt: debt, details: ["missing repayment_issue"], hint: "Set repayment_issue to the issue number where the temporary growth will be repaid." };
    const expected = debt.expected_delta || {}, exceeded = [];
    if (expected.max_new_files !== undefined && growth.new_files > expected.max_new_files)
        exceeded.push(`new files ${growth.new_files} exceeds declared debt ${expected.max_new_files}`);
    if (expected.max_net_added_lines !== undefined && growth.net_added_lines > expected.max_net_added_lines)
        exceeded.push(`net added lines ${growth.net_added_lines} exceeds declared debt ${expected.max_net_added_lines}`);
    return { ok: !exceeded.length, status: exceeded.length ? "declared_debt_exceeded" : "declared", message: exceeded.length ? "declared surface debt is smaller than actual diff growth" : undefined, growth, surface_debt: debt, details: exceeded, hint: exceeded.length ? "Update expected_delta to match intentional temporary growth or reduce the diff." : undefined };
}
export function compileConstraintIR(facts) {
    return { files: facts.diff.files.checked, constraints: runtimeConstraints(compileConstraintProgram(facts.policy, facts.changeIntent)) };
}
function factOperand(facts, ref) {
    if (!ref)
        return { ok: false, error: { code: "document_read_error", pointer: "", message: "fact reference is unavailable" } };
    return readFact(facts, ref);
}
function checkEvidenceWorkflowPathCoverage(facts, constraint) {
    const source = factOperand(facts, constraint.source);
    if (!source.ok)
        return { ok: false, message: `evidence binding "${constraint.binding_id}" could not read repository path references`, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source } };
    if (!Array.isArray(source.value))
        return { ok: false, message: `evidence binding "${constraint.binding_id}" did not produce a repository path set`, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source } };
    const coverage = checkWorkflowPathCoverage(facts.integration, { workflow: constraint.workflow || "", covers: constraint.covers || [] }, source.value);
    return { ...coverage, data: { kind: "workflow_path_coverage", binding_id: constraint.binding_id, source, ...coverage.data } };
}
function checkEvidenceAnchorValueCoverage(facts, constraint) {
    const source = factOperand(facts, constraint.source), target = constraint.target_anchor_type || "";
    if (!source.ok)
        return { ok: false, message: `evidence binding "${constraint.binding_id}" could not read semantic evidence ids`, data: { kind: "anchor_value_coverage", binding_id: constraint.binding_id, target_anchor_type: target, source } };
    if (!Array.isArray(source.value))
        return { ok: false, message: `evidence binding "${constraint.binding_id}" did not produce a string set`, data: { kind: "anchor_value_coverage", binding_id: constraint.binding_id, target_anchor_type: target, source } };
    const byType = facts.anchors?.byType;
    if (!byType)
        return {
            ok: false,
            message: `evidence binding "${constraint.binding_id}" cannot verify ids without anchor facts`,
            data: { kind: "anchor_value_coverage", binding_id: constraint.binding_id, target_anchor_type: target, source, source_values: source.value, missing_values: source.value, anchor_facts_available: false },
        };
    const instances = Array.isArray(byType[target]) ? byType[target] : [], locations = new Map();
    for (const instance of instances) {
        if (typeof instance.value !== "string" || typeof instance.file !== "string")
            continue;
        const location = { file: instance.file };
        if (typeof instance.line === "number")
            location.line = instance.line;
        if (typeof instance.column === "number")
            location.column = instance.column;
        const found = locations.get(instance.value) || [];
        found.push(location);
        locations.set(instance.value, found);
    }
    const sourceValues = source.value, missingValues = sourceValues.filter((value) => !locations.has(value)).sort();
    const evidenceLocations = sourceValues.filter((value) => locations.has(value)).map((value) => ({ value, locations: locations.get(value) }));
    return {
        ok: missingValues.length === 0,
        message: missingValues.length ? `evidence binding "${constraint.binding_id}" has declared ids without evidence anchors` : undefined,
        data: { kind: "anchor_value_coverage", binding_id: constraint.binding_id, target_anchor_type: target, source, source_values: sourceValues, missing_values: missingValues, evidence_locations: evidenceLocations },
    };
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
        if (constraint.kind === "surface_debt")
            check = checkSurfaceDebt(files, constraint.debt);
        else if (constraint.kind === "size_rules") {
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
        else if (constraint.kind === "registry_rules")
            check = checkRegistryRules(constraint.rules, { repoRoot: facts.repositoryRoot, readFile: facts.readFile, documents: facts.documents });
        else if (constraint.kind === "change_profile")
            check = checkChangeProfile(files, facts.policy, facts.changeIntent?.change_type, facts.derived);
        else if (constraint.kind === "trace_rules") {
            for (const trace of context.anchorDiagnostics?.traceRuleResults || [])
                results.push({ name: `trace-rule: ${trace.id}`, check: checkTraceRuleResult(trace) });
            continue;
        }
        else if (constraint.kind === "integration") {
            results.push(...integrationConstraintEntries(facts.integration));
            continue;
        }
        else if (constraint.kind === "primitive_relation")
            check = evaluatePrimitiveRelation(facts, primitiveRelation(constraint));
        else if (constraint.kind === "evidence_workflow_path_coverage")
            check = checkEvidenceWorkflowPathCoverage(facts, constraint);
        else if (constraint.kind === "evidence_anchor_value_coverage")
            check = checkEvidenceAnchorValueCoverage(facts, constraint);
        else
            throw new Error(`runtime constraint kind "${constraint.kind}" is unsupported`);
        results.push({ name: constraint.name, check });
    }
    return results;
}
export const constraintRuleFamily = { id: "constraints", evaluate: (facts, context) => evaluateConstraintIR(facts, context) };
