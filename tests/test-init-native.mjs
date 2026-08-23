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

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(root, "dist/repo-guard.mjs");
const schema = JSON.parse(readFileSync(resolve(root, "schemas/repo-policy.schema.json"), "utf-8"));
const immutableSha = "0123456789abcdef0123456789abcdef01234567";
const validate = new Ajv({ allErrors: true }).compile(schema);
const temp = () => mkdtempSync(join(tmpdir(), "repo-guard-native-init-"));
const run = (args, cwd = root) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf-8" });
const runInit = (dir) => run(["--repo-root", dir, "init", "--action-ref", immutableSha, "--parallel", "github_merge_queue"]);
const statePath = ".github/workflows/repo-guard-merge-group.yml";
const nativePaths = [
  "repo-policy.json",
  ".github/workflows/repo-guard.yml",
  statePath,
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/change-intent.yml",
];

describe("repo-guard init github_merge_queue", () => {
  it("generates the canonical PR transaction and merge-group state scaffold", () => {
    const dir = temp(), result = runInit(dir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    for (const path of nativePaths) assert.equal(existsSync(join(dir, path)), true, path);

    const policy = JSON.parse(readFileSync(join(dir, "repo-policy.json"), "utf-8"));
    assert.equal(validate(policy), true, JSON.stringify(validate.errors));
    assert.deepEqual(policy.integration?.workflows?.map(({ path, role, expect }) => ({ path, role, mode: expect?.mode })), [
      { path: ".github/workflows/repo-guard.yml", role: "repo_guard_pr_gate", mode: "check-pr" },
      { path: statePath, role: "repo_guard_merge_group_gate", mode: "check-merge-group" },
    ]);

    const stateContract = policy.integration.workflows.find(({ role }) => role === "repo_guard_merge_group_gate");
    assert.deepEqual(stateContract.expect.events, ["merge_group"]);
    assert.deepEqual(stateContract.expect.event_types, ["checks_requested"]);
    assert.deepEqual(stateContract.expect.permissions, { contents: "read" });

    const state = readFileSync(join(dir, statePath), "utf-8");
    assert.match(state, /^\s*merge_group:$/m);
    assert.match(state, /^\s*types: \[checks_requested\]$/m);
    assert.match(state, new RegExp(`netkeep80/repo-guard@${immutableSha}`));
    assert.match(state, /mode: check-merge-group/);
    assert.match(state, /^\s*contents: read$/m);
    assert.doesNotMatch(state, /workflow_dispatch/);
    assert.doesNotMatch(state, /branch[_ -]?protection|ruleset|\bbypass\b/i);
  });

  it("passes canonical integration validation and native repository readiness", () => {
    const dir = temp();
    assert.equal(runInit(dir).status, 0);
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
      provider: "github_merge_queue",
      integrationFacts,
      controlPlaneFacts: {
        targetBranch: "main",
        requiredChecks: ["policy-check"],
        pullRequestRequired: true,
        requiredChecksEnforced: true,
        noBypass: true,
        mergeQueueEnabled: true,
      },
    });
    assert.equal(readiness.ready, true, JSON.stringify(readiness.blockers));
    assert.deepEqual(readiness.blockers, []);
    assert.equal(readiness.evidence.repository.transactionWorkflow, ".github/workflows/repo-guard.yml");
    assert.equal(readiness.evidence.repository.providerWorkflow, statePath);
  });

  it("is idempotent and never rewrites a partial existing merge-group workflow", () => {
    const dir = temp();
    assert.equal(runInit(dir).status, 0);
    const first = Object.fromEntries(nativePaths.map((path) => [path, readFileSync(join(dir, path), "utf-8")]));
    const second = runInit(dir);
    assert.equal(second.status, 0);
    for (const path of nativePaths) assert.equal(readFileSync(join(dir, path), "utf-8"), first[path], path);

    const partialDir = temp(), state = join(partialDir, statePath);
    mkdirSync(join(partialDir, ".github/workflows"), { recursive: true });
    writeFileSync(state, "custom merge-group workflow\n", "utf-8");
    const partial = runInit(partialDir);
    assert.equal(partial.status, 0);
    assert.equal(readFileSync(state, "utf-8"), "custom merge-group workflow\n");
    assert.match(partial.stdout, /Skipped \(already exist\):[\s\S]*repo-guard-merge-group\.yml/);
  });
});
