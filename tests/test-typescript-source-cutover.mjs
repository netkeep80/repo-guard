import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { defaultRuleFamilies } from "../dist/checks/default-rule-families.mjs";
import { listBuiltInProfiles } from "../dist/policy-profiles.mjs";

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
const workflowText = read(".github/workflows/ci.yml");
const workflow = parseYaml(workflowText);
const coverage = json("docs/self-hosting-coverage.json");
const testFiles = readdirSync("tests");

function observedCommands() {
  const commands = new Set();
  const runs = workflow.jobs.validate.steps.map((step) => step.run || "").join("\n");
  if (runs.includes("npx repo-guard\n") || runs.includes("run: npx repo-guard")) commands.add("validate");
  if (runs.includes("repo-guard doctor")) commands.add("doctor");
  if (runs.includes("check-diff")) commands.add("check-diff");
  const localAction = workflow.jobs.validate.steps.find((step) => step.uses === "./");
  if (localAction?.with?.mode === "check-pr") commands.add("check-pr");
  return commands;
}

function allowedExceptions(prefix) {
  return new Set(
    Object.keys(coverage.exceptions || {})
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  );
}

describe("repo-guard self-hosting security boundary", () => {
  it("checks ready PRs through the local Action in blocking mode", () => {
    const localAction = workflow.jobs.validate.steps.find((step) => step.uses === "./");
    assert.ok(localAction);
    assert.equal(localAction.with.mode, "check-pr");
    assert.equal(localAction.with.enforcement, "blocking");
    assert.match(localAction.if, /pull_request/);
    assert.match(localAction.if, /!github\.event\.pull_request\.draft/);
  });

  it("keeps governance files inside the checked surface", () => {
    const policy = json("repo-policy.json");
    assert.ok(policy.paths.governance_paths.includes("repo-policy.json"));
    assert.ok(policy.paths.governance_paths.includes(".github/workflows/**"));
    assert.ok(policy.paths.governance_paths.includes("schemas/**"));
  });

  it("exercises both enforcement modes", () => {
    const policy = json("repo-policy.json");
    assert.equal(policy.enforcement.mode, "blocking");
    const advisory = workflow.jobs.validate.steps.find((item) => item.name === "Exercise advisory policy mode");
    assert.match(advisory.run, /--enforcement advisory check-diff/);
    assert.match(advisory.run, /WARN: content-rules/);
  });
});

describe("derived test inventory", () => {
  it("uses one discovery runner instead of a package-maintained file list", () => {
    const pkg = json("package.json");
    assert.equal(pkg.scripts.test, "node tests/run.mjs");
    assert.equal((pkg.scripts.test.match(/node\s+tests\//g) || []).length, 1);
    assert.match(read("tests/run.mjs"), /\^test-\.\*\\\.mjs\$/);
  });

  it("runs one canonical suite in CI instead of per-test steps", () => {
    const steps = workflow.jobs.validate.steps;
    assert.ok(steps.some((step) => step.name === "Run discovered test suite" && step.run === "node tests/run.mjs"));
    assert.equal(workflowText.includes("npm run test:"), false);
  });

  it("discovers every current test-* file without editing package.json", () => {
    const discovered = testFiles.filter((name) => /^test-.*\.mjs$/.test(name));
    assert.ok(discovered.length > 20);
    assert.ok(discovered.includes("test-self-hosting.mjs"));
    assert.ok(discovered.includes("test-policy-delta-rules.mjs"));
  });
});

describe("derived capability inventory", () => {
  it("derives commands from the CLI registry and finds real evidence or an explicit exception", () => {
    const observed = observedCommands();
    const exceptions = allowedExceptions("command:");
    for (const command of COMMANDS) {
      assert.ok(observed.has(command) || exceptions.has(command), `missing self-host evidence for command ${command}`);
    }
  });

  it("derives rule families from the runtime registry", () => {
    const familyIds = new Set(defaultRuleFamilies.map((family) => family.id));
    const exceptions = allowedExceptions("rule:");
    for (const id of familyIds) {
      assert.ok(!exceptions.has(id) || coverage.exceptions[`rule:${id}`]);
    }
    for (const id of exceptions) assert.ok(familyIds.has(id), `stale rule exception ${id}`);
  });

  it("derives built-in profiles and requires rationale for unused ones", () => {
    const profiles = new Set(listBuiltInProfiles());
    const exceptions = allowedExceptions("profile:");
    for (const id of exceptions) assert.ok(profiles.has(id), `stale profile exception ${id}`);
  });

  it("stores only explicit exceptions, never a mirror of normal capabilities", () => {
    assert.deepEqual(Object.keys(coverage).sort(), ["exceptions"]);
    for (const [key, reason] of Object.entries(coverage.exceptions)) {
      assert.match(key, /^(command|rule|profile):/);
      assert.equal(typeof reason, "string");
      assert.ok(reason.trim().length > 0);
    }
  });
});

describe("self-hosted policy and documentation", () => {
  it("has no retired integration policy surface", () => {
    const policy = json("repo-policy.json");
    assert.equal(policy.integration, undefined);
  });

  it("self-applies through build, policy, doctor, tests and PR checks", () => {
    assert.match(workflowText, /npm run check:dist/);
    assert.match(workflowText, /npx repo-guard/);
    assert.match(workflowText, /repo-guard doctor/);
    assert.match(workflowText, /node tests\/run\.mjs/);
    assert.match(workflowText, /uses:\s*\.\//);
  });

  it("uses YAML ChangeIntent blocks itself and documents the exception model", () => {
    assert.match(read(".github/PULL_REQUEST_TEMPLATE.md"), /repo-guard-yaml/);
    assert.match(read("docs/SELF_HOSTING.md"), /исключ/i);
  });
});
