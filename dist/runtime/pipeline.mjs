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
    if (!quiet && replacedStateConstraintKeys.length)
        console.log(`State obligation plan: replaced ${replacedStateConstraintKeys.length} exact BASE state constraint(s): ${replacedStateConstraintKeys.join(", ")}`);
    const anchorDiagnostics = buildAnchorDiagnostics(facts);
    runPolicyChecks(facts, { report }, { anchorDiagnostics, excludeFamilies: options.excludeRuleFamilies, executionPhase: options.executionPhase, replacedStateConstraintKeys });
    return {
        command: input.mode,
        repositoryRoot: facts.repositoryRoot,
        diff: { changedFiles: facts.diff.files.all.length, checkedFiles: facts.diff.files.checked.length, skippedOperationalFiles: facts.diagnostics.skippedOperationalFiles },
        ...(facts.repositoryObservation ? { repositoryObservation: facts.repositoryObservation } : {}),
        ...(obligationPlan ? { obligationPlan } : {}),
        ...(options.executionPhase ? { executionPhase: options.executionPhase } : {}),
        ...anchorDiagnostics,
    };
}
export function runPolicyPipeline(input, options = {}) {
    const reporter = createAnalysisCollector(input.enforcement, { presenter: options.quiet ? null : createAnalysisTextPresenter() });
    return reporter.finish(evaluatePolicyPipeline(input, options, reporter));
}
