import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRoots } from "../dist/repo-guard.mjs";
import { runCliCaptured } from "./support/run-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
let failures = 0;

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function policy({ withNetBudget = false } = {}) {
  return {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: {
      max_new_docs: 5,
      max_new_files: 20,
      ...(withNetBudget ? { max_net_added_lines: 500 } : {}),
    },
    content_rules: [],
    cochange_rules: [],
  };
}

function initRepo(dir) {
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
}

function makeDiffRepo() {
  const dir = mkdtempSync(join(tmpdir(), "rg-repo-root-"));
  initRepo(dir);
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(policy({ withNetBudget: true })));
  writeFileSync(join(dir, "hello.txt"), "hello\nworld\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "second");
  return dir;
}

function writeIntent(dir) {
  mkdirSync(join(dir, "change-intents"), { recursive: true });
  writeFileSync(join(dir, "change-intents", "change.json"), JSON.stringify({
    change_type: "feature",
    scope: ["**"],
    budgets: { max_new_files: 5, max_net_added_lines: 500 },
    must_touch: ["hello.txt"],
    must_not_touch: [],
    expected_effects: ["test"],
  }));
}

{
  const roots = resolveRoots([]);
  expect("default repoRoot is cwd", roots.repoRoot, process.cwd());
  expect("packageRoot is project root", roots.packageRoot, projectRoot);
  expect("args empty when no args given", roots.args.length, 0);
}

{
  const roots = resolveRoots(["--repo-root", "/tmp/other-repo"]);
  expect("--repo-root overrides repoRoot", roots.repoRoot, resolve("/tmp/other-repo"));
  expect("--repo-root stripped from args", roots.args.length, 0);
  expect("packageRoot unchanged with --repo-root", roots.packageRoot, projectRoot);
}

{
  const roots = resolveRoots(["--base", "main", "--repo-root", "/tmp/other", "--head", "dev"]);
  expect("mixed args: repoRoot", roots.repoRoot, resolve("/tmp/other"));
  expect("mixed args: filtered length", roots.args.length, 4);
  expect("mixed args: --base preserved", roots.args[0], "--base");
  expect("mixed args: main preserved", roots.args[1], "main");
  expect("mixed args: --head preserved", roots.args[2], "--head");
  expect("mixed args: dev preserved", roots.args[3], "dev");
}

{
  const roots = resolveRoots(["--repo-root", "/tmp/target"]);
  expect("packageRoot != repoRoot when --repo-root set", roots.packageRoot !== roots.repoRoot, true);
}

{
  const result = await runCliCaptured([]);
  expect("self-hosted validate passes", result.stdout.includes("OK: repo-policy.json"), true);
}

// Keep one explicit OS-process proof that the installed bin symlink executes the real entrypoint.
{
  const tmp = mkdtempSync(join(tmpdir(), "rg-bin-symlink-"));
  const binDir = join(tmp, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "repo-guard");
  symlinkSync(resolve(projectRoot, "dist/repo-guard.mjs"), binPath);
  try {
    const output = execFileSync(process.execPath, [binPath, "--repo-root", projectRoot], {
      encoding: "utf-8",
      cwd: tmp,
    });
    expect("installed bin symlink validates policy", output.includes("OK: repo-policy.json"), true);
  } catch {
    expect("installed bin symlink validates policy", false, true);
  }
  rmSync(tmp, { recursive: true });
}

// One external-policy run proves both repo-root selection and package-owned schema loading.
{
  const tmp = mkdtempSync(join(tmpdir(), "rg-external-root-"));
  writeFileSync(join(tmp, "repo-policy.json"), JSON.stringify(policy()));
  const result = await runCliCaptured(["--repo-root", tmp]);
  expect("--repo-root validate loads external policy", result.stdout.includes("OK: repo-policy.json"), true);
  expect("schemas load from package (no schemas/ in target)", result.stdout.includes("OK: repo-policy.json"), true);
  rmSync(tmp, { recursive: true });
}

// One real Git fixture proves target-repo Git routing plus both legal --repo-root positions.
{
  const tmp = makeDiffRepo();
  const post = await runCliCaptured([
    "check-diff", "--repo-root", tmp, "--base", "HEAD~1", "--head", "HEAD",
  ]);
  expect("check-diff --repo-root uses target git", post.output.includes("1 file(s) changed"), true);
  expect("check-diff --repo-root passes", post.output.includes("0 failed"), true);
  expect("post-command --repo-root check-diff still works", post.output.includes("1 file(s) changed"), true);
  expect("known check-diff options still accepted", post.output.includes("1 file(s) changed"), true);

  const pre = await runCliCaptured([
    "--repo-root", tmp, "check-diff", "--base", "HEAD~1", "--head", "HEAD",
  ]);
  expect("pre-command --repo-root check-diff works", pre.output.includes("1 file(s) changed"), true);
  expect("pre-command --repo-root check-diff passes", pre.output.includes("0 failed"), true);
  rmSync(tmp, { recursive: true });
}

