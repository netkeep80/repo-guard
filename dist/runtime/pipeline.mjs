import { buildPolicyFacts } from "../facts/input.mjs";
import { runPolicyChecks } from "../checks/orchestrator.mjs";
import { buildAnchorDiagnostics } from "../reporting/anchor-diagnostics.mjs";
import { createAnalysisCollector } from "./analysis-report.mjs";
import { createAnalysisTextPresenter, renderDiffAnalysis, renderEnforcementMode, } from "../reporting/renderers.mjs";
export function runPolicyPipeline(input, options = {}) {
    const quiet = options.quiet || false;
    if (!quiet && options.printEnforcement !== false) {
        console.log(renderEnforcementMode(input.enforcement));
    }
    const reporter = createAnalysisCollector(input.enforcement, {
        presenter: quiet ? null : createAnalysisTextPresenter(),
    });
    const report = (name, check) => reporter.report(`${options.ruleNamePrefix || ""}${name}`, check);
    for (const initialCheck of input.initialChecks || []) {
        report(initialCheck.name, initialCheck.check);
    }
    const { changeIntent = null, changeIntentSource = "none", ...runtimeInput } = input;
    const facts = buildPolicyFacts({
        ...runtimeInput,
        changeIntent,
        changeIntentSource,
    });
    if (!quiet) {
        console.log(`\n${renderDiffAnalysis(facts)}`);
    }
    const anchorDiagnostics = buildAnchorDiagnostics(facts);
    // Префикс меняет только diagnostic namespace; вычисление остаётся в одном canonical
    // pipeline и одном RuleRegistry, чтобы base/head не получили разные semantics engines.
    runPolicyChecks(facts, { report }, {
        anchorDiagnostics,
        excludeFamilies: options.excludeRuleFamilies,
        executionPhase: options.executionPhase,
    });
    return reporter.finish({
        command: input.mode,
        repositoryRoot: facts.repositoryRoot,
        diff: {
            changedFiles: facts.diff.files.all.length,
            checkedFiles: facts.diff.files.checked.length,
            skippedOperationalFiles: facts.diagnostics.skippedOperationalFiles,
        },
        ...(options.executionPhase ? { executionPhase: options.executionPhase } : {}),
        ...anchorDiagnostics,
    });
}
