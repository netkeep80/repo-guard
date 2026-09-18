import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAnalysisCollector } from "../dist/runtime/analysis-report.mjs";

describe("AnalysisReport collector boundary", () => {
  it("preserves canonical blocking failure details, hints and exit semantics", () => {
    const collector = createAnalysisCollector("blocking");
    collector.report("semantic-rule", {
      ok: false,
      message: "semantic failure",
      count: 2,
      surfaces: ["src", "tests"],
      hint: "add evidence",
    });
    const report = collector.finish({ command: "check-pr" });

    assert.equal(report.result, "failed");
    assert.equal(report.exitCode, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.violationCount, 1);
    assert.deepEqual(report.ruleResults[0].details, [
      "semantic failure",
      "count: 2",
      "surfaces: src, tests",
      "hint: add evidence",
    ]);
    assert.deepEqual(report.hints, [{ rule: "semantic-rule", message: "add evidence" }]);
    assert.equal(report.violations[0], report.ruleResults[0]);
  });
});
