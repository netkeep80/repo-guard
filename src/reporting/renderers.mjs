import { detailFromCheck } from "../runtime/analysis-report.mjs";

function writeViolation(mode, message) {
  if (mode === "advisory") {
    console.warn(message);
  } else {
    console.error(message);
  }
}

function printCheckDetails(mode, check) {
  const write = (message) => writeViolation(mode, message);
  for (const detail of detailFromCheck(check)) write(`    ${detail}`);
}

function renderMarkdownTableCell(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function formatAnchorLocation(instance) {
  const line = instance.line ? `:${instance.line}` : "";
  const column = instance.column ? `:${instance.column}` : "";
  return `${instance.file}${line}${column}`;
}

export function renderEnforcementMode(enforcement) {
  if (enforcement.mode === "advisory") {
    return "Enforcement mode: advisory (policy violations are reported as warnings; exit code remains 0)";
  }
  return "Enforcement mode: blocking (policy violations are enforced; exit code is 1 when violations exist)";
}

export function renderDiffAnalysis(facts) {
  const skipped = facts.diagnostics.skippedOperationalFiles;
  return `Diff analysis: ${facts.diff.files.all.length} file(s) changed${skipped ? ` (${skipped} operational skipped)` : ""}`;
}

export function createAnalysisTextPresenter() {
  return {
    check({ name, check, mode, outcome }) {
      if (outcome === "pass") {
        console.log(`  PASS: ${name}`);
        return;
      }

      if (outcome === "warning") {
        writeViolation("advisory", `  WARN: ${name}`);
        printCheckDetails("advisory", check);
        return;
      }

      const label = mode === "advisory" ? "WARN" : "FAIL";
      writeViolation(mode, `  ${label}: ${name}`);
      printCheckDetails(mode, check);
    },

    finish(report) {
      const advisoryPart = report.mode === "advisory" ? `, ${report.violationCount} advisory violation(s)` : "";
      const modePart = report.mode === "advisory" ? "violations reported as warnings" : "violations enforced";
      const warningPart = report.warnings > 0 ? `, ${report.warnings} warning(s)` : "";

      console.log(`\nSummary: ${report.passed} passed, ${report.failed} failed${advisoryPart}${warningPart} (mode: ${report.mode}; ${modePart})`);
      console.log(`Result: ${report.result} (mode: ${report.mode}; exit code ${report.exitCode})`);
    },
  };
}

export function renderCheckSummary(result) {
  const lines = [
    "## repo-guard summary",
    "",
    `- Result: ${result.result}`,
    `- Mode: ${result.mode}`,
    `- Repository root: \`${result.repositoryRoot}\``,
    `- Checks: ${result.passed} passed, ${result.failed} failed${result.mode === "advisory" ? `, ${result.violationCount} advisory violation(s)` : ""}${result.warnings ? `, ${result.warnings} warning(s)` : ""}`,
  ];

  if (result.diff) {
    lines.push(`- Diff: ${result.diff.changedFiles} file(s) changed${result.diff.skippedOperationalFiles ? `, ${result.diff.skippedOperationalFiles} operational skipped` : ""}`);
  }

  if (result.anchors) {
    const stats = result.anchors.stats;
    lines.push(`- Anchors: ${stats.detected} detected, ${stats.changed} changed, ${stats.declaredByContract} declared, ${stats.unresolved} unresolved`);

    if (result.anchors.unresolved.length > 0) {
      lines.push("", "| Trace rule | Anchor | Locations |", "|---|---|---|");
      for (const unresolved of result.anchors.unresolved.slice(0, 10)) {
        const anchor = `${unresolved.fromAnchorType} -> ${unresolved.toAnchorType}: ${unresolved.value}`;
        const locations = unresolved.instances.map(formatAnchorLocation).join(", ");
        lines.push(`| ${renderMarkdownTableCell(unresolved.rule)} | ${renderMarkdownTableCell(anchor)} | ${renderMarkdownTableCell(locations)} |`);
      }
      if (result.anchors.unresolved.length > 10) {
        lines.push(`| ... | ... | ${result.anchors.unresolved.length - 10} more unresolved anchor(s) |`);
      }
    }
  }

  if (result.violations.length > 0) {
    lines.push("", "| Rule | Details |", "|---|---|");
    for (const violation of result.violations) {
      const details = detailFromCheck(violation).join("<br>") || "Violation reported";
      lines.push(`| ${renderMarkdownTableCell(violation.rule)} | ${renderMarkdownTableCell(details)} |`);
    }
  }

  if (result.advisoryWarnings && result.advisoryWarnings.length > 0) {
    lines.push("", "| Advisory | Details |", "|---|---|");
    for (const warning of result.advisoryWarnings) {
      const details = detailFromCheck(warning).join("<br>") || "Warning reported";
      lines.push(`| ${renderMarkdownTableCell(warning.rule)} | ${renderMarkdownTableCell(details)} |`);
    }
  }

  if (result.hints.length > 0) {
    lines.push("", "### Hints");
    for (const hint of result.hints) {
      lines.push(`- ${hint.rule}: ${hint.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderIntegrationSummary(report) {
  const declared = report.diagnostics.declared;
  const extracted = report.diagnostics.extracted;
  const lines = [
    "## repo-guard integration summary",
    "",
    `- Result: ${report.result}`,
    `- Mode: ${report.mode}`,
    `- Repository root: \`${report.repositoryRoot}\``,
    `- Declared: ${declared.workflows} workflow(s), ${declared.templates} template(s), ${declared.docs} doc(s), ${declared.profiles} profile(s)`,
    `- Extracted: ${extracted.workflows} workflow(s), ${extracted.templates} template(s), ${extracted.docs} doc(s), ${extracted.profiles} profile(s), ${extracted.errors} artifact error(s)`,
    `- Diagnostics: ${report.passed} passed, ${report.failed} failed${report.mode === "advisory" ? `, ${report.violationCount} advisory violation(s)` : ""}, ${report.warnings} warning(s)`,
  ];

  if (report.violations.length > 0) {
    lines.push("", "| Diagnostic | Details |", "|---|---|");
    for (const violation of report.violations) {
      const details = detailFromCheck(violation).join("<br>") || "Diagnostic reported";
      lines.push(`| ${renderMarkdownTableCell(violation.rule)} | ${renderMarkdownTableCell(details)} |`);
    }
  }

  if (report.advisoryWarnings.length > 0) {
    lines.push("", "| Advisory | Details |", "|---|---|");
    for (const warning of report.advisoryWarnings) {
      const details = detailFromCheck(warning).join("<br>") || "Diagnostic reported";
      lines.push(`| ${renderMarkdownTableCell(warning.rule)} | ${renderMarkdownTableCell(details)} |`);
    }
  }

  if (report.hints.length > 0) {
    lines.push("", "### Hints");
    for (const hint of report.hints) {
      lines.push(`- ${hint.rule}: ${hint.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderAnalysisReport(report, { format, summary = "check" }) {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (format === "summary") {
    return summary === "integration"
      ? renderIntegrationSummary(report)
      : renderCheckSummary(report);
  }
  return null;
}
