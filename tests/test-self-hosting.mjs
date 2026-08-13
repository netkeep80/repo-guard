import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRuleFamilies } from "../src/checks/default-rule-families.mjs";
import { parseYaml } from "../src/document-facts.mjs";
import { listBuiltInProfiles } from "../src/policy-profiles.mjs";
import { COMMANDS } from "../src/repo-guard.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const read = (path) => readFileSync(resolve(projectRoot, path), "utf-8");
const json = (path) => JSON.parse(read(path));
const policy = json("repo-policy.json");
const workflowText = read(".github/workflows/ci.yml");
const workflow = parseYaml(workflowText);
const coverage = json("docs/self-hosting-coverage.json");
const exceptions = coverage.exceptions || {};
const testFiles = readdirSync(resolve(projectRoot, "tests")).filter((name) => name.endsWith(".mjs")).sort();

function hasException(id) {
  return typeof exceptions[id] === "string" && exceptions[id].trim().length > 0;
}

function selfFacts() {
  return {
    policy,
    basePolicy: policy,
    headPolicy: policy,
    changeIntent: { change_type: "refactor" },
    trustedGovernancePaths: policy.paths.governance_paths,
    diff: { files: { checked: [] } },
  };
}

describe("repo-guard self-hosting security boundary", () => {
  it("checks ready PRs through the local Action in blocking mode", () => {
    const step = workflow.jobs.validate.steps.find((item) => item.name === "Run PR policy check");
    assert.ok(step);
    assert.equal(step.uses, "./");
    assert.equal(step.with.mode, "check-pr");
    assert.equal(step.with.enforcement, "blocking");
    assert.match(step.if, /pull_request/);
    assert.equal(step.env.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
  });

  it("keeps governance files inside the checked surface", () => {
    for (const path of [
      "repo-policy.json", "schemas/", ".github/workflows/", ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/", "templates/", "action.yml",
    ]) assert.ok(policy.paths.governance_paths.includes(path), `missing governance path ${path}`);
    assert.equal((policy.paths.operational_paths || []).some((path) => path.startsWith(".github/")), false);
  });

  it("exercises both enforcement modes", () => {
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
    assert.ok(steps.some((step) => step.name === "Run discovered test suite" && step.run === "npm test"));
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
  it("derives commands from the CLI registry and finds real evidence", () => {
    const corpus = `${workflowText}\n${testFiles.join("\n")}\n${read(".github/PULL_REQUEST_TEMPLATE.md")}`;
    for (const command of COMMANDS) {
      if (command === "validate") assert.match(workflowText, /Validate repo-policy\.json/);
      else if (command === "init") assert.ok(testFiles.includes("test-init.mjs"));
      else assert.ok(corpus.includes(command), `no self-hosting evidence for command ${command}`);
    }
  });

  it("derives rule families from the runtime registry", () => {
    const ruleIds = new Set(defaultRuleFamilies.map((family) => family.id));
    assert.ok(ruleIds.size > 0);
    for (const family of defaultRuleFamilies) {
      const capability = `rule:${family.id}`;
      const applies = family.applies ? family.applies(selfFacts(), {}) : true;
      if (applies === false) assert.ok(hasException(capability), `${capability} is inactive on self and lacks rationale`);
    }
    for (const id of Object.keys(exceptions).filter((id) => id.startsWith("rule:"))) {
      assert.ok(ruleIds.has(id.slice(5)), `stale rule exception ${id}`);
    }
  });

  it("derives built-in profiles and requires rationale for unused ones", () => {
    for (const profile of listBuiltInProfiles()) {
      if (policy.profile !== profile) assert.ok(hasException(`profile:${profile}`), `unused profile ${profile} lacks rationale`);
    }
  });

  it("stores only explicit exceptions, never a mirror of normal capabilities", () => {
    assert.equal(coverage.schema_version, "2.0.0");
    assert.equal(Object.hasOwn(coverage, "capabilities"), false);
    for (const [id, rationale] of Object.entries(exceptions)) {
      assert.ok(id.includes(":"));
      assert.ok(rationale.trim().length > 20, `${id} rationale is too weak`);
    }
    assert.ok(hasException("change-intent-format:repo-guard-json"));
  });
});

describe("self-hosted integration and documentation", () => {
  it("declares real workflow/template/doc integration", () => {
    assert.equal(policy.integration.workflows[0].path, ".github/workflows/ci.yml");
    assert.ok(policy.integration.templates.some((item) => item.kind === "markdown"));
    assert.ok(policy.integration.templates.some((item) => item.kind === "github_issue_form"));
    assert.equal(policy.integration.docs[0].path, "README.md");
    assert.equal(policy.integration.profiles[0].id, "self-hosting");
  });

  it("routes integration facts through the Constraint Program", () => {
    assert.match(read("src/checks/constraint-program.mjs"), /kind: "integration"/);
    assert.doesNotMatch(read("src/integration-validator.mjs"), /validateRepoGuardPrGate/);
  });

  it("uses YAML ChangeIntent blocks itself and documents the exception model", () => {
    assert.match(read(".github/PULL_REQUEST_TEMPLATE.md"), /```repo-guard-yaml/);
    const issueTemplatePath = policy.integration.templates.find((entry) => entry.kind === "github_issue_form").path;
    assert.match(read(issueTemplatePath), /repo-guard-yaml/);
    const doc = read("docs/self-hosting-coverage.md");
    assert.match(doc, /вывод/);
    assert.match(doc, /исключен/);
  });
});
