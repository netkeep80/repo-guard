import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYaml } from "../dist/document-facts.mjs";
import { extractIntegration } from "../dist/extractors/integration.mjs";
import { evaluateParallelReadiness } from "../dist/parallel-readiness.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const coordinatorPath = ".github/workflows/repo-guard-portable-coordinator.yml";
const selfCiPath = ".github/workflows/ci.yml";
const acceptedSelfPin = "f9aae6f6de54b434f7645494637e10f64d4e7577";
const read = (path) => readFileSync(resolve(projectRoot, path), "utf8");
const policy = JSON.parse(read("repo-policy.json"));

function integrationTrackedFiles() {
  return [...new Set([
    ...(policy.integration?.workflows || []).map((item) => item.path),
    ...(policy.integration?.templates || []).map((item) => item.path),
    ...(policy.integration?.docs || []).map((item) => item.path),
    ...(policy.integration?.profiles || []).map((item) => item.doc_path),
  ])];
}

describe("P6a portable self-host repository wiring", () => {
  it("declares the portable coordinator alongside the existing self PR gate", () => {
    const transaction = policy.integration.workflows.find((item) => item.role === "repo_guard_pr_gate");
    const coordinator = policy.integration.workflows.find((item) => item.role === "repo_guard_portable_coordinator");

    assert.ok(transaction, "existing self PR gate must remain declared");
    assert.equal(transaction.path, selfCiPath);
    assert.ok(coordinator, "portable self-host coordinator must be declared");
    assert.equal(coordinator.path, coordinatorPath);
    assert.deepEqual(coordinator.expect, {
      events: ["workflow_dispatch"],
      action: { uses: "netkeep80/repo-guard", ref_pinning: "sha" },
      mode: "portable-coordinator",
      enforcement: "blocking",
      permissions: {
        contents: "write",
        "pull-requests": "write",
        checks: "read",
      },
      token_env: ["GH_TOKEN"],
    });
  });

  it("pins a privileged-safe coordinator to the accepted exact self SHA and real CI checks", () => {
    assert.equal(existsSync(resolve(projectRoot, coordinatorPath)), true, "portable coordinator workflow must exist");
    const text = read(coordinatorPath);
    const workflow = parseYaml(text);
    const step = workflow.jobs?.integrate?.steps?.find((item) => item.uses?.startsWith("netkeep80/repo-guard@"));

    assert.deepEqual(workflow.permissions, {
      contents: "write",
      "pull-requests": "write",
      checks: "read",
    });
    assert.ok(step, "portable coordinator Action step must exist");
    assert.equal(step.uses, `netkeep80/repo-guard@${acceptedSelfPin}`);
    assert.equal(step.with.mode, "portable-coordinator");
    assert.equal(step.with.enforcement, "blocking");
    assert.equal(step.with["ready-label"], "repo-guard:ready");
    assert.equal(step.with["merge-method"], "squash");
    assert.equal(step.with["transaction-checks"], "validate\nsmoke-pack\n");
    assert.equal(step.with["state-checks"], "validate\nsmoke-pack\n");
    assert.equal(step.env.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
    assert.equal(workflow.jobs.integrate.steps.some((item) => item.uses?.startsWith("actions/checkout@")), false);
    assert.equal(workflow.jobs.integrate.steps.some((item) => typeof item.run === "string"), false);
  });

  it("executes canonical portable readiness against real GitHub facts in self CI", () => {
    const workflow = parseYaml(read(selfCiPath));
    const step = workflow.jobs?.validate?.steps?.find((item) => item.run === "npx repo-guard doctor --parallel portable");

    assert.ok(step, "self CI must execute doctor --parallel portable");
    assert.equal(step.env?.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
  });

  it("is repository-ready when the separate portable control-plane facts are green", () => {
    assert.equal(existsSync(resolve(projectRoot, coordinatorPath)), true, "portable coordinator workflow must exist before readiness evaluation");
    const integrationFacts = extractIntegration(policy, {
      repoRoot: projectRoot,
      trackedFiles: integrationTrackedFiles(),
      readFile: read,
    });
    const report = evaluateParallelReadiness({
      provider: "portable",
      integrationFacts,
      controlPlaneFacts: {
        targetBranch: "main",
        requiredChecks: ["validate", "smoke-pack"],
        pullRequestRequired: true,
        requiredChecksEnforced: true,
        noBypass: true,
        upToDateRequired: true,
      },
    });

    assert.equal(report.ready, true, JSON.stringify(report.blockers));
    assert.deepEqual(report.blockers, []);
    assert.equal(report.evidence.repository.transactionWorkflow, selfCiPath);
    assert.equal(report.evidence.repository.providerWorkflow, coordinatorPath);
  });
});
