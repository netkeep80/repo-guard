import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRuleRegistry } from "../dist/checks/rule-registry.mjs";
import { createAnalysisCollector } from "../dist/runtime/analysis-report.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = (path) => readFileSync(resolve(root, path), "utf-8");

describe("P1.2: один конечный machine report", () => {
  it("принимает check-pr --format json и возвращает JSON даже для configuration error", () => {
    const result = spawnSync(process.execPath, [resolve(root, "dist/repo-guard.mjs"), "check-pr", "--format", "json"], {
      cwd: root,
      env: { ...process.env, GITHUB_EVENT_PATH: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Unknown option for check-pr/);
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

  it("прикрепляет к rule result компактную evidence envelope", () => {
    const collector = createAnalysisCollector("blocking");
    collector.report("forbidden-paths", { ok: false, data: { kind: "set_disjoint" } }, { policyOrigin: "base" });
    const report = collector.finish();
    const evidence = report.ruleResults[0].evidence;
    assert.equal(evidence.ruleId, "forbidden-paths");
    assert.equal(evidence.policyOrigin, "base");
    assert.equal(evidence.ok, false);
    assert.equal(typeof evidence.reasonCode, "string");
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
  it("не собирает interpolated command и не парсит prose через sed/grep", () => {
    const action = source("action.yml");
    assert.doesNotMatch(action, /CMD="\$CMD/);
    assert.doesNotMatch(action, /\bsed\b/);
    assert.doesNotMatch(action, /\bgrep\b/);
    assert.match(action, /--format json/);
  });
});
