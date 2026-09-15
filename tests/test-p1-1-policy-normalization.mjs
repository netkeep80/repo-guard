import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { compileConstraintProgram } from "../dist/checks/constraint-program.mjs";
import { resolvePolicyPacks } from "../dist/policy-packs.mjs";
import { collectObservatorySnapshot } from "../scripts/observatory/collect.mjs";

const validationModule = await import("../dist/runtime/validation.mjs");
const packageRoot = resolve(".");

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

assert.equal(typeof validationModule.createPolicyNormalizationContext, "function", "one canonical normalization context must exist");
assert.equal(typeof validationModule.normalizePolicy, "function", "one canonical normalizePolicy operation must exist");

if (typeof validationModule.createPolicyNormalizationContext === "function" && typeof validationModule.normalizePolicy === "function") {
  const context = validationModule.createPolicyNormalizationContext({ packageRoot, repoRoot: packageRoot });
  const rawPolicy = foundationPolicy();
  const normalized = validationModule.normalizePolicy(context, rawPolicy, { quiet: true });
  const resolved = resolvePolicyPacks(rawPolicy);
  const expectedProgram = compileConstraintProgram(resolved.policy, null);

  assert.equal(normalized.ok, true);
  assert.equal(normalized.policy?.packs, undefined, "pack syntax must disappear from normalized policy");
  assert.deepEqual(normalized.constraintProgram.map((entry) => entry.key), expectedProgram.map((entry) => entry.key));
  assert.deepEqual(normalized.provenance.packs, ["requirements-strict"]);
  assert.match(normalized.provenance.schemaAuthority, /^repo-guard@3\.1\.0\|/);
  assert.strictEqual(context.validatorFor("repoPolicy"), context.validatorFor("repoPolicy"), "compiled validator must be reused within one invocation");

  const malformed = foundationPolicy();
  malformed.packs = { "requirements-strict": [] };
  const rejected = validationModule.normalizePolicy(context, malformed, { quiet: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.policy, null, "schema-invalid shape must not reach pack lowering");
  assert.equal(rejected.constraintProgram, null, "schema-invalid shape must not reach semantic program lowering");
  assert.deepEqual([...new Set(rejected.errors.map((error) => error.stage))], ["schema"]);

  const withRetiredBaseField = foundationPolicy();
  withRetiredBaseField.integration = { workflows: [{ id: "retired" }] };
  assert.equal(validationModule.normalizePolicy(context, withRetiredBaseField, { quiet: true }).ok, false, "HEAD remains strict current vocabulary");
  const historical = validationModule.normalizePolicy(context, withRetiredBaseField, { quiet: true, historicalBase: true });
  assert.equal(historical.ok, true, "retired BASE-only vocabulary is projected at the bounded historical boundary");
  assert.equal(historical.policy.integration, undefined);

  const malformedCurrentBase = foundationPolicy();
  malformedCurrentBase.diff_rules = { max_new_docs: "broken", max_new_files: 10 };
  const malformedHistorical = validationModule.normalizePolicy(context, malformedCurrentBase, { quiet: true, historicalBase: true });
  assert.equal(malformedHistorical.ok, false, "recognized current BASE constraints remain fail-closed after projection");
  assert.deepEqual([...new Set(malformedHistorical.errors.map((error) => error.stage))], ["schema"]);
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
