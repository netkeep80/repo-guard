import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Ajv from "ajv";
import { integrationConstraintEntries } from "../dist/checks/integration-constraints.mjs";
import { extractIntegration } from "../dist/extractors/integration.mjs";
import { evaluateParallelReadiness } from "../dist/parallel-readiness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname), cli = resolve(root, "dist/repo-guard.mjs");
const schema = JSON.parse(readFileSync(resolve(root, "schemas/repo-policy.schema.json"), "utf-8"));
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")).version;
const immutableSha = "0123456789abcdef0123456789abcdef01234567";
const validate = new Ajv({ allErrors: true }).compile(schema);
const temp = () => mkdtempSync(join(tmpdir(), "repo-guard-init-"));
const run = (args, cwd = root) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf-8" });
const runInit = (dir, args = [], ref = immutableSha) => run(["--repo-root", dir, "init", "--action-ref", ref, ...args]);
const portablePaths = [
  "repo-policy.json",
  ".github/workflows/repo-guard.yml",
  ".github/workflows/repo-guard-portable-coordinator.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/change-intent.yml",
];

describe("repo-guard init", () => {
  it("creates a valid default scaffold with an explicit immutable Action ref", () => {
    const dir = temp(), result = runInit(dir);
    assert.equal(result.status, 0);
    for (const path of ["repo-policy.json", ".github/workflows/repo-guard.yml", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/change-intent.yml"]) assert.equal(existsSync(join(dir, path)), true, path);
    const policy = JSON.parse(readFileSync(join(dir, "repo-policy.json"), "utf-8"));
    assert.equal(policy.repository_kind, "application"); assert.equal(policy.enforcement.mode, "blocking"); assert.equal(validate(policy), true);
  });

  it("generates a portable parallel scaffold with canonical integration contracts", () => {
    const dir = temp(), result = runInit(dir, ["--parallel", "portable"]);
    assert.equal(result.status, 0);
    const coordinatorPath = ".github/workflows/repo-guard-portable-coordinator.yml";
    assert.equal(existsSync(join(dir, coordinatorPath)), true);
    const policy = JSON.parse(readFileSync(join(dir, "repo-policy.json"), "utf-8"));
    assert.equal(validate(policy), true, JSON.stringify(validate.errors));
    assert.deepEqual(policy.integration?.workflows?.map(({ path, role, expect }) => ({ path, role, mode: expect?.mode })), [
      { path: ".github/workflows/repo-guard.yml", role: "repo_guard_pr_gate", mode: "check-pr" },
      { path: coordinatorPath, role: "repo_guard_portable_coordinator", mode: "portable-coordinator" },
    ]);
    const coordinatorContract = policy.integration.workflows.find(({ role }) => role === "repo_guard_portable_coordinator");
    assert.deepEqual(coordinatorContract.expect.permissions, { contents: "write", "pull-requests": "write", checks: "read" });
    const coordinator = readFileSync(join(dir, coordinatorPath), "utf-8");
    assert.match(coordinator, /workflow_dispatch/);
    assert.match(coordinator, new RegExp(`netkeep80/repo-guard@${immutableSha}`));
    assert.match(coordinator, /mode: portable-coordinator/);
    assert.match(coordinator, /^\s*checks: read$/m);
    assert.match(coordinator, /repository: \$\{\{ github\.repository \}\}/);
    assert.match(coordinator, /ready-label: repo-guard:ready/);
    assert.match(coordinator, /merge-method: squash/);
    assert.match(coordinator, /transaction-checks: \|\n\s+policy-check/);
    assert.match(coordinator, /state-checks: \|\n\s+policy-check/);
    assert.match(coordinator, /format: json/);
    assert.doesNotMatch(coordinator, /actions\/checkout/);
    assert.doesNotMatch(coordinator, /^\s*-\s*run:/m);
    assert.doesNotMatch(coordinator, /\b(?:npm|pnpm|yarn|bun)\b/);
    assert.doesNotMatch(coordinator, /\bgit\s+(?:merge|rebase|push)\b/);
    assert.doesNotMatch(coordinator, /branch[_ -]?protection|ruleset|\badmin\b|\bbypass\b/i);
  });

  it("generated portable repository passes canonical integration validation and repository readiness", () => {
    const dir = temp();
    assert.equal(runInit(dir, ["--parallel", "portable"]).status, 0);
    const validation = run(["--repo-root", dir, "validate-integration"]);
    assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
    assert.match(validation.stdout, /PASS: integration-workflows/);

    const policy = JSON.parse(readFileSync(join(dir, "repo-policy.json"), "utf-8"));
    const trackedFiles = policy.integration.workflows.map(({ path }) => path);
    const integrationFacts = extractIntegration(policy, {
      repoRoot: dir,
      trackedFiles,
      readFile: (path) => readFileSync(join(dir, path), "utf-8"),
    });
    const workflowCheck = integrationConstraintEntries(integrationFacts).find(({ name }) => name === "integration-workflows")?.check;
    assert.equal(workflowCheck?.ok, true, JSON.stringify(workflowCheck?.details));

    const readiness = evaluateParallelReadiness({
      provider: "portable",
      integrationFacts,
      controlPlaneFacts: {
        targetBranch: "main",
        requiredChecks: ["policy-check"],
        pullRequestRequired: true,
        requiredChecksEnforced: true,
        noBypass: true,
        upToDateRequired: true,
      },
    });
    assert.equal(readiness.ready, true, JSON.stringify(readiness.blockers));
    assert.deepEqual(readiness.blockers, []);
    assert.equal(readiness.evidence.repository.transactionWorkflow, ".github/workflows/repo-guard.yml");
    assert.equal(readiness.evidence.repository.providerWorkflow, ".github/workflows/repo-guard-portable-coordinator.yml");
  });

  it("fails closed before any write for missing or unsupported parallel provider values", () => {
    for (const args of [
      ["--repo-root", temp(), "init", "--action-ref", immutableSha, "--parallel"],
      ["--repo-root", temp(), "init", "--action-ref", immutableSha, "--parallel", "unsupported"],
    ]) {
      const dir = args[1], result = run(args);
      assert.equal(result.status, 1);
      for (const path of portablePaths) assert.equal(existsSync(join(dir, path)), false, path);
    }
  });

  it("keeps portable init idempotent and never rewrites a partial existing coordinator", () => {
    const dir = temp();
    assert.equal(runInit(dir, ["--parallel", "portable"]).status, 0);
    const first = Object.fromEntries(portablePaths.map((path) => [path, readFileSync(join(dir, path), "utf-8")]));
    const second = runInit(dir, ["--parallel", "portable"]);
    assert.equal(second.status, 0);
    for (const path of portablePaths) assert.equal(readFileSync(join(dir, path), "utf-8"), first[path], path);

    const partialDir = temp(), coordinatorPath = join(partialDir, ".github/workflows/repo-guard-portable-coordinator.yml");
    mkdirSync(join(partialDir, ".github/workflows"), { recursive: true });
    writeFileSync(coordinatorPath, "custom coordinator\n", "utf-8");
    const partial = runInit(partialDir, ["--parallel", "portable"]);
    assert.equal(partial.status, 0);
    assert.equal(readFileSync(coordinatorPath, "utf-8"), "custom coordinator\n");
    assert.match(partial.stdout, /Skipped \(already exist\):[\s\S]*repo-guard-portable-coordinator\.yml/);
  });

  for (const preset of ["application", "library", "tooling", "documentation"]) it(`generates valid ${preset} preset`, () => {
    const dir = temp(), result = runInit(dir, ["--preset", preset, "--mode", "advisory"]);
    assert.equal(result.status, 0);
    const policy = JSON.parse(readFileSync(join(dir, "repo-policy.json"), "utf-8"));
    assert.equal(policy.repository_kind, preset); assert.equal(policy.enforcement.mode, "advisory"); assert.equal(validate(policy), true);
  });

  it("pins the generated workflow to the exact explicit SHA and keeps intent/grant templates separate", () => {
    const dir = temp(); runInit(dir);
    const workflow = readFileSync(join(dir, ".github/workflows/repo-guard.yml"), "utf-8");
    assert.match(workflow, new RegExp(`netkeep80/repo-guard@${immutableSha}`));
    assert.doesNotMatch(workflow, /netkeep80\/repo-guard@main/);
    assert.match(workflow, /fetch-depth: 0/); assert.match(workflow, /mode: check-pr/); assert.match(workflow, /GH_TOKEN/);
    const pr = readFileSync(join(dir, ".github/PULL_REQUEST_TEMPLATE.md"), "utf-8");
    assert.match(pr, /Намерение изменения/); assert.match(pr, /repo-guard-yaml/); assert.doesNotMatch(pr, /repo-guard-grant/);
    const issue = readFileSync(join(dir, ".github/ISSUE_TEMPLATE/change-intent.yml"), "utf-8");
    assert.match(issue, /label: ChangeIntent/); assert.match(issue, /repo-guard-grant/); assert.match(issue, /GovernanceGrant/);
  });

  it("accepts only the package-matching strict release tag", () => {
    const dir = temp(), expectedTag = `v${version}`;
    const result = runInit(dir, [], expectedTag);
    assert.equal(result.status, 0);
    assert.match(readFileSync(join(dir, ".github/workflows/repo-guard.yml"), "utf-8"), new RegExp(`netkeep80/repo-guard@${expectedTag.replaceAll(".", "\\.")}`));
  });

  it("fails closed before writing files when Action ref is absent, mutable, short, or version-mismatched", () => {
    const cases = [
      [[], /refuses to invent an Action ref/],
      [["--action-ref", "main"], /mutable or ambiguous/],
      [["--action-ref", "0123456"], /mutable or ambiguous/],
      [["--action-ref", "v9.9.9"], /does not match package\.json version/],
    ];
    for (const [args, message] of cases) {
      const dir = temp(), result = run(["--repo-root", dir, "init", ...args]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      for (const path of ["repo-policy.json", ".github/workflows/repo-guard.yml", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/change-intent.yml"]) assert.equal(existsSync(join(dir, path)), false, path);
    }
  });

  it("does not overwrite existing files", () => {
    const dir = temp(), path = join(dir, "repo-policy.json"); writeFileSync(path, '{"custom":true}');
    assert.equal(runInit(dir).status, 0); assert.match(readFileSync(path, "utf-8"), /custom/);
  });
  it("is idempotent", () => {
    const dir = temp(); assert.equal(runInit(dir).status, 0);
    const second = runInit(dir); assert.equal(second.status, 0); assert.match(second.stdout, /Skipped/);
  });
  it("returns errors instead of terminating imported runtime", () => {
    for (const args of [["init", "--action-ref", immutableSha, "--preset", "unknown"], ["init", "--action-ref", immutableSha, "--mode", "wrong"], ["init", "--action-ref", immutableSha, "--bad-flag"]]) assert.equal(run(args).status, 1);
    const help = run(["init", "--help"]); assert.equal(help.status, 0); assert.match(help.stdout, /Usage: repo-guard init --action-ref/);
  });
  it("generated policy is immediately validatable", () => {
    const dir = temp(); runInit(dir, ["--preset", "tooling"]);
    const result = run(["--repo-root", dir]); assert.equal(result.status, 0); assert.match(result.stdout, /OK: repo-policy.json/);
  });
});
