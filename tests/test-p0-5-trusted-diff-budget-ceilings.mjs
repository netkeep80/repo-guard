import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it, test } from "node:test";
import { compileConstraintProgram } from "../dist/checks/constraint-program.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
const BUDGET_FIELDS = ["max_new_docs", "max_new_files", "max_net_added_lines"];

function compiledBudget(field, policyLimit, intentLimit) {
  const diffRules = policyLimit === undefined ? {} : { [field]: policyLimit };
  const budgets = intentLimit === undefined ? {} : { [field]: intentLimit };
  const entry = compileConstraintProgram(
    { diff_rules: diffRules, paths: { forbidden: [], canonical_docs: [] } },
    { change_type: "bugfix", budgets },
  ).find((item) => item.key === `diff:${field}`);
  return entry?.runtime ?? null;
}

describe("trusted diff budget ceilings", () => {
  for (const field of BUDGET_FIELDS) {
    it(`${field}: absent/absent has no bound`, () => {
      assert.equal(compiledBudget(field, undefined, undefined), null);
    });
    it(`${field}: intent-only limit is active`, () => {
      assert.equal(compiledBudget(field, undefined, 7)?.parameters?.max, 7);
    });
    it(`${field}: policy-only limit is active`, () => {
      assert.equal(compiledBudget(field, 5, undefined)?.parameters?.max, 5);
    });
    it(`${field}: lower intent narrows the trusted ceiling`, () => {
      assert.equal(compiledBudget(field, 5, 3)?.parameters?.max, 3);
    });
    it(`${field}: equal intent preserves the trusted ceiling`, () => {
      assert.equal(compiledBudget(field, 5, 5)?.parameters?.max, 5);
    });
    it(`${field}: higher intent cannot widen the trusted ceiling`, () => {
      const runtime = compiledBudget(field, 5, 9);
      assert.equal(runtime?.parameters?.max, 5);
      assert.equal(runtime?.parameters?.policy_limit, 5);
      assert.equal(runtime?.parameters?.intent_limit, 9);
      assert.equal(runtime?.parameters?.effective_limit, 5);
    });
    it(`${field}: zero policy ceiling cannot be widened`, () => {
      assert.equal(compiledBudget(field, 0, 100)?.parameters?.max, 0);
    });
  }
});

const intent = `\`\`\`repo-guard-yaml
change_type: bugfix
scope:
  - "**"
budgets:
  max_new_files: 100
  max_net_added_lines: 1000
anchors: { affects: [], implements: [], verifies: [] }
must_touch: []
must_not_touch: []
expected_effects:
  - "one new file remains subject to trusted policy ceiling"
\`\`\``;

test("public check-pr blocks PR-controlled widening of policy max_new_files=0", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-p05-budget-"));
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "test@test.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "repo-policy.json"), JSON.stringify({
      policy_format_version: "0.3.0",
      repository_kind: "library",
      enforcement: { mode: "blocking" },
      paths: { forbidden: [], canonical_docs: [], governance_paths: [] },
      diff_rules: { max_new_files: 0, max_net_added_lines: 1000 },
      content_rules: [],
      cochange_rules: [],
    }));
    writeFileSync(join(root, "seed.txt"), "seed\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "base");

    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/new.mjs"), "export const value = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "add file");

    const eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      pull_request: {
        number: 42,
        base: { sha: "HEAD~1", ref: "main" },
        head: { sha: "HEAD" },
        body: intent,
      },
      repository: { full_name: "owner/repo" },
    }));

    const result = spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], {
      cwd: root,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
      encoding: "utf-8",
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /FAIL: max-new-files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
