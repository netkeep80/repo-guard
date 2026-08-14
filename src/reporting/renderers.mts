type PresenterOutcome = "pass" | "warning" | "violation";
interface PresenterCheck {
  rule: string;
  details?: string[];
}
interface PresenterEvent {
  check: PresenterCheck;
  mode: unknown;
  outcome: PresenterOutcome;
}
interface AnchorLocation {
  file: string;
  line?: number;
  column?: number;
}
interface UnresolvedAnchor {
  rule: string;
  fromAnchorType?: string;
  toAnchorType?: string;
  value: string;
  instances: AnchorLocation[];
}
interface ResultEntry {
  rule: string;
  details?: string[];
}
interface HintEntry {
  rule: string;
  message: unknown;
}
interface IntegrationCounts {
  workflows: number;
  templates: number;
  docs: number;
  profiles: number;
  errors?: number;
}
interface ReportProjection {
  command?: string | null;
  mode: string;
  result: string;
  repositoryRoot: string;
  passed: number;
  failed: number;
  violationCount: number;
  warnings: number;
  exitCode: number;
  violations: ResultEntry[];
  advisoryWarnings: ResultEntry[];
  hints: HintEntry[];
  diff?: {
    changedFiles: number;
    skippedOperationalFiles?: number;
  };
  anchors?: {
    stats: {
      detected: number;
      changed: number;
      declaredByChangeIntent: number;
      unresolved: number;
    };
    unresolved: UnresolvedAnchor[];
  };
  diagnostics?: {
    declared: IntegrationCounts;
    extracted: IntegrationCounts & { errors: number };
  };
}
interface MarkdownSummaryOptions {
  title: string;
  countLabel: string;
  violationLabel: string;
  violationFallback: string;
  extraLines?: (report: ReportProjection) => string[];
}
interface AnalysisRenderOptions {
  format?: string;
  summary?: string;
}

function writeViolation(mode: unknown, message: string) {
  if (mode === "advisory") {
    console.warn(message);
  } else {
    console.error(message);
  }
}

function printCheckDetails(mode: unknown, check: PresenterCheck) {
  const write = (message: string) => writeViolation(mode, message);
  for (const detail of check.details || []) write(`    ${detail}`);
}

function renderMarkdownTableCell(value: unknown) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function formatAnchorLocation(instance: AnchorLocation) {
  const line = instance.line ? `:${instance.line}` : "";
  const column = instance.column ? `:${instance.column}` : "";
  return `${instance.file}${line}${column}`;
}

export function renderEnforcementMode(enforcement: { mode?: unknown }) {
  if (enforcement.mode === "advisory") {
    return "Enforcement mode: advisory (policy violations are reported as warnings; exit code remains 0)";
  }
  return "Enforcement mode: blocking (policy violations are enforced; exit code is 1 when violations exist)";
}

export function renderDiffAnalysis(facts: { diagnostics: { skippedOperationalFiles: number }; diff: { files: { all: unknown[] } } }) {
  const skipped = facts.diagnostics.skippedOperationalFiles;
  return `Diff analysis: ${facts.diff.files.all.length} file(s) changed${skipped ? ` (${skipped} operational skipped)` : ""}`;
}

export function createAnalysisTextPresenter() {
  return {
    check({ check, mode, outcome }: PresenterEvent) {
      if (outcome === "pass") {
        console.log(`  PASS: ${check.rule}`);
        return;
      }

      if (outcome === "warning") {
        writeViolation("advisory", `  WARN: ${check.rule}`);
        printCheckDetails("advisory", check);
        return;
      }

      const label = mode === "advisory" ? "WARN" : "FAIL";
      writeViolation(mode, `  ${label}: ${check.rule}`);
      printCheckDetails(mode, check);
    },

    finish(report: unknown) {
      const advisoryPart = (report as ReportProjection).mode === "advisory" ? `, ${(report as ReportProjection).violationCount} advisory violation(s)` : "";
      const modePart = (report as ReportProjection).mode === "advisory" ? "violations reported as warnings" : "violations enforced";
      const warningPart = (report as ReportProjection).warnings > 0 ? `, ${(report as ReportProjection).warnings} warning(s)` : "";

      console.log(`\nSummary: ${(report as ReportProjection).passed} passed, ${(report as ReportProjection).failed} failed${advisoryPart}${warningPart} (mode: ${(report as ReportProjection).mode}; ${modePart})`);
      console.log(`Result: ${(report as ReportProjection).result} (mode: ${(report as ReportProjection).mode}; exit code ${(report as ReportProjection).exitCode})`);
    },
  };
}

