import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { normalizeEnforcementMode } from "./enforcement.mjs";
const ACTION = "netkeep80/repo-guard";
const FULL_SHA = /^[0-9a-f]{40}$/i;
const VERSION_TAG = /^v\d+\.\d+\.\d+$/;
const PRESETS = {
    application: ["application", ["*.bak", "*.log"], ["README.md"], { max_new_docs: 3, max_new_files: 20, max_net_added_lines: 1500 }, []],
    library: ["library", ["*.bak"], ["README.md", "CHANGELOG.md"], { max_new_docs: 2, max_new_files: 15, max_net_added_lines: 1000 }, [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }]],
    tooling: ["tooling", ["*.bak"], ["README.md"], { max_new_docs: 2, max_new_files: 15, max_net_added_lines: 2000 }, [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }]],
    documentation: ["documentation", [], ["README.md"], { max_new_docs: 10, max_new_files: 20 }, []],
};
function parallelIntegration(provider, mode, ref) {
    const ref_pinning = FULL_SHA.test(ref) ? "sha" : "tag";
    const transaction = {
        id: "repo-guard-pr-gate",
        kind: "github_actions",
        path: ".github/workflows/repo-guard.yml",
        role: "repo_guard_pr_gate",
        expect: {
            events: ["pull_request"],
            event_types: ["opened", "synchronize", "reopened", "ready_for_review"],
            action: { uses: ACTION, ref_pinning },
            mode: "check-pr",
            enforcement: mode,
            permissions: { contents: "read", "pull-requests": "read", issues: "read" },
            token_env: ["GH_TOKEN"],
        },
    };
    const providerWorkflow = provider === "portable"
        ? {
            id: "repo-guard-portable-coordinator",
            kind: "github_actions",
            path: ".github/workflows/repo-guard-portable-coordinator.yml",
            role: "repo_guard_portable_coordinator",
            expect: {
                events: ["workflow_dispatch"],
                action: { uses: ACTION, ref_pinning },
                mode: "portable-coordinator",
                enforcement: "blocking",
                permissions: { contents: "write", "pull-requests": "write", checks: "read" },
                token_env: ["GH_TOKEN"],
            },
        }
        : {
            id: "repo-guard-merge-group",
            kind: "github_actions",
            path: ".github/workflows/repo-guard-merge-group.yml",
            role: "repo_guard_merge_group_gate",
            expect: {
                events: ["merge_group"],
                event_types: ["checks_requested"],
                action: { uses: ACTION, ref_pinning },
                mode: "check-merge-group",
                enforcement: "blocking",
                permissions: { contents: "read" },
            },
        };
    return { workflows: [transaction, providerWorkflow] };
}
function buildPolicy(name, mode, parallel = null, ref = null) {
    const [repository_kind, forbidden, canonical_docs, diff_rules, cochange_rules] = PRESETS[name];
    const policy = { policy_format_version: "0.3.0", repository_kind, enforcement: { mode }, paths: { forbidden, canonical_docs, governance_paths: ["repo-policy.json"] }, diff_rules, content_rules: [], cochange_rules };
    return parallel && ref ? { ...policy, integration: parallelIntegration(parallel, mode, ref) } : policy;
}
function packageVersion(packageRoot) {
    const version = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8")).version;
    if (!version || typeof version !== "string")
        throw new Error("Cannot determine repo-guard package version");
    return version;
}
export function expectedTagForVersion(version) {
    if (!version || typeof version !== "string")
        throw new Error("Cannot determine repo-guard package version");
    return `v${version}`;
}
export function validateExplicitActionRef(ref, version) {
    const candidate = typeof ref === "string" ? ref.trim() : "", expectedTag = expectedTagForVersion(version);
    if (!candidate)
        return { ok: false, expectedTag, message: `repo-guard init refuses to invent an Action ref; pass --action-ref <40-char-sha|${expectedTag}>` };
    if (FULL_SHA.test(candidate))
        return { ok: true, ref: candidate, kind: "sha", expectedTag };
    if (VERSION_TAG.test(candidate))
        return candidate === expectedTag
            ? { ok: true, ref: candidate, kind: "release-tag", expectedTag }
            : { ok: false, expectedTag, message: `Action ref ${candidate} does not match package.json version ${version}; expected ${expectedTag}` };
    return { ok: false, expectedTag, message: `Action ref ${candidate} is mutable or ambiguous; use a full 40-character commit SHA or ${expectedTag}` };
}
const workflow = (mode, ref) => `name: Проверка политики repo-guard
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
        uses: ${ACTION}@${ref}
        with: { mode: check-pr, enforcement: ${mode} }
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
const parallelTransactionWorkflow = (mode, ref) => `name: Проверка политики repo-guard
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]
permissions:
  contents: read
  pull-requests: read
  issues: read
jobs:
  policy-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Проверить политику репозитория
        uses: ${ACTION}@${ref}
        with: { mode: check-pr, enforcement: ${mode} }
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
const portableCoordinatorWorkflow = (ref) => `name: Portable coordinator repo-guard
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
        uses: ${ACTION}@${ref}
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
const nativeMergeGroupWorkflow = (ref) => `name: Merge-group state repo-guard
on:
  merge_group:
    types: [checks_requested]
