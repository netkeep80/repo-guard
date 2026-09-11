import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { defaultRuleFamilies } from "../dist/checks/default-rule-families.mjs";
import { listBuiltInPacks } from "../dist/policy-profiles.mjs";
import { renderInitScaffold } from "../dist/init.mjs";

const ACCEPTED_BASE = "25560cf62e3336cdd089a779a9032db01b0c71f1";
const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
const policyText = read("repo-policy.json");
const policy = JSON.parse(policyText);
const acceptedPolicyText = execFileSync("git", ["show", `${ACCEPTED_BASE}:repo-policy.json`], { encoding: "utf8" });
const acceptedPolicy = JSON.parse(acceptedPolicyText);

const workflow = parseYaml(read(".github/workflows/ci.yml"));
const validateSteps = workflow.jobs.validate.steps;
const smokeSteps = workflow.jobs["smoke-pack"].steps;
const validateRuns = validateSteps.map((step) => step.run || "").join("\n");
const smokeRuns = smokeSteps.map((step) => step.run || "").join("\n");
const localActionStep = validateSteps.find((step) => step.uses === "./");

const exceptions = json("docs/self-hosting-coverage.json").exceptions;
const exceptionKeys = Object.keys(exceptions);
const commandExceptions = new Set(exceptionKeys.filter((key) => key.startsWith("command:")).map((key) => key.slice("command:".length)));
const observedCommands = new Set([
  ...(validateRuns.includes("npx repo-guard\n") || validateRuns.includes("run: npx repo-guard") ? ["validate"] : []),
  ...(validateRuns.includes("repo-guard doctor") ? ["doctor"] : []),
  ...(validateRuns.includes("check-diff") ? ["check-diff"] : []),
  ...(localActionStep?.with?.mode === "check-pr" ? ["check-pr"] : []),
]);

const expectedGovernanceAdditions = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "scripts/build.mjs",
  "scripts/check-dist.mjs",
  "scripts/verify-release-ref.mjs",
];

const expectedDocuments = {
  package: { path: "package.json", format: "json" },
  action: { path: "action.yml", format: "yaml" },
};
const expectedRelations = [
  {
    id: "package-main-matches-bin",
    kind: "scalar_equal",
    left: { document: "package", pointer: "/main", type: "string" },
    right: { document: "package", pointer: "/bin/repo-guard", type: "string" },
  },
  {
    id: "package-main-entrypoint",
    kind: "scalar_equals_literal",
    source: { document: "package", pointer: "/main", type: "string" },
    value: "dist/repo-guard.mjs",
  },
  {
    id: "action-default-mode",
    kind: "scalar_equals_literal",
    source: { document: "action", pointer: "/inputs/mode/default", type: "string" },
    value: "check-pr",
  },
  {
    id: "action-default-enforcement",
    kind: "scalar_equals_literal",
    source: { document: "action", pointer: "/inputs/enforcement/default", type: "string" },
    value: "blocking",
  },
];

const relationById = new Map((policy.document_relations?.rules || []).map((rule) => [rule.id, rule]));

describe("C3.4b canonical self-host exemplar", () => {
  it("compresses the own policy relative to the accepted C3.4b base", () => {
    for (const key of ["surfaces", "new_file_classes", "change_profiles"]) {
      assert.equal(Object.hasOwn(policy, key), false, `${key} must be absent from the own policy`);
    }
    assert.ok(Buffer.byteLength(policyText) < Buffer.byteLength(acceptedPolicyText), "own policy must shrink in bytes");
    assert.ok(Object.keys(policy).length < Object.keys(acceptedPolicy).length, "own policy must shrink in top-level concepts");
  });

  it("protects the real build, package and release authority without governance inflation", () => {
    const governance = new Set(policy.paths?.governance_paths || []);
    for (const path of expectedGovernanceAdditions) assert.ok(governance.has(path), `missing governance path: ${path}`);
    assert.equal(governance.has("scripts/compression-metrics.mjs"), false);
  });

  it("uses exactly the selected real generic document relations", () => {
    assert.deepEqual(policy.document_relations?.documents, expectedDocuments);
    assert.equal(relationById.size, expectedRelations.length);
    for (const expected of expectedRelations) assert.deepEqual(relationById.get(expected.id), expected);
  });

  it("derives the real self-host execution topology from the live CI and repository forms", () => {
    assert.match(validateRuns, /npm run check:dist/);
    assert.match(validateRuns, /npm run compression:metrics/);
    assert.match(validateRuns, /npx repo-guard(?:\n|$)/);
    assert.match(validateRuns, /npx repo-guard doctor/);
    assert.match(validateRuns, /node tests\/run\.mjs/);
    assert.ok(localActionStep);
    assert.equal(localActionStep.with?.mode, "check-pr");
    assert.equal(localActionStep.with?.enforcement, "blocking");
    assert.match(validateRuns, /--enforcement advisory check-diff/);
    assert.match(smokeRuns, /npm pack/);
    assert.match(smokeRuns, /npm install --prefix/);
    assert.match(smokeRuns, /node_modules\/\.bin\/repo-guard/);
    assert.match(read(".github/PULL_REQUEST_TEMPLATE.md"), /```repo-guard-yaml/);
    assert.match(read(".github/ISSUE_TEMPLATE/change-intent.yml"), /```repo-guard-yaml/);
  });

  it("derives command, rule-family and pack authority instead of duplicating it", () => {
    for (const command of COMMANDS) {
      assert.ok(observedCommands.has(command) || commandExceptions.has(command), `command is neither self-hosted nor excepted: ${command}`);
    }
    assert.deepEqual([...commandExceptions].sort(), ["init"]);

    const ruleIds = new Set(defaultRuleFamilies.map((family) => family.id));
    const packs = new Set(listBuiltInPacks());
    for (const key of exceptionKeys) {
      const reason = exceptions[key];
      assert.equal(typeof reason, "string");
      assert.ok(reason.trim().length > 0, `empty self-host exception reason: ${key}`);
      if (key.startsWith("rule:")) assert.ok(ruleIds.has(key.slice("rule:".length)), `unknown rule exception: ${key}`);
      if (key.startsWith("pack:")) assert.ok(packs.has(key.slice("pack:".length)), `unknown pack exception: ${key}`);
    }
  });

  it("keeps generated consumer scaffold aligned with the accepted public contract", () => {
    const scaffold = renderInitScaffold({
      preset: "application",
      mode: "blocking",
      actionRef: "0123456789abcdef0123456789abcdef01234567",
    });
    assert.equal(JSON.parse(scaffold["repo-policy.json"]).policy_format_version, "0.3.0");
    const consumerWorkflow = parseYaml(scaffold[".github/workflows/repo-guard.yml"]);
    const steps = Object.values(consumerWorkflow.jobs || {}).flatMap((job) => job.steps || []);
    assert.ok(steps.some((step) => step.uses === "actions/checkout@v6"));
    assert.deepEqual(consumerWorkflow.permissions, { contents: "read", "pull-requests": "read", issues: "read" });
    assert.match(scaffold[".github/workflows/repo-guard.yml"], /fetch-depth: 0/);
    assert.doesNotMatch(Object.values(scaffold).join("\n"), /surface_debt/);
  });
});
