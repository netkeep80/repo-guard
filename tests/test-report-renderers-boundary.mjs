import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderAnalysisReport, renderCheckSummary } from "../dist/reporting/renderers.mjs";

function report() {
  return {
    command: "check-pr",
    mode: "blocking",
    result: "failed",
    repositoryRoot: "/tmp/repo",
    passed: 2,
    failed: 1,
    violationCount: 1,
    warnings: 0,
    exitCode: 1,
    violations: [{ rule: "rule|name", details: ["line one\nline two|tail"] }],
    advisoryWarnings: [],
    hints: [],
  };
}

describe("AnalysisReport renderer boundary", () => {
  it("preserves Markdown escaping for violation table fields", () => {
    const summary = renderCheckSummary(report());
    assert.match(summary, /\| rule\\\|name \| line one<br>line two\\\|tail \|/);
  });

  it("selects the check summary for a normal check command", () => {
    const summary = renderAnalysisReport(report(), { format: "summary" });
    assert.ok(summary.startsWith("## repo-guard summary\n"));
    assert.match(summary, /- Checks: 2 passed, 1 failed/);
  });
});