permissions:
  contents: read
jobs:
  policy-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Проверить состояние merge-group
        uses: ${ACTION}@${ref}
        with: { mode: check-merge-group, enforcement: blocking }
`;
const prTemplate = () => `## Краткое описание

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
const issueTemplate = () => `name: Намерение изменения
description: Предложить изменение с ChangeIntent и, при необходимости, GovernanceGrant.
title: "[change] "
body:
  - type: textarea
    id: description
    attributes: { label: Описание, description: Что меняется и зачем? }
    validations: { required: true }
  - type: textarea
    id: change_intent
    attributes:
      label: ChangeIntent
      description: Обычное намерение изменения; не даёт управляющих разрешений.
      value: |
        \`\`\`repo-guard-yaml
        change_type: feature
        scope: ["src/**"]
        budgets: {}
        anchors: { affects: [], implements: [], verifies: [] }
        must_touch: []
        must_not_touch: []
        expected_effects: ["Опишите ожидаемый эффект"]
        \`\`\`
    validations: { required: true }
  - type: textarea
    id: governance_grant
    attributes:
      label: GovernanceGrant (только для управляющих изменений)
      description: Оставьте пустым для обычной задачи. Grant доверяется только из связанной задачи.
      value: |
        \`\`\`repo-guard-grant
        authorized_governance_paths:
          - repo-policy.json
        allow_policy_relaxation: []
        \`\`\`
    validations: { required: false }
`;
export function renderInitScaffold({ preset, mode, actionRef, parallel = null }) {
    const rendered = {
        "repo-policy.json": `${JSON.stringify(buildPolicy(preset, mode, parallel, actionRef), null, 2)}\n`,
        ".github/workflows/repo-guard.yml": parallel ? parallelTransactionWorkflow(mode, actionRef) : workflow(mode, actionRef),
    };
    if (parallel === "portable")
        rendered[".github/workflows/repo-guard-portable-coordinator.yml"] = portableCoordinatorWorkflow(actionRef);
    if (parallel === "github_merge_queue")
        rendered[".github/workflows/repo-guard-merge-group.yml"] = nativeMergeGroupWorkflow(actionRef);
    rendered[".github/PULL_REQUEST_TEMPLATE.md"] = prTemplate();
    rendered[".github/ISSUE_TEMPLATE/change-intent.yml"] = issueTemplate();
    return rendered;
}
function writeIfAbsent(path, content, created, skipped) {
    if (existsSync(path))
        return skipped.push(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    created.push(path);
}
const usage = `Usage: repo-guard init --action-ref <40-char-sha|vX.Y.Z> [--preset <preset>] [--mode <mode>] [--parallel <portable|github_merge_queue>]\nPresets: application, library, tooling, documentation`;
export function runInit(roots, args = []) {
    let preset = "application", mode = roots.enforcementMode || "enforce", actionRef = null, parallel = null;
    for (let i = 0; i < args.length; i++) {
        if (["--preset", "--mode", "--enforcement", "--action-ref", "--parallel"].includes(args[i]) && args[i + 1]) {
            const option = args[i], value = args[++i];
            if (option === "--preset")
                preset = value;
            else if (option === "--action-ref")
                actionRef = value;
            else if (option === "--parallel") {
                if (value !== "portable" && value !== "github_merge_queue") {
                    console.error(`Unknown parallel provider: ${value}\n${usage}`);
                    return 1;
                }
                parallel = value;
            }
            else
                mode = value;
        }
        else if (args[i] === "--help") {
            console.log(usage);
            return 0;
        }
        else {
            console.error(`Unknown option for init: ${args[i]}\n${usage}`);
            return 1;
        }
    }
    if (!PRESETS[preset]) {
        console.error(`Unknown preset: ${preset}\n${usage}`);
        return 1;
    }
    const enforcement = normalizeEnforcementMode(mode, "mode");
    if (!enforcement.ok) {
        console.error(enforcement.message);
        return 1;
    }
    let refCheck;
    try {
        refCheck = validateExplicitActionRef(actionRef, packageVersion(roots.packageRoot));
    }
    catch (error) {
        console.error(error.message);
        return 1;
    }
    if (!refCheck.ok) {
        console.error(refCheck.message);
        return 1;
    }
    const created = [], skipped = [], root = roots.repoRoot, ref = refCheck.ref;
    const rendered = renderInitScaffold({ preset: preset, mode: enforcement.mode, actionRef: ref, parallel });
    for (const [path, content] of Object.entries(rendered))
        writeIfAbsent(resolve(root, path), content, created, skipped);
    console.log(`repo-guard init (preset: ${preset}, enforcement: ${enforcement.mode}, action-ref: ${ref}${parallel ? `, parallel: ${parallel}` : ""})`);
    if (created.length)
        console.log(`Created:\n${created.map((path) => `  ${relative(root, path)}`).join("\n")}`);
    if (skipped.length)
        console.log(`Skipped (already exist):\n${skipped.map((path) => `  ${relative(root, path)}`).join("\n")}`);
    return 0;
}
