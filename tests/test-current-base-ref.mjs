import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const repoGuard = resolve(projectRoot, "src/repo-guard.mjs");
let failures = 0;

function expect(label, condition) {
  const passed = Boolean(condition);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) failures++;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function writePolicy(root) {
  const policy = {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: ["governance.txt"],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 },
    content_rules: [],
    cochange_rules: [],
  };
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(policy, null, 2));
}

function contractBody() {
  return [
    "```repo-guard-yaml",
    "change_type: bugfix",
    "scope:",
    "  - src/**",
    "budgets:",
    "  max_new_files: 5",
    "  max_net_added_lines: 500",
    "must_touch:",
    "  - src/kernel.txt",
    "must_not_touch:",
    "  - governance.txt",
    "expected_effects:",
    "  - kernel change only",
    "```",
  ].join("\n");
}

function unicodeContractBody() {
  return [
    "```repo-guard-yaml",
    "change_type: docs",
    "scope:",
    "  - docs/**",
    "budgets:",
    "  max_new_files: 5",
    "  max_new_docs: 5",
    "  max_net_added_lines: 500",
    "must_touch:",
    "  - docs/theory/Основания МТС.md",
    "must_not_touch:",
    "  - governance.txt",
    "expected_effects:",
    "  - UTF-8 path is preserved",
    "```",
  ].join("\n");
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-current-base-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writePolicy(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/kernel.txt"), "base\n");
  const oldBase = commit(root, "base");

  writeFileSync(join(root, "governance.txt"), "landed-on-base\n");
  const currentBase = commit(root, "advance base with unrelated governance");
  git(root, "update-ref", "refs/remotes/origin/main", currentBase);

  git(root, "switch", "-c", "feature");
  writeFileSync(join(root, "src/kernel.txt"), "base\nfeature\n");
  const head = commit(root, "feature kernel change");
  return { root, oldBase, currentBase, head };
}

function runCheck(root, event) {
  const eventFile = join(root, "event.json");
  writeFileSync(eventFile, JSON.stringify(event));
  return spawnSync(process.execPath, [repoGuard, "--repo-root", root, "--enforcement", "blocking", "check-pr"], {
    cwd: root,
    env: { ...process.env, GITHUB_EVENT_PATH: eventFile },
    encoding: "utf-8",
  });
}

{
  const { root, oldBase, currentBase, head } = setupRepo();
  const result = runCheck(root, {
    pull_request: {
      number: 100,
      base: { sha: oldBase, ref: "main" },
      head: { sha: head },
      body: contractBody(),
    },
    repository: { full_name: "owner/repo" },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  expect("advanced base: check-pr passes", result.status === 0);
  expect("advanced base: diagnostic reports current base", output.includes(currentBase.slice(0, 7)));
  expect("advanced base: old snapshot is recognized as stale", output.includes(oldBase.slice(0, 7)));
  expect("advanced base: already-landed governance is not in PR diff", !output.includes("touched: governance.txt"));
  rmSync(root, { recursive: true, force: true });
}

{
  const { root, oldBase, currentBase } = setupRepo();
  writeFileSync(join(root, "governance.txt"), "landed-on-base\nchanged-by-pr\n");
  const head = commit(root, "feature also changes governance");
  const result = runCheck(root, {
    pull_request: {
      number: 101,
      base: { sha: oldBase, ref: "main" },
      head: { sha: head },
      body: contractBody(),
    },
    repository: { full_name: "owner/repo" },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  expect("genuine governance delta: current base remains selected", output.includes(currentBase.slice(0, 7)));
  expect("genuine governance delta: blocking check fails", result.status === 1);
  expect("genuine governance delta: must-not-touch reports governance file", output.includes("governance.txt"));
  rmSync(root, { recursive: true, force: true });
}

{
  const { root, oldBase, head } = setupRepo();
  const result = runCheck(root, {
    pull_request: {
      number: 102,
      base: { sha: oldBase, ref: "missing-base" },
      head: { sha: head },
      body: contractBody(),
    },
    repository: { full_name: "owner/repo" },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  expect("missing current base ref: check-pr fails closed", result.status === 1);
  expect("missing current base ref: diagnostic is explicit", output.includes("cannot resolve current PR base ref missing-base"));
  rmSync(root, { recursive: true, force: true });
}

{
  const { root, oldBase } = setupRepo();
  mkdirSync(join(root, "docs/theory"), { recursive: true });
  writeFileSync(join(root, "docs/theory/Основания МТС.md"), "# Основания МТС\n");
  const head = commit(root, "add Cyrillic documentation path");
  const result = runCheck(root, {
    pull_request: {
      number: 103,
      base: { sha: oldBase, ref: "main" },
      head: { sha: head },
      body: unicodeContractBody(),
    },
    repository: { full_name: "owner/repo" },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  expect("UTF-8 diff path: check-pr passes", result.status === 0);
  expect("UTF-8 diff path: must-touch does not lose Cyrillic filename", !output.includes("FAIL: must-touch"));
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} current-base regression test(s) failed`);
  process.exit(1);
}
console.log("\nAll current-base regression tests passed");