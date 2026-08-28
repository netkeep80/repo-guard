import { readGitHubControlPlane } from "./github-control-plane.mjs";
import { analyzeBranchHygiene } from "./branch-hygiene.mjs";
import { createIntegrationAnalysisReport } from "./integration-validator.mjs";
import { normalizeGitHubControlPlane } from "./parallel-control-plane.mjs";
import { evaluateParallelReadiness } from "./parallel-readiness.mjs";
const PARALLEL_PROVIDERS = new Set(["portable", "github_merge_queue"]);
const PARALLEL_FORMATS = new Set(["text", "json"]);
function option(args, name, fallback) {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1] ?? fallback;
}
function options(args, name) {
    const values = [];
    for (let index = 0; index < args.length; index++) {
        if (args[index] === name && args[index + 1] !== undefined)
            values.push(args[index + 1]);
    }
    return values;
}
function addBlocker(blockers, blocker) {
    if (!blockers.some((item) => item.id === blocker.id))
        blockers.push(blocker);
}
function controlPlaneProjection(provider, controlPlaneRead) {
    if (!controlPlaneRead.ok) {
        return {
            facts: {},
            diagnostic: {
                repository: null,
                defaultBranch: null,
                adapterErrors: [{ id: controlPlaneRead.error, message: controlPlaneRead.message }],
                normalizationError: null,
                normalizationEvidence: null,
            },
        };
    }
    const normalized = normalizeGitHubControlPlane({
        provider,
        repository: controlPlaneRead.repository,
        repositoryOwnerType: controlPlaneRead.repositoryOwnerType,
        defaultBranch: controlPlaneRead.defaultBranch,
        branchProtection: controlPlaneRead.branchProtection,
        activeBranchRules: controlPlaneRead.activeBranchRules,
        rulesets: controlPlaneRead.rulesets,
    });
    return normalized.ok
        ? {
            facts: normalized.facts,
            diagnostic: {
                repository: controlPlaneRead.repository,
                defaultBranch: controlPlaneRead.defaultBranch,
                adapterErrors: controlPlaneRead.errors,
                normalizationError: null,
                normalizationEvidence: normalized.evidence,
            },
        }
        : {
            facts: {},
            diagnostic: {
                repository: controlPlaneRead.repository,
                defaultBranch: controlPlaneRead.defaultBranch,
                adapterErrors: controlPlaneRead.errors,
                normalizationError: { id: normalized.error, message: normalized.message },
                normalizationEvidence: null,
            },
        };
}
function branchHygieneProjection(input) {
    const read = input.controlPlaneRead;
    if (!read.ok || read.branchInventory == null || read.openSameRepositoryPullRequestHeads == null
        || read.mergedSameRepositoryPullRequestHeads == null)
        return null;
    return analyzeBranchHygiene({
        defaultBranch: read.defaultBranch,
        deleteBranchOnMerge: read.deleteBranchOnMerge,
        branchInventory: read.branchInventory,
        openSameRepositoryPullRequestHeads: read.openSameRepositoryPullRequestHeads,
        mergedSameRepositoryPullRequestHeads: read.mergedSameRepositoryPullRequestHeads,
        persistentBranches: input.persistentBranches ?? [],
        durableOwnership: input.durableOwnership,
    });
}
export function parseParallelProvider(args) {
    const index = args.indexOf("--parallel");
    if (index < 0)
        throw new Error("--parallel requires a value");
    const value = args[index + 1];
    if (!value || !PARALLEL_PROVIDERS.has(value)) {
        throw new Error(`Unsupported parallel provider: ${value ?? ""}`);
    }
    return value;
}
export function createParallelDoctorReport(input) {
    const controlPlane = controlPlaneProjection(input.provider, input.controlPlaneRead);
    const readiness = evaluateParallelReadiness({
        provider: input.provider,
        integrationFacts: input.integrationFacts,
        controlPlaneFacts: controlPlane.facts,
    });
    const blockers = [...readiness.blockers];
    if (!input.integrationValid) {
        addBlocker(blockers, {
            id: "repository_validation_failed",
            source: "repository",
            message: "repository policy/integration validation failed",
        });
    }
    blockers.sort((left, right) => left.id.localeCompare(right.id));
    return {
        command: "doctor --parallel",
        provider: readiness.provider,
        ready: blockers.length === 0,
        blockers,
        evidence: readiness.evidence,
        diagnostics: {
            integrationValid: input.integrationValid,
            integrationMessage: input.integrationMessage ?? null,
            controlPlane: controlPlane.diagnostic,
            branchHygiene: branchHygieneProjection(input),
        },
    };
}
export function renderParallelDoctorReport(report, format) {
    if (format === "json")
        return JSON.stringify(report, null, 2);
    if (format !== "text")
        throw new Error(`Unsupported parallel doctor format: ${format}`);
    const transactionWorkflow = report.evidence.repository.transactionWorkflow ?? "unknown";
    const providerWorkflow = report.evidence.repository.providerWorkflow ?? "unknown";
    const targetBranch = report.evidence.control_plane.targetBranch ?? "unknown";
    const requiredChecks = report.evidence.control_plane.requiredChecks?.join(", ") ?? "unknown";
    const lines = [
        `repo-guard doctor --parallel ${report.provider}`,
        "",
        report.ready ? "READY" : "NOT READY",
        `transaction workflow: ${transactionWorkflow}`,
        `provider workflow: ${providerWorkflow}`,
        `target branch: ${targetBranch}`,
        `required checks: ${requiredChecks}`,
    ];
    if (report.blockers.length > 0) {
        lines.push("blockers:");
        for (const blocker of report.blockers)
            lines.push(`  - ${blocker.source}/${blocker.id}: ${blocker.message}`);
    }
    const branchHygiene = report.diagnostics.branchHygiene;
    if (branchHygiene) {
        if (branchHygiene.ok) {
            lines.push("branch hygiene: advisory");
            lines.push(`persistent branches: ${branchHygiene.persistentBranches.map((branch) => branch.name).join(", ") || "none"}`);
            lines.push(`merged PR heads still present: ${branchHygiene.mergedPullRequestHeadsStillPresent.map((head) => head.name).join(", ") || "none"}`);
            lines.push(`orphan candidates: ${branchHygiene.orphanCandidates.map((branch) => branch.name).join(", ") || "none"}`);
            lines.push(`delete_branch_on_merge: ${branchHygiene.deleteBranchOnMergeDrift.state}`);
        }
        else {
            lines.push(`branch hygiene: unavailable (${branchHygiene.error}: ${branchHygiene.message})`);
        }
    }
    const diagnosticErrors = report.diagnostics.controlPlane.adapterErrors;
    if (diagnosticErrors.length > 0) {
        lines.push("control-plane adapter errors:");
        for (const error of diagnosticErrors)
            lines.push(`  - ${error.id}: ${error.message}`);
    }
    if (report.diagnostics.controlPlane.normalizationError) {
        const error = report.diagnostics.controlPlane.normalizationError;
        lines.push(`control-plane normalization error: ${error.id}: ${error.message}`);
    }
    if (report.diagnostics.integrationMessage)
        lines.push(`integration validation: ${report.diagnostics.integrationMessage}`);
    return lines.join("\n");
}
export async function runParallelDoctor(roots, args) {
    const provider = parseParallelProvider(args);
    const format = option(args, "--format", "text");
    if (!PARALLEL_FORMATS.has(format))
        throw new Error(`Unsupported parallel doctor format: ${format}`);
    const integrationReport = createIntegrationAnalysisReport(roots, { format: "json" });
    const integrationValid = integrationReport.fatal !== true && integrationReport.exitCode === 0;
    const integrationFacts = integrationReport.integration ?? {};
    const integrationMessage = integrationReport.fatal ? integrationReport.message ?? "integration analysis failed" : null;
    const controlPlaneRead = readGitHubControlPlane({ repoRoot: roots.repoRoot, provider, includeBranchHygiene: true });
    const report = createParallelDoctorReport({
        provider,
        integrationFacts,
        integrationValid,
        integrationMessage,
        controlPlaneRead,
        persistentBranches: options(args, "--persistent-branch"),
    });
    console.log(renderParallelDoctorReport(report, format));
    return report.ready ? 0 : 1;
}
