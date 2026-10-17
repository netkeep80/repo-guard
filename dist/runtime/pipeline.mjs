import { buildPolicyFacts } from "../facts/input.mjs";
import { runPolicyChecks } from "../checks/orchestrator.mjs";
import { buildStateObligationPlan } from "../checks/state-obligation-plan.mjs";
import { compileChangeProfiles } from "../policy-compiler.mjs";
import { buildAnchorDiagnostics } from "../reporting/anchor-diagnostics.mjs";
import { createAnalysisCollector } from "./analysis-report.mjs";
import { createAnalysisTextPresenter, renderDiffAnalysis, renderEnforcementMode } from "../reporting/renderers.mjs";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export function evaluatePolicyPipeline(input, options, reporter) {
    const quiet = options.quiet || false, origin = options.policyOrigin || "shared", evidence = { policyOrigin: origin, enforcementMode: input.enforcement.mode };
    if (!quiet && options.printEnforcement !== false)
        console.log(renderEnforcementMode(input.enforcement));
    const report = (name, check) => reporter.report(`${options.ruleNamePrefix || ""}${name}`, check, evidence);
    for (const initialCheck of input.initialChecks || [])
        report(initialCheck.name, initialCheck.check);
    if (options.executionPhase !== "state") {
        const errors = compileChangeProfiles(input.policy, object(input.changeIntent).change_type ?? null);
        if (errors.length)
            report("change-profile-selection", { ok: false, message: "change profile selection compilation failed", details: errors.map((error) => error.message) });
    }
    const { changeIntent = null, changeIntentSource = "none", ...runtimeInput } = input;
    const facts = buildPolicyFacts({ ...runtimeInput, changeIntent, changeIntentSource });
    if (!quiet)
        console.log(`\n${renderDiffAnalysis(facts)}`);
    const obligationPlan = buildStateObligationPlan(facts), replacedStateConstraintKeys = obligationPlan?.replaced_base_state_constraints.map((item) => item.key) || [];
    const satisfiedTransactionConstraintKeys = [...new Set(options.satisfiedTransactionConstraintKeys || [])];
    if (!quiet && replacedStateConstraintKeys.length)
        console.log(`State obligation plan: replaced ${replacedStateConstraintKeys.length} exact BASE state constraint(s): ${replacedStateConstraintKeys.join(", ")}`);
    const anchorDiagnostics = buildAnchorDiagnostics(facts);
    runPolicyChecks(facts, { report }, { anchorDiagnostics, excludeFamilies: options.excludeRuleFamilies, executionPhase: options.executionPhase, replacedStateConstraintKeys, satisfiedTransactionConstraintKeys });
    options.shadowObservation?.(facts);
    return {
        command: input.mode,
        repositoryRoot: facts.repositoryRoot,
        diff: { changedFiles: facts.diff.files.all.length, checkedFiles: facts.diff.files.checked.length, skippedOperationalFiles: facts.diagnostics.skippedOperationalFiles },
        ...(facts.repositoryObservation ? { repositoryObservation: facts.repositoryObservation } : {}),
        ...(obligationPlan ? { obligationPlan } : {}),
        ...(options.executionPhase ? { executionPhase: options.executionPhase } : {}),
        ...(satisfiedTransactionConstraintKeys.length ? { satisfiedTransactionConstraintKeys } : {}),
        ...anchorDiagnostics,
    };
}
export function runPolicyPipeline(input, options = {}) {
    const reporter = createAnalysisCollector(input.enforcement, { presenter: options.quiet ? null : createAnalysisTextPresenter() });
    return reporter.finish(evaluatePolicyPipeline(input, options, reporter));
}
/**
 * I0-only non-authoritative shadow seam. Both evaluations receive the same
 * normalized observation, produced once by the existing pipeline.
 * The legacy report is completed before invoking candidate code.
 * No CLI, policy or production enforcement path calls this by default.
 */
export function runPolicyPipelineShadow(input, options, candidate, expectedIntentionalDifference = false) {
    let observed;
    const reporter = createAnalysisCollector(input.enforcement, { presenter: options.quiet ? null : createAnalysisTextPresenter() });
    const metadata = evaluatePolicyPipeline(input, { ...options, shadowObservation: (facts) => { observed = facts; } }, reporter);
    const legacy = reporter.finish(metadata);
    if (!observed)
        throw new Error("I0: exact normalized observation was not captured");
    const legacyVerdict = { ok: legacy.ok, blocking: legacy.exitCode !== 0 };
    let candidateVerdict;
    try {
        const result = candidate(observed);
        if (typeof result?.ok !== "boolean")
            throw new Error("shadow candidate omitted boolean verdict");
        candidateVerdict = { ok: result.ok, reasons: [...new Set(result.reasons || [])].sort() };
    }
    catch (error) {
        candidateVerdict = { ok: false, reasons: ["SHADOW_EXECUTION_ERROR:" + (error instanceof Error ? error.message : String(error))] };
    }
    const identical = legacyVerdict.ok === candidateVerdict.ok;
    const classification = identical
        ? "EQUIVALENT"
        : expectedIntentionalDifference
            ? "EXPECTED_INTENTIONAL_DIFFERENCE"
            : "UNEXPECTED_DIFFERENCE";
    return {
        legacy,
        comparison: {
            legacy: legacyVerdict,
            candidate: candidateVerdict,
            identical,
            classification,
        },
    };
}