function renderCountLine(report: ReportProjection, label: string) {
  return `- ${label}: ${report.passed} passed, ${report.failed} failed${report.mode === "advisory" ? `, ${report.violationCount} advisory violation(s)` : ""}${report.warnings ? `, ${report.warnings} warning(s)` : ""}`;
}

function renderCheckExtraLines(report: ReportProjection) {
  const lines: string[] = [];

  if (report.diff) {
    lines.push(`- Diff: ${report.diff.changedFiles} file(s) changed${report.diff.skippedOperationalFiles ? `, ${report.diff.skippedOperationalFiles} operational skipped` : ""}`);
  }

  if (report.anchors) {
    const stats = report.anchors.stats;
    lines.push(`- Anchors: ${stats.detected} detected, ${stats.changed} changed, ${stats.declaredByChangeIntent} declared, ${stats.unresolved} unresolved`);

    if (report.anchors.unresolved.length > 0) {
      lines.push("", "| Trace rule | Anchor | Locations |", "|---|---|---|");
      for (const unresolved of report.anchors.unresolved.slice(0, 10)) {
        const anchor = `${unresolved.fromAnchorType} -> ${unresolved.toAnchorType}: ${unresolved.value}`;
        const locations = unresolved.instances.map(formatAnchorLocation).join(", ");
        lines.push(`| ${renderMarkdownTableCell(unresolved.rule)} | ${renderMarkdownTableCell(anchor)} | ${renderMarkdownTableCell(locations)} |`);
      }
      if (report.anchors.unresolved.length > 10) {
        lines.push(`| ... | ... | ${report.anchors.unresolved.length - 10} more unresolved anchor(s) |`);
      }
    }
  }

  return lines;
}

function renderIntegrationExtraLines(report: ReportProjection) {
  const declared = report.diagnostics!.declared;
  const extracted = report.diagnostics!.extracted;
  return [
    `- Declared: ${declared.workflows} workflow(s), ${declared.templates} template(s), ${declared.docs} doc(s), ${declared.profiles} profile(s)`,
    `- Extracted: ${extracted.workflows} workflow(s), ${extracted.templates} template(s), ${extracted.docs} doc(s), ${extracted.profiles} profile(s), ${extracted.errors} artifact error(s)`,
  ];
}

function renderResultTable(lines: string[], heading: string, entries: ResultEntry[] | null | undefined, fallback: string) {
  if (!entries || entries.length === 0) return;

  lines.push("", `| ${heading} | Details |`, "|---|---|");
  for (const entry of entries) {
    const details = (entry.details || []).join("<br>") || fallback;
    lines.push(`| ${renderMarkdownTableCell(entry.rule)} | ${renderMarkdownTableCell(details)} |`);
  }
}

function renderMarkdownSummary(report: ReportProjection, {
  title,
  countLabel,
  violationLabel,
  violationFallback,
  extraLines = () => [],
}: MarkdownSummaryOptions) {
  const lines = [
    `## ${title}`,
    "",
    `- Result: ${report.result}`,
    `- Mode: ${report.mode}`,
    `- Repository root: \`${report.repositoryRoot}\``,
    renderCountLine(report, countLabel),
    ...extraLines(report),
  ];

  renderResultTable(lines, violationLabel, report.violations, violationFallback);
  renderResultTable(lines, "Advisory", report.advisoryWarnings, "Warning reported");

  if (report.hints.length > 0) {
    lines.push("", "### Hints");
    for (const hint of report.hints) {
      lines.push(`- ${hint.rule}: ${hint.message as string}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderCheckSummary(report: unknown) {
  return renderMarkdownSummary(report as ReportProjection, {
    title: "repo-guard summary",
    countLabel: "Checks",
    violationLabel: "Rule",
    violationFallback: "Violation reported",
    extraLines: renderCheckExtraLines,
  });
}

export function renderIntegrationSummary(report: unknown) {
  return renderMarkdownSummary(report as ReportProjection, {
    title: "repo-guard integration summary",
    countLabel: "Diagnostics",
    violationLabel: "Diagnostic",
    violationFallback: "Diagnostic reported",
    extraLines: renderIntegrationExtraLines,
  });
}

export function renderAnalysisReport(report: unknown, { format, summary }: AnalysisRenderOptions = {}) {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (format === "summary") {
    const summaryKind = summary || ((report as ReportProjection).command === "validate-integration" ? "integration" : "check");
    return summaryKind === "integration"
      ? renderIntegrationSummary(report)
      : renderCheckSummary(report);
  }
  return null;
}
