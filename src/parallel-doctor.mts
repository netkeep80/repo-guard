import type { GitHubControlPlaneReadResult } from "./github-control-plane.mjs";
import { readGitHubControlPlane } from "./github-control-plane.mjs";
import { createIntegrationAnalysisReport } from "./integration-validator.mjs";
import type { ParallelControlPlaneNormalizationResult } from "./parallel-control-plane.mjs";
import { normalizeGitHubControlPlane } from "./parallel-control-plane.mjs";
import type {
  ParallelReadinessBlocker,
  ParallelReadinessProvider,
  ParallelReadinessReport,
} from "./parallel-readiness.mjs";
import { evaluateParallelReadiness } from "./parallel-readiness.mjs";

const PARALLEL_PROVIDERS = new Set<ParallelReadinessProvider>(["portable", "github_merge_queue"]);
const PARALLEL_FORMATS = new Set(["text", "json"]);

type ParallelDoctorRoots = Parameters<typeof createIntegrationAnalysisReport>[0];
type ParallelDoctorFormat = "text" | "json";

type ControlPlaneDiagnostic = {
  repository: string | null;
  defaultBranch: string | null;
  adapterErrors: Array<{ id: string; message: string }>;
  normalizationError: { id: string; message: string } | null;
  normalizationEvidence: unknown;
};

export interface ParallelDoctorReport extends ParallelReadinessReport {
  command: "doctor --parallel";
  diagnostics: {
    integrationValid: boolean;
    integrationMessage: string | null;
    controlPlane: ControlPlaneDiagnostic;
  };
}

interface CreateParallelDoctorReportInput {
  provider: ParallelReadinessProvider;
  integrationFacts: unknown;
  integrationValid: boolean;
  integrationMessage?: string | null;
  controlPlaneRead: GitHubControlPlaneReadResult;
}

interface IntegrationReportProjection {
  fatal?: boolean;
  message?: string;
  exitCode?: number;
  integration?: unknown;
}

function option(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
}

function addBlocker(blockers: ParallelReadinessBlocker[], blocker: ParallelReadinessBlocker): void {
  if (!blockers.some((item) => item.id === blocker.id)) blockers.push(blocker);
}

function controlPlaneProjection(
  provider: ParallelReadinessProvider,
  controlPlaneRead: GitHubControlPlaneReadResult,
): {
  facts: unknown;
  diagnostic: ControlPlaneDiagnostic;
} {
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

  const normalized: ParallelControlPlaneNormalizationResult = normalizeGitHubControlPlane({
    provider,
    repository: controlPlaneRead.repository,
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

export function parseParallelProvider(args: string[]): ParallelReadinessProvider {
  const index = args.indexOf("--parallel");
  if (index < 0) throw new Error("--parallel requires a value");
  const value = args[index + 1];
  if (!value || !PARALLEL_PROVIDERS.has(value as ParallelReadinessProvider)) {
    throw new Error(`Unsupported parallel provider: ${value ?? ""}`);
  }
  return value as ParallelReadinessProvider;
}

export function createParallelDoctorReport(input: CreateParallelDoctorReportInput): ParallelDoctorReport {
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
    },
  };
}

export function renderParallelDoctorReport(report: ParallelDoctorReport, format: ParallelDoctorFormat): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  if (format !== "text") throw new Error(`Unsupported parallel doctor format: ${format as string}`);

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
    for (const blocker of report.blockers) lines.push(`  - ${blocker.source}/${blocker.id}: ${blocker.message}`);
  }
  const diagnosticErrors = report.diagnostics.controlPlane.adapterErrors;
  if (diagnosticErrors.length > 0) {
    lines.push("control-plane adapter errors:");
    for (const error of diagnosticErrors) lines.push(`  - ${error.id}: ${error.message}`);
  }
  if (report.diagnostics.controlPlane.normalizationError) {
    const error = report.diagnostics.controlPlane.normalizationError;
    lines.push(`control-plane normalization error: ${error.id}: ${error.message}`);
  }
  if (report.diagnostics.integrationMessage) lines.push(`integration validation: ${report.diagnostics.integrationMessage}`);
  return lines.join("\n");
}

export async function runParallelDoctor(roots: ParallelDoctorRoots, args: string[]): Promise<number> {
  const provider = parseParallelProvider(args);
  const format = option(args, "--format", "text");
  if (!PARALLEL_FORMATS.has(format)) throw new Error(`Unsupported parallel doctor format: ${format}`);

  const integrationReport = createIntegrationAnalysisReport(roots, { format: "json" }) as IntegrationReportProjection;
  const integrationValid = integrationReport.fatal !== true && integrationReport.exitCode === 0;
  const integrationFacts = integrationReport.integration ?? {};
  const integrationMessage = integrationReport.fatal ? integrationReport.message ?? "integration analysis failed" : null;
  const controlPlaneRead = readGitHubControlPlane({ repoRoot: roots.repoRoot, provider });
  const report = createParallelDoctorReport({
    provider,
    integrationFacts,
    integrationValid,
    integrationMessage,
    controlPlaneRead,
  });
  console.log(renderParallelDoctorReport(report, format as ParallelDoctorFormat));
  return report.ready ? 0 : 1;
}