// Validate resolves a positional ChangeIntent relative to repoRoot; the same invocation is the pre-command regression.
{
  const tmp = mkdtempSync(join(tmpdir(), "rg-change-intent-validate-"));
  writeFileSync(join(tmp, "repo-policy.json"), JSON.stringify(policy()));
  mkdirSync(join(tmp, "change-intents"));
  writeFileSync(join(tmp, "change-intents", "change.json"), JSON.stringify({
    change_type: "feature",
    scope: ["src/**"],
    budgets: { max_new_files: 5 },
    must_touch: [],
    must_not_touch: [],
    expected_effects: ["test"],
  }));
  const result = await runCliCaptured(["--repo-root", tmp, "change-intents/change.json"]);
  expect("validate resolves ChangeIntent relative to repoRoot", result.stdout.includes("OK: repo-policy.json"), true);
  expect("validate ChangeIntent passes schema check", result.stdout.includes("OK: change-intents/change.json"), true);
  expect("pre-command --repo-root validate with ChangeIntent works", result.stdout.includes("OK: repo-policy.json"), true);
  expect("pre-command --repo-root validate ChangeIntent passes", result.stdout.includes("OK: change-intents/change.json"), true);
  rmSync(tmp, { recursive: true });
}

// check-diff resolves --change-intent relative to the selected repository.
{
  const tmp = makeDiffRepo();
  writeIntent(tmp);
  git(tmp, "add", "-A");
  git(tmp, "commit", "-m", "add intent");
  writeFileSync(join(tmp, "hello.txt"), "hello world\n");
  git(tmp, "add", "-A");
  git(tmp, "commit", "-m", "change with intent");
  const result = await runCliCaptured([
    "check-diff", "--repo-root", tmp,
    "--base", "HEAD~1", "--head", "HEAD",
    "--change-intent", "change-intents/change.json",
  ]);
  expect("check-diff resolves --change-intent relative to repoRoot", result.output.includes("1 file(s) changed"), true);
  expect("check-diff --change-intent passes with repoRoot", result.output.includes("0 failed"), true);
  rmSync(tmp, { recursive: true });
}

{
  const roots = resolveRoots(["--repo-root", "/tmp/some-repo"]);
  expect("check-pr receives repoRoot through roots", roots.repoRoot, resolve("/tmp/some-repo"));
  expect("check-pr receives packageRoot through roots", roots.packageRoot, projectRoot);
}

// Regression for issue #15: pre-command --repo-root reaches check-pr rather than being treated as validate input.
{
  const tmp = mkdtempSync(join(tmpdir(), "rg-precommand-pr-"));
  writeFileSync(join(tmp, "repo-policy.json"), JSON.stringify(policy()));
  const result = await runCliCaptured(["--repo-root", tmp, "check-pr"], {
    env: { GITHUB_EVENT_PATH: null },
  });
  const isCheckPR = result.output.includes("check-pr") && !result.output.includes("ENOENT");
  expect("pre-command --repo-root check-pr enters check-pr mode", isCheckPR, true);
  rmSync(tmp, { recursive: true });
}

{
  const result = await runCliCaptured(["--unknown-flag"]);
  expect("unknown option shows error message", result.stderr.includes("Unknown option: --unknown-flag"), true);
  expect("unknown option shows usage hint", result.stderr.includes("Usage:"), true);
}

{
  const result = await runCliCaptured(["--repo-root"]);
  expect("--repo-root without value shows error", result.stderr.includes("--repo-root requires a path argument"), true);
  expect("--repo-root without value shows usage hint", result.stderr.includes("Usage:"), true);
}

{
  const result = await runCliCaptured(["check-diff", "--repo-root", "--base", "HEAD~1", "--head", "HEAD"]);
  expect("--repo-root followed by flag shows error", result.stderr.includes("--repo-root requires a path argument"), true);
}

{
  const result = await runCliCaptured(["check-diff", "--hed", "HEAD"]);
  expect("unknown check-diff option shows error message", result.stderr.includes("Unknown option for check-diff: --hed"), true);
  expect("unknown check-diff option shows usage hint", result.stderr.includes("Usage:"), true);
}

console.log(`\n${failures === 0 ? "All tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
