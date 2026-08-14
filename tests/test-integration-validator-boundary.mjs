import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIntegrationAnalysisReport } from "../dist/integration-validator.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("integration validator orchestration boundary", () => {
  it("returns the canonical blocking report when repo-policy.json is absent", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repo-guard-integration-validator-"));
    try {
      const report = createIntegrationAnalysisReport({ packageRoot: root, repoRoot }, { format: "json" });

      assert.equal(report.command, "validate-integration");
      assert.equal(report.exitCode, 1);
      assert.equal(report.ruleResults[0]?.rule, "repo-policy.json");
      assert.deepEqual(report.integration, { workflows: [], templates: [], docs: [], profiles: [], errors: [] });
      assert.deepEqual(report.diagnostics.declared, { workflows: 0, templates: 0, docs: 0, profiles: 0, total: 0 });
      assert.deepEqual(report.diagnostics.extracted, { workflows: 0, templates: 0, docs: 0, profiles: 0, errors: 0, total: 0 });
    } finally {
      rmSync(repoRoot, { recursive: true });
    }
  });
});
