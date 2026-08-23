import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { integrationConstraintEntries } from "../dist/checks/integration-constraints.mjs";
import { extractIntegration } from "../dist/extractors/integration.mjs";
import { evaluateParallelReadiness } from "../dist/parallel-readiness.mjs";

const immutableSha = "0123456789abcdef0123456789abcdef01234567";
const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const schema = JSON.parse(readFileSync(resolve(projectRoot, "schemas/repo-policy.schema.json"), "utf-8"));
const validPolicy = JSON.parse(readFileSync(resolve(projectRoot, "tests/fixtures/valid-policy.json"), "utf-8"));
const validatePolicy = new Ajv({ allErrors: true }).compile(schema);

function readFixture(files) {
  return (path) => {
    if (!Object.hasOwn(files, path)) throw new Error(`missing fixture ${path}`);
    return files[path];
  };
}

function workflow(id, path, role, mode, events, extra = {}) {
  return {
    id,
    kind: "github_actions",
    path,
    role,
    expect: {
      events,
      action: { uses: "netkeep80/repo-guard", ref_pinning: "sha" },
      mode,
      enforcement: "blocking",
      ...extra,
    },
  };
}

function transactionYaml(ref = immutableSha) {
  return [
    "name: transaction", "on:", "  pull_request:", "    types: [opened, synchronize, reopened, ready_for_review]",
    "permissions:", "  contents: read", "  pull-requests: read", "jobs:", "  validate:", "    runs-on: ubuntu-latest", "    steps:",
    "      - uses: actions/checkout@v6", "        with:", "          fetch-depth: 0",
    `      - uses: netkeep80/repo-guard@${ref}`, "        with:", "          mode: check-pr", "          enforcement: blocking",
    "        env:", "          GH_TOKEN: ${{ github.token }}", "",
  ].join("\n");
}

function nativeYaml({ mergeGroup = true, checksRequested = true } = {}) {
  return [
    "name: state", "on:",
    ...(mergeGroup ? ["  merge_group:", ...(checksRequested ? ["    types: [checks_requested]"] : [])] : ["  pull_request:"]),
    "permissions:", "  contents: read", "jobs:", "  validate:", "    runs-on: ubuntu-latest", "    steps:",
    "      - uses: actions/checkout@v6", "        with:", "          fetch-depth: 0",
    `      - uses: netkeep80/repo-guard@${immutableSha}`, "        with:", "          mode: check-merge-group", "          enforcement: blocking", "",
  ].join("\n");
}

function portableYaml({ checkout = false, unsafeRun = false } = {}) {
  return [
    "name: coordinator", "on:", "  workflow_dispatch:", "permissions:", "  contents: write", "  pull-requests: write", "jobs:",
    "  integrate:", "    runs-on: ubuntu-latest", "    steps:",
    ...(checkout ? ["      - uses: actions/checkout@v6"] : []),
    `      - uses: netkeep80/repo-guard@${immutableSha}`, "        with:", "          mode: portable-coordinator", "          enforcement: blocking",
    ...(unsafeRun ? ["      - run: npm test"] : []), "",
  ].join("\n");
}

function integration(provider, options = {}) {
  const transaction = workflow("transaction", ".github/workflows/transaction.yml", "repo_guard_pr_gate", "check-pr", ["pull_request"]);
  const selected = provider === "github_merge_queue"
    ? workflow("state", ".github/workflows/state.yml", "repo_guard_merge_group_gate", "check-merge-group", ["merge_group"], { event_types: ["checks_requested"] })
    : workflow("coordinator", ".github/workflows/coordinator.yml", "repo_guard_portable_coordinator", "portable-coordinator", ["workflow_dispatch"]);
  const policy = { integration: { workflows: [transaction, selected] } };
  const files = {
    ".github/workflows/transaction.yml": transactionYaml(options.mutableAction ? "main" : immutableSha),
    ...(provider === "github_merge_queue"
      ? { ".github/workflows/state.yml": nativeYaml(options) }
      : { ".github/workflows/coordinator.yml": portableYaml(options) }),
  };
  return extractIntegration(policy, {
    repoRoot: "/tmp/repo",
    trackedFiles: Object.keys(files),
    readFile: readFixture(files),
  });
}

function parallelPolicy(role, mode) {
  return {
    ...validPolicy,
    integration: {
      workflows: [{
        id: "parallel-gate",
        kind: "github_actions",
        path: ".github/workflows/parallel.yml",
        role,
        expect: { mode },
      }],
    },
  };
}

function workflowConstraint(provider, options = {}) {
  const entry = integrationConstraintEntries(integration(provider, options)).find((item) => item.name === "integration-workflows");
  assert.ok(entry, "integration-workflows constraint entry must exist");
  return entry.check;
}

