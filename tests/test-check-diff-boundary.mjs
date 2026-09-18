import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckDiff } from "../dist/check-diff.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeTree(repoRoot, files) {
  for (const [path, value] of Object.entries(files)) {
    const absolute = join(repoRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, value);
  }
}

function policy() {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
    },
    diff_rules: { max_new_docs: 10, max_new_files: 10, max_net_added_lines: 1000 },
    content_rules: [],
    cochange_rules: [],
  };
}

function intent({ scope = ["public/**"], mustTouch = [], mustNotTouch = ["private/**"] } = {}) {
  return {
    change_type: "bugfix",
    scope,
    budgets: {},
    anchors: { affects: [], implements: [], verifies: [] },
    must_touch: mustTouch,
    must_not_touch: mustNotTouch,
    expected_effects: ["Verify rename-aware ChangeIntent path boundaries"],
  };
}

function makeRepo(changeIntent, initialFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-check-diff-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "diff.renames", "true");
  writeTree(dir, {
    "repo-policy.json": JSON.stringify(policy(), null, 2),
    "change-intent.json": JSON.stringify(changeIntent, null, 2),
    "README.md": "# Test\n",
    ...initialFiles,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  return dir;
}

function runIntent(repoRoot) {
  const executed = spawnSync(process.execPath, [
    resolve(root, "dist/repo-guard.mjs"),
    "--repo-root", repoRoot,
    "--enforcement", "blocking",
    "check-diff",
    "--change-intent", "change-intent.json",
    "--format", "json",
  ], { cwd: repoRoot, encoding: "utf-8" });
  if (executed.error) throw executed.error;
  const result = {
    code: executed.status ?? 1,
    stdout: executed.stdout,
    stderr: executed.stderr,
    output: `${executed.stdout}${executed.stderr}`,
  };
  return { result, report: JSON.parse(result.stdout) };
}

function violation(report, rule) {
  return report.violations.find((item) => item.rule === rule);
}

describe("check-diff facade boundary", () => {
  it("rejects an unknown output format without terminating imported callers", () => {
    const originalError = console.error, errors = [];
    console.error = (...args) => errors.push(args.join(" "));
    try {
      assert.equal(runCheckDiff({ packageRoot: root, repoRoot: root }, ["--format", "xml"]), 1);
      assert.match(errors.join("\n"), /Unknown check-diff format: xml/);
    } finally {
      console.error = originalError;
    }
  });

  it("uses both Git rename identities for ChangeIntent scope and must_not_touch", async () => {
    const repoRoot = makeRepo(intent(), { "private/authority.md": "authority\n" });
    try {
      mkdirSync(join(repoRoot, "public"), { recursive: true });
      git(repoRoot, "mv", "private/authority.md", "public/authority.md");
      const { result, report } = await runIntent(repoRoot);
      assert.equal(result.code, 1, `rename-away unexpectedly passed: ${result.output}`);

      const scope = violation(report, "change-intent-scope");
      const mustNotTouch = violation(report, "must-not-touch");
      assert.ok(scope, "scope must reject the previous private path");
      assert.ok(mustNotTouch, "must_not_touch must reject the previous private path");
      assert.deepEqual(scope.data.source_values, ["private/authority.md"]);
      assert.deepEqual(mustNotTouch.data.source_values, ["private/authority.md"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects rename into a forbidden destination and permits rename wholly inside scope", async () => {
    const intoRoot = makeRepo(intent(), { "public/authority.md": "authority\n" });
    try {
      mkdirSync(join(intoRoot, "private"), { recursive: true });
      git(intoRoot, "mv", "public/authority.md", "private/authority.md");
      const { result, report } = await runIntent(intoRoot);
      assert.equal(result.code, 1);
      assert.deepEqual(violation(report, "change-intent-scope")?.data?.source_values, ["private/authority.md"]);
      assert.deepEqual(violation(report, "must-not-touch")?.data?.source_values, ["private/authority.md"]);
    } finally {
      rmSync(intoRoot, { recursive: true, force: true });
    }

    const withinRoot = makeRepo(intent(), { "public/a.md": "authority\n" });
    try {
      git(withinRoot, "mv", "public/a.md", "public/b.md");
      const { result, report } = await runIntent(withinRoot);
      assert.equal(result.code, 0, result.output);
      assert.equal(violation(report, "change-intent-scope"), undefined);
      assert.equal(violation(report, "must-not-touch"), undefined);
    } finally {
      rmSync(withinRoot, { recursive: true, force: true });
    }
  });

  it("retains ordinary add, modify and delete ChangeIntent behavior", async () => {
    const cases = [
      {
        name: "add allowed",
        initial: {},
        stage(repoRoot) {
          writeTree(repoRoot, { "public/new.md": "new\n" });
          git(repoRoot, "add", "public/new.md");
        },
        expectedCode: 0,
      },
      {
        name: "modify allowed",
        initial: { "public/existing.md": "old\n" },
        stage(repoRoot) {
          writeTree(repoRoot, { "public/existing.md": "new\n" });
          git(repoRoot, "add", "public/existing.md");
        },
        expectedCode: 0,
      },
      {
        name: "delete allowed",
        initial: { "public/existing.md": "old\n" },
        stage(repoRoot) {
          unlinkSync(join(repoRoot, "public/existing.md"));
          git(repoRoot, "add", "-A");
        },
        expectedCode: 0,
      },
      {
        name: "modify forbidden",
        initial: { "private/existing.md": "old\n" },
        stage(repoRoot) {
          writeTree(repoRoot, { "private/existing.md": "new\n" });
          git(repoRoot, "add", "private/existing.md");
        },
        expectedCode: 1,
      },
    ];

    for (const testCase of cases) {
      const repoRoot = makeRepo(intent(), testCase.initial);
      try {
        testCase.stage(repoRoot);
        const { result, report } = await runIntent(repoRoot);
        assert.equal(result.code, testCase.expectedCode, `${testCase.name}: ${result.output}`);
        if (testCase.expectedCode === 1) {
          assert.ok(violation(report, "change-intent-scope"));
          assert.ok(violation(report, "must-not-touch"));
        }
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });
});
