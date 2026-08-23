import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Ajv from "ajv";

const root = resolve(new URL("..", import.meta.url).pathname), cli = resolve(root, "dist/repo-guard.mjs");
const schema = JSON.parse(readFileSync(resolve(root, "schemas/repo-policy.schema.json"), "utf-8"));
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")).version;
const immutableSha = "0123456789abcdef0123456789abcdef01234567";
const validate = new Ajv({ allErrors: true }).compile(schema);
const temp = () => mkdtempSync(join(tmpdir(), "repo-guard-init-"));
const run = (args, cwd = root) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf-8" });
const runInit = (dir, args = [], ref = immutableSha) => run(["--repo-root", dir, "init", "--action-ref", ref, ...args]);

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
    assert.equal(coordinatorContract.expect.permissions.checks, "read");
    const coordinator = readFileSync(join(dir, coordinatorPath), "utf-8");
    assert.match(coordinator, /workflow_dispatch/);
    assert.match(coordinator, new RegExp(`netkeep80/repo-guard@${immutableSha}`));
    assert.match(coordinator, /mode: portable-coordinator/);
    assert.match(coordinator, /^\s*checks: read$/m);
    assert.doesNotMatch(coordinator, /actions\/checkout/);
    assert.doesNotMatch(coordinator, /npm (?:test|run)/);
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
