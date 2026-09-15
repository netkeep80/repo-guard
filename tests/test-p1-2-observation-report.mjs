import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRuleRegistry } from "../dist/checks/rule-registry.mjs";
import { createAnalysisCollector } from "../dist/runtime/analysis-report.mjs";
import * as githubPrRuntime from "../dist/github-pr.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = (path) => readFileSync(resolve(root, path), "utf-8");

describe("P1.2: один конечный machine report", () => {
  it("принимает check-pr --format json и возвращает JSON даже для configuration error без утечки token", () => {
    const secret = "p1-2-secret-token-sentinel";
    const result = spawnSync(process.execPath, [resolve(root, "dist/repo-guard.mjs"), "check-pr", "--format", "json"], {
      cwd: root,
      env: { ...process.env, GITHUB_EVENT_PATH: "", GH_TOKEN: secret },
      encoding: "utf-8",
    });
    assert.equal(result.status, 1);
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(output, /Unknown option for check-pr/);
    assert.doesNotMatch(output, new RegExp(secret));
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.command, "check-pr");
    assert.equal(report.result, "error");
    assert.equal(report.exitCode, 1);
    assert.equal(typeof report.reasonCode, "string");
  });

  it("не агрегирует два финальных pipeline result через Math.max", () => {
    const githubPr = source("src/github-pr.mts");
    assert.doesNotMatch(githubPr, /Math\.max\(baseResult\.exitCode,\s*proposedResult\.exitCode\)/);
  });

  it("BASE FAIL + HEAD PASS и BASE PASS + HEAD FAIL оба дают один failed report", () => {
    for (const [baseOk, headOk] of [[false, true], [true, false]]) {
      const collector = createAnalysisCollector("blocking");
      collector.report("base-rule", { ok: baseOk }, { policyOrigin: "base", enforcementMode: "blocking" });
      collector.report("head-rule", { ok: headOk }, { policyOrigin: "head", enforcementMode: "blocking" });
      const report = collector.finish();
      assert.equal(report.result, "failed");
      assert.equal(report.exitCode, 1);
      assert.equal(report.failed, 1);
      assert.deepEqual(report.ruleResults.map((item) => item.evidence.policyOrigin), ["base", "head"]);
    }
  });

  it("различает advisory failure и warning без отдельной exit aggregation", () => {
    const advisory = createAnalysisCollector("advisory");
    advisory.report("advisory-failure", { ok: false });
    const advisoryReport = advisory.finish();
    assert.equal(advisoryReport.result, "failed");
    assert.equal(advisoryReport.exitCode, 0);
    assert.equal(advisoryReport.failed, 0);

    const warning = createAnalysisCollector("blocking");
    warning.report("warning", { ok: false, advisory: true });
    const warningReport = warning.finish();
    assert.equal(warningReport.result, "passed_with_warnings");
    assert.equal(warningReport.exitCode, 0);
    assert.equal(warningReport.warnings, 1);
  });

  it("прикрепляет relation id, kind и operand snapshots к evidence envelope", () => {
    const operands = {
      left: { source: "document", selector: { path: "contract.json", format: "json", snapshot: "base", pointer: "/version" }, type: "string" },
      right: { source: "document", selector: { path: "contract.json", format: "json", snapshot: "head", pointer: "/version" }, type: "string" },
    };
    const collector = createAnalysisCollector("blocking");
    collector.report("document-version", { ok: false, data: { relation_id: "version-transition", kind: "scalar_strictly_greater", operands } }, { policyOrigin: "base" });
    const evidence = collector.finish().ruleResults[0].evidence;
    assert.equal(evidence.ruleId, "version-transition");
    assert.equal(evidence.policyOrigin, "base");
    assert.equal(evidence.relation, "scalar_strictly_greater");
    assert.equal(evidence.operands.left.selector.snapshot, "base");
    assert.equal(evidence.operands.right.selector.snapshot, "head");
    assert.equal(evidence.ok, false);
    assert.equal(evidence.reasonCode, "version-transition.failure");
  });
});

describe("P1.2: immutable observation reuse", () => {
  it("читает один и тот же (ref,path) ровно один раз", () => {
    assert.equal(typeof githubPrRuntime.memoizeSnapshotReader, "function");
    let reads = 0;
    const reader = githubPrRuntime.memoizeSnapshotReader((ref, path) => { reads++; return `${ref}:${path}`; });
    assert.equal(reader("base", "a file.json"), "base:a file.json");
    assert.equal(reader("base", "a file.json"), "base:a file.json");
    assert.equal(reader("head", "a file.json"), "head:a file.json");
    assert.equal(reader("head", "a file.json"), "head:a file.json");
    assert.equal(reads, 2);
  });
});

describe("P1.2: evaluation plan выбирает family до исполнения", () => {
  it("не вызывает evaluate у excluded family", () => {
    const registry = createRuleRegistry();
    registry.register({
      id: "excluded-throws",
      phase: "both",
      evaluate() { throw new Error("excluded family executed"); },
    });
    assert.deepEqual(registry.evaluate({}, { excludeFamilies: ["excluded-throws"] }), []);
  });
});

describe("P1.2: composite Action остаётся тонким adapter", () => {
  it("исполняет checked dist через argv-array и не парсит prose", () => {
    const action = source("action.yml");
    const runStep = action.slice(action.indexOf("- name: Run repo-guard"));
    const script = runStep.slice(runStep.indexOf("      run: |"));
    assert.match(script, /ARGS=\(node "\$\{GITHUB_ACTION_PATH\}\/dist\/repo-guard\.mjs"/);
    assert.match(script, /"\$\{ARGS\[@\]\}" > "\$REPORT_FILE"/);
    assert.match(script, /ARGS\+=\(--change-intent "\$RG_CHANGE_INTENT"\)/);
    assert.doesNotMatch(script, /\$\{\{\s*inputs\./);
    assert.doesNotMatch(script, /CMD="\$CMD/);
    assert.doesNotMatch(script, /\beval\b/);
    assert.doesNotMatch(script, /\bsed\b/);
    assert.doesNotMatch(script, /\bgrep\b/);
    assert.match(script, /--format json/);
  });
});