function constraintDetails(check) {
  return Array.isArray(check.details) ? check.details : [];
}

const commonControl = {
  targetBranch: "main",
  requiredChecks: ["CI / validate", "CI / smoke-pack"],
  pullRequestRequired: true,
  requiredChecksEnforced: true,
  noBypass: true,
};

function ids(report) {
  return report.blockers.map((item) => item.id);
}

{
  const report = evaluateParallelReadiness({
    provider: "github_merge_queue",
    integrationFacts: integration("github_merge_queue"),
    controlPlaneFacts: { ...commonControl, mergeQueueEnabled: true },
  });
  assert.equal(report.provider, "github_merge_queue");
  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.evidence.repository.transactionWorkflow, ".github/workflows/transaction.yml");
  assert.equal(report.evidence.repository.providerWorkflow, ".github/workflows/state.yml");
}

{
  const report = evaluateParallelReadiness({
    provider: "github_merge_queue",
    integrationFacts: integration("github_merge_queue", { mergeGroup: false }),
    controlPlaneFacts: { ...commonControl, mergeQueueEnabled: true },
  });
  assert.ok(ids(report).includes("missing_merge_group_event"));
  assert.equal(report.ready, false);
}

{
  const report = evaluateParallelReadiness({
    provider: "github_merge_queue",
    integrationFacts: integration("github_merge_queue", { checksRequested: false }),
    controlPlaneFacts: { ...commonControl, mergeQueueEnabled: true },
  });
  assert.ok(ids(report).includes("missing_checks_requested"));
}

{
  const report = evaluateParallelReadiness({
    provider: "portable",
    integrationFacts: integration("portable"),
    controlPlaneFacts: { ...commonControl, upToDateRequired: true },
  });
  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.evidence.repository.providerWorkflow, ".github/workflows/coordinator.yml");
}

{
  const report = evaluateParallelReadiness({
    provider: "portable",
    integrationFacts: integration("portable", { checkout: true }),
    controlPlaneFacts: { ...commonControl, upToDateRequired: true },
  });
  assert.ok(ids(report).includes("coordinator_checkout_forbidden"));
}

{
  const report = evaluateParallelReadiness({
    provider: "portable",
    integrationFacts: integration("portable", { unsafeRun: true }),
    controlPlaneFacts: { ...commonControl, upToDateRequired: true },
  });
  assert.ok(ids(report).includes("coordinator_project_execution_forbidden"));
}

{
  const report = evaluateParallelReadiness({
    provider: "portable",
    integrationFacts: integration("portable", { mutableAction: true }),
    controlPlaneFacts: { ...commonControl, upToDateRequired: true },
  });
  assert.ok(ids(report).includes("mutable_action_ref"));
}

{
  const report = evaluateParallelReadiness({
    provider: "portable",
    integrationFacts: integration("portable"),
    controlPlaneFacts: { ...commonControl, upToDateRequired: null },
  });
  assert.ok(ids(report).includes("unknown_up_to_date_requirement"));
  assert.equal(report.ready, false);
}

{
  const report = evaluateParallelReadiness({
    provider: "github_merge_queue",
    integrationFacts: integration("portable"),
    controlPlaneFacts: { ...commonControl, mergeQueueEnabled: true },
  });
  assert.ok(ids(report).includes("missing_native_state_gate"));
}

for (const [role, mode] of [
  ["repo_guard_merge_group_gate", "check-merge-group"],
  ["repo_guard_portable_coordinator", "portable-coordinator"],
]) {
  const ok = validatePolicy(parallelPolicy(role, mode));
  assert.equal(ok, true, `${role}/${mode} must be public schema-valid: ${JSON.stringify(validatePolicy.errors)}`);
}

{
  const check = workflowConstraint("github_merge_queue");
  assert.equal(check.ok, true, `native repository facts must satisfy integration constraints: ${JSON.stringify(check.details)}`);
}

{
  const check = workflowConstraint("github_merge_queue", { mergeGroup: false });
  assert.equal(check.ok, false);
  assert.ok(constraintDetails(check).some((detail) => detail.includes("missing_merge_group_event")), "native repository blocker id must be surfaced by the Constraint Program");
}

{
  const check = workflowConstraint("portable");
  assert.equal(check.ok, true, `portable repository facts must satisfy integration constraints: ${JSON.stringify(check.details)}`);
}

{
  const check = workflowConstraint("portable", { unsafeRun: true });
  assert.equal(check.ok, false);
  assert.ok(constraintDetails(check).some((detail) => detail.includes("coordinator_project_execution_forbidden")), "portable repository blocker id must be surfaced by the Constraint Program");
}

console.log("All parallel readiness tests passed");
