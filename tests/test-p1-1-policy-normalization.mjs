import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { compileConstraintProgram } from "../dist/checks/constraint-program.mjs";
import { resolvePolicyPacks } from "../dist/policy-packs.mjs";
import { collectObservatorySnapshot } from "../scripts/observatory/collect.mjs";

function foundationPolicy() {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
    },
    diff_rules: { max_new_docs: 2, max_new_files: 10, max_net_added_lines: 1000 },
    content_rules: [],
    cochange_rules: [],
    packs: { "requirements-strict": {} },
  };
}

const sandbox = mkdtempSync(join(tmpdir(), "repo-guard-p1-1-"));
const acceptedSha = "a".repeat(40);

try {
  mkdirSync(join(sandbox, "examples/scenarios/probe"), { recursive: true });
  mkdirSync(join(sandbox, ".github/workflows"), { recursive: true });
  writeFileSync(join(sandbox, "package.json"), JSON.stringify({ version: "3.1.0" }), "utf8");
  writeFileSync(join(sandbox, "repo-policy.json"), JSON.stringify(foundationPolicy(), null, 2), "utf8");
  writeFileSync(join(sandbox, ".github/workflows/ci.yml"), "name: CI\non:\n  push: {}\njobs: {}\n", "utf8");
  writeFileSync(join(sandbox, "examples/scenarios/probe/scenario.json"), JSON.stringify({
    id: "probe",
    title_ru: "Проверка",
    summary_ru: "Проверка canonical policy lowering",
    command: "repo-guard",
    cases: [{ id: "one" }],
  }), "utf8");

  const rawPolicy = foundationPolicy();
  const resolved = resolvePolicyPacks(rawPolicy);
  assert.equal(resolved.ok, true);
  const expectedProgram = compileConstraintProgram(resolved.policy, null);

  const snapshot = await collectObservatorySnapshot({
    repoRoot: sandbox,
    acceptedSha,
    ci: {
      workflow: "CI",
      run_id: 1,
      run_url: "https://example.invalid/runs/1",
      conclusion: "success",
    },
    repository: "netkeep80/repo-guard",
    token: "test-token",
    fetchImpl: async () => ({ status: 404, ok: false, async json() { return {}; } }),
    run(command, args) {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return acceptedSha;
      if (command === process.execPath && String(args[0]).endsWith("scripts/compression-metrics.mjs")) {
        return JSON.stringify({ current: { architecture: {} } });
      }
      throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
    },
  });

  assert.deepEqual(snapshot.policy.accepted, rawPolicy, "Observatory must retain the accepted raw policy as evidence");
  assert.deepEqual(
    snapshot.policy.constraint_program.map((entry) => entry.key),
    expectedProgram.map((entry) => entry.key),
    "Observatory must derive Constraint Program from the same lowered policy semantics as runtime",
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("P1.1 canonical policy normalization proof passed");
