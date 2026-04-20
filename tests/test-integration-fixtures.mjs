import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = new URL(".", import.meta.url).pathname;
const projectRoot = resolve(__dirname, "..");
const fixtureRoot = resolve(projectRoot, "tests/fixtures/integration");

let failures = 0;

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS: ${label}`);
  } catch {
    failures++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function expectIncludes(label, value, substring) {
  const actual = String(value || "");
  const passed = actual.includes(substring);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected ${JSON.stringify(actual)} to include ${JSON.stringify(substring)}`);
  }
}

function expectTrue(label, value) {
  expect(label, Boolean(value), true);
}

function readFixture(path) {
  return readFileSync(resolve(fixtureRoot, path), "utf-8");
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function integrationPolicy() {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    enforcement: { mode: "blocking" },
    integration: {
      workflows: [
        {
          id: "repo-guard-pr-gate",
          kind: "github_actions",
          path: ".github/workflows/repo-guard.yml",
          role: "repo_guard_pr_gate",
          profiles: ["requirements-strict"],
          expect: {
            events: ["pull_request"],
            event_types: ["opened", "synchronize", "reopened", "ready_for_review"],
            action: {
              uses: "netkeep80/repo-guard",
              ref_pinning: "semver",
            },
            mode: "check-pr",
            enforcement: "blocking",
            permissions: {
              contents: "read",
              "pull-requests": "read",
              issues: "read",
            },
            token_env: ["GH_TOKEN"],
            summary: true,
            disallow: ["continue_on_error", "manual_clone", "direct_temp_cli_execution"],
          },
        },
      ],
      templates: [
        {
          id: "pull-request-template",
          kind: "markdown",
          path: ".github/PULL_REQUEST_TEMPLATE.md",
          requires_contract_block: true,
          required_block_kind: "repo-guard-yaml",
          required_contract_fields: ["change_type", "scope", "anchors.affects"],
          profiles: ["requirements-strict"],
        },
        {
          id: "change-contract-issue-form",
          kind: "github_issue_form",
          path: ".github/ISSUE_TEMPLATE/change-contract.yml",
          requires_contract_block: true,
          optional: true,
          required_block_kind: "repo-guard-yaml",
          required_contract_fields: ["change_type", "scope", "anchors.affects"],
          profiles: ["requirements-strict"],
        },
      ],
      docs: [
        {
          id: "readme",
          kind: "markdown",
          path: "README.md",
          must_mention: ["repo-guard", "contract", "integration"],
          must_reference_files: [
            "repo-policy.json",
            ".github/PULL_REQUEST_TEMPLATE.md",
            ".github/workflows/repo-guard.yml",
          ],
          must_mention_profiles: ["requirements-strict"],
          must_mention_contract_fields: ["change_type", "scope", "anchors.affects"],
          profiles: ["requirements-strict"],
        },
      ],
      profiles: [
        {
          id: "requirements-strict",
          doc_path: "README.md",
        },
      ],
    },
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: {
      max_new_docs: 2,
      max_new_files: 15,
      max_net_added_lines: 2000,
    },
    content_rules: [],
    cochange_rules: [],
  };
}

function makeFixtureRepo({ workflow, prTemplate, issueTemplate = null, readme }) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-fixture-e2e-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(dir, ".github", "ISSUE_TEMPLATE"), { recursive: true });

  writeJson(join(dir, "repo-policy.json"), integrationPolicy());
  writeFileSync(join(dir, ".github", "workflows", "repo-guard.yml"), readFixture(workflow));
  writeFileSync(join(dir, ".github", "PULL_REQUEST_TEMPLATE.md"), readFixture(prTemplate));
  if (issueTemplate) {
    writeFileSync(join(dir, ".github", "ISSUE_TEMPLATE", "change-contract.yml"), readFixture(issueTemplate));
  }
  writeFileSync(join(dir, "README.md"), readFixture(readme));

  return dir;
}

