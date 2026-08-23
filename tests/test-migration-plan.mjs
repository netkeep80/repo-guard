import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

const OLD_SHA = "1111111111111111111111111111111111111111";
const TARGET_SHA = "2222222222222222222222222222222222222222";
const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";
const PR_TEMPLATE = ".github/PULL_REQUEST_TEMPLATE.md";
const ISSUE_TEMPLATE = ".github/ISSUE_TEMPLATE/change-intent.yml";

const V2_POLICY = `${JSON.stringify({
  policy_format_version: "0.3.0",
  repository_kind: "application",
  enforcement: { mode: "blocking" },
  paths: {
    forbidden: ["*.bak", "*.log"],
    canonical_docs: ["README.md"],
    governance_paths: ["repo-policy.json"],
  },
  diff_rules: { max_new_docs: 3, max_new_files: 20, max_net_added_lines: 1500 },
  content_rules: [],
  cochange_rules: [],
}, null, 2)}\n`;

const legacyWorkflow = (ref) => `name: Проверка политики repo-guard
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]
jobs:
  policy-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Проверить политику репозитория
        uses: netkeep80/repo-guard@${ref}
        with: { mode: check-pr, enforcement: blocking }
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

const portableCoordinator = (ref) => `name: Portable coordinator repo-guard
on:
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  checks: read
jobs:
  integrate:
    runs-on: ubuntu-latest
    steps:
      - name: Интегрировать один READY-кандидат
        uses: netkeep80/repo-guard@${ref}
        with:
          mode: portable-coordinator
          enforcement: blocking
          repository: \${{ github.repository }}
          ready-label: repo-guard:ready
          merge-method: squash
          transaction-checks: |
            policy-check
          state-checks: |
            policy-check
          format: json
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

const V2_PR_TEMPLATE = `## Краткое описание

## Намерение изменения

\`\`\`repo-guard-yaml
change_type: feature
scope:
  - src/**
budgets: {}
anchors:
  affects: []
  implements: []
  verifies: []
must_touch: []
must_not_touch: []
expected_effects:
  - Опишите ожидаемый эффект
\`\`\`
`;

function legacyMigrationFiles(ref) {
  return {
    [POLICY]: V2_POLICY,
    [TRANSACTION]: legacyWorkflow(ref),
    [PORTABLE]: null,
    [NATIVE]: null,
  };
}

function actionSummary(plan) {
  return plan.files.map(({ path, action }) => ({ path, action }));
}

describe("P5a compatibility corpus and pure migration plan", () => {
  it("locks the v2 legacy scaffold and exposes the same pure init renderer", async () => {
    const { renderInitScaffold } = await import("../dist/init.mjs");
    assert.equal(typeof renderInitScaffold, "function");

    const rendered = renderInitScaffold({
      preset: "application",
      mode: "blocking",
      actionRef: OLD_SHA,
      parallel: null,
    });

    assert.deepEqual(Object.keys(rendered).sort(), [POLICY, TRANSACTION, PR_TEMPLATE, ISSUE_TEMPLATE].sort());
    assert.equal(rendered[POLICY], V2_POLICY);
    assert.equal(rendered[TRANSACTION], legacyWorkflow(OLD_SHA));
    assert.equal(rendered[PR_TEMPLATE], V2_PR_TEMPLATE);
    assert.match(rendered[PR_TEMPLATE], /repo-guard-yaml/);
    assert.match(rendered[PR_TEMPLATE], /change_type: feature/);
    assert.match(rendered[TRANSACTION], new RegExp(`repo-guard@${OLD_SHA}`));
  });

  it("plans portable preparation from an exact repinned v2 scaffold without writes", async () => {
    const { planParallelMigration } = await import("../dist/migration-plan.mjs");
    const before = legacyMigrationFiles(TARGET_SHA);
    const frozen = structuredClone(before);

    const plan = planParallelMigration({ provider: "portable", actionRef: TARGET_SHA, files: before });

    assert.equal(plan.readyToApply, true, JSON.stringify(plan.blockers));
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(actionSummary(plan), [
      { path: PORTABLE, action: "create" },
      { path: TRANSACTION, action: "replace" },
      { path: POLICY, action: "replace" },
    ]);
    assert.deepEqual(plan.external.map(({ id }) => id), ["branch_protection", "ready_label"]);
    assert.deepEqual(before, frozen, "pure planner must not mutate repository facts");
    assert.match(plan.files.find(({ path }) => path === PORTABLE).after, /mode: portable-coordinator/);
  });

  it("resumes a known partial portable preparation idempotently", async () => {
    const { planParallelMigration } = await import("../dist/migration-plan.mjs");
    const files = { ...legacyMigrationFiles(TARGET_SHA), [PORTABLE]: portableCoordinator(TARGET_SHA) };
    const plan = planParallelMigration({ provider: "portable", actionRef: TARGET_SHA, files });

    assert.equal(plan.readyToApply, true, JSON.stringify(plan.blockers));
    assert.deepEqual(actionSummary(plan), [
      { path: PORTABLE, action: "unchanged" },
      { path: TRANSACTION, action: "replace" },
      { path: POLICY, action: "replace" },
    ]);
  });

  it("fails closed when a repository-owned workflow is not an exact known template", async () => {
    const { planParallelMigration } = await import("../dist/migration-plan.mjs");
    const files = legacyMigrationFiles(TARGET_SHA);
    files[TRANSACTION] += "# custom repository step\n";

    const plan = planParallelMigration({ provider: "portable", actionRef: TARGET_SHA, files });

    assert.equal(plan.readyToApply, false);
    assert.deepEqual(plan.blockers.map(({ id, path }) => ({ id, path })), [
      { id: "custom_file", path: TRANSACTION },
    ]);
    assert.equal(plan.files.find(({ path }) => path === TRANSACTION).action, "blocked");
  });

  it("plans the same migration protocol for github_merge_queue", async () => {
    const { planParallelMigration } = await import("../dist/migration-plan.mjs");
    const plan = planParallelMigration({
      provider: "github_merge_queue",
      actionRef: TARGET_SHA,
      files: legacyMigrationFiles(TARGET_SHA),
    });

    assert.equal(plan.readyToApply, true, JSON.stringify(plan.blockers));
    assert.deepEqual(actionSummary(plan), [
      { path: NATIVE, action: "create" },
      { path: TRANSACTION, action: "replace" },
      { path: POLICY, action: "replace" },
    ]);
    assert.deepEqual(plan.external.map(({ id }) => id), ["merge_queue"]);
    const native = plan.files.find(({ path }) => path === NATIVE).after;
    assert.match(native, /^\s*merge_group:$/m);
    assert.match(native, /mode: check-merge-group/);
    assert.doesNotMatch(native, /workflow_dispatch/);
  });
});
