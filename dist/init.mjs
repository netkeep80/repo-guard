import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { normalizeEnforcementMode } from "./enforcement.mjs";
const ACTION = "netkeep80/repo-guard";
const PRESETS = {
    application: ["application", ["*.bak", "*.log"], ["README.md"], { max_new_docs: 3, max_new_files: 20, max_net_added_lines: 1500 }, []],
    library: ["library", ["*.bak"], ["README.md", "CHANGELOG.md"], { max_new_docs: 2, max_new_files: 15, max_net_added_lines: 1000 }, [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }]],
    tooling: ["tooling", ["*.bak"], ["README.md"], { max_new_docs: 2, max_new_files: 15, max_net_added_lines: 2000 }, [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }]],
    documentation: ["documentation", [], ["README.md"], { max_new_docs: 10, max_new_files: 20 }, []],
};
function buildPolicy(name, mode) {
    const [repository_kind, forbidden, canonical_docs, diff_rules, cochange_rules] = PRESETS[name];
    return { policy_format_version: "0.3.0", repository_kind, enforcement: { mode }, paths: { forbidden, canonical_docs, governance_paths: ["repo-policy.json"] }, diff_rules, content_rules: [], cochange_rules };
}
function actionRef(packageRoot) {
    const version = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8")).version;
    if (!version)
        throw new Error("Cannot determine repo-guard package version");
    return `v${version}`;
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
function writeIfAbsent(path, content, created, skipped) {
    if (existsSync(path))
        return skipped.push(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    created.push(path);
}
const usage = `Usage: repo-guard init [--preset <preset>] [--mode <mode>]\nPresets: application, library, tooling, documentation`;
export function runInit(roots, args = []) {
    let preset = "application", mode = roots.enforcementMode || "enforce";
    for (let i = 0; i < args.length; i++) {
        if (["--preset", "--mode", "--enforcement"].includes(args[i]) && args[i + 1]) {
            const value = args[++i];
            if (args[i - 1] === "--preset")
                preset = value;
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
    const created = [], skipped = [], root = roots.repoRoot;
    writeIfAbsent(resolve(root, "repo-policy.json"), `${JSON.stringify(buildPolicy(preset, enforcement.mode), null, 2)}\n`, created, skipped);
    writeIfAbsent(resolve(root, ".github/workflows/repo-guard.yml"), workflow(enforcement.mode, actionRef(roots.packageRoot)), created, skipped);
    writeIfAbsent(resolve(root, ".github/PULL_REQUEST_TEMPLATE.md"), prTemplate(), created, skipped);
    writeIfAbsent(resolve(root, ".github/ISSUE_TEMPLATE/change-intent.yml"), issueTemplate(), created, skipped);
    console.log(`repo-guard init (preset: ${preset}, enforcement: ${enforcement.mode})`);
    if (created.length)
        console.log(`Created:\n${created.map((path) => `  ${relative(root, path)}`).join("\n")}`);
    if (skipped.length)
        console.log(`Skipped (already exist):\n${skipped.map((path) => `  ${relative(root, path)}`).join("\n")}`);
    return 0;
}