function runGuard(args, cwd = projectRoot) {
  const result = spawnSync(process.execPath, [
    resolve(projectRoot, "src/repo-guard.mjs"),
    ...args,
  ], {
    cwd,
    encoding: "utf-8",
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

console.log("\n--- integration fixture e2e: valid downstream wiring passes validate-integration ---");
{
  const dir = makeFixtureRepo({
    workflow: "valid-workflow.yml",
    prTemplate: "valid-pr-template.md",
    issueTemplate: "valid-issue-template.yml",
    readme: "valid-readme.md",
  });
  const result = runGuard(["--repo-root", dir, "validate-integration", "--format", "json"]);
  const parsed = JSON.parse(result.stdout);

  expect("valid fixture exits 0", result.code, 0);
  expect("valid fixture result passed", parsed.result, "passed");
  expect("valid fixture declares two templates", parsed.diagnostics.declared.templates, 2);
  expectTrue("valid fixture emits workflow facts", parsed.integration.workflows.length === 1);
  expectTrue("valid fixture emits template facts", parsed.integration.templates.length === 2);
  expectTrue("valid fixture emits doc facts", parsed.integration.docs.length === 1);
  expect("valid fixture has no artifact errors", parsed.diagnostics.artifactErrors, []);

  rmSync(dir, { recursive: true });
}

console.log("\n--- integration fixture e2e: doctor --integration aliases valid diagnostics ---");
{
  const dir = makeFixtureRepo({
    workflow: "valid-workflow.yml",
    prTemplate: "valid-pr-template.md",
    issueTemplate: "valid-issue-template.yml",
    readme: "valid-readme.md",
  });
  const result = runGuard(["--repo-root", dir, "doctor", "--integration", "--format", "summary"]);

  expect("doctor integration fixture exits 0", result.code, 0);
  expectIncludes("doctor integration fixture reports passed", result.output, "- Result: passed");
  expectIncludes("doctor integration fixture includes profile count", result.output, "1 profile(s)");

  rmSync(dir, { recursive: true });
}

console.log("\n--- integration fixture e2e: invalid downstream wiring fails with actionable diagnostics ---");
{
  const dir = makeFixtureRepo({
    workflow: "invalid-workflow.yml",
    prTemplate: "invalid-template.md",
    readme: "invalid-readme.md",
  });
  const result = runGuard(["--repo-root", dir, "validate-integration", "--format", "summary"]);

  expect("invalid fixture exits 1", result.code, 1);
  expectIncludes("invalid fixture reports failed", result.output, "- Result: failed");
  expectIncludes("invalid workflow reports event drift", result.output, "missing required pull_request type synchronize");
  expectIncludes("invalid workflow reports missing action", result.output, "must use netkeep80/repo-guard via uses");
  expectIncludes("invalid workflow reports manual clone", result.output, "must not clone repo-guard manually");
  expectIncludes("invalid template reports missing contract block", result.output, "requires a repo-guard-yaml fenced contract block");
  expectIncludes("invalid docs report missing file reference", result.output, "missing required file reference");
  expectIncludes("invalid docs report missing profile", result.output, "missing required profile mention");
  expectIncludes("invalid docs report missing contract field", result.output, "missing required contract field mention");

  rmSync(dir, { recursive: true });
}

console.log("\n--- integration fixture e2e: doctor --integration returns the same invalid rule failures ---");
{
  const dir = makeFixtureRepo({
    workflow: "invalid-workflow.yml",
    prTemplate: "invalid-template.md",
    readme: "invalid-readme.md",
  });
  const result = runGuard(["--repo-root", dir, "doctor", "--integration", "--format", "json"]);
  const parsed = JSON.parse(result.stdout);

  expect("doctor invalid fixture exits 1", result.code, 1);
  expectTrue("doctor reports workflow failure", parsed.ruleResults.some((rule) => rule.rule === "integration-workflows" && !rule.ok));
  expectTrue("doctor reports template failure", parsed.ruleResults.some((rule) => rule.rule === "integration-templates" && !rule.ok));
  expectTrue("doctor reports docs failure", parsed.ruleResults.some((rule) => rule.rule === "integration-docs" && !rule.ok));

  rmSync(dir, { recursive: true });
}

console.log(`\n${failures === 0 ? "All integration fixture e2e tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
