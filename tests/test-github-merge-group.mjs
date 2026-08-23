import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { normalizeGitHubMergeGroupEvent } from "../dist/github-merge-group.mjs";
import { runCheckPR } from "../dist/github-pr.mjs";

const __dirname = new URL(".", import.meta.url).pathname;
const projectRoot = resolve(__dirname, "..");
const repoGuard = resolve(projectRoot, "dist/repo-guard.mjs");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS: ${label}`);
  } catch (error) {
    console.error(`FAIL: ${label}`);
    throw error;
  }
}

function basePolicy() {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
    },
    diff_rules: {
      max_new_docs: 0,
      max_new_files: 0,
      max_net_added_lines: 0,
    },
    registry_rules: [
      {
        id: "merge-group-state",
        kind: "equal",
        left: { type: "json_array", file: "left.json", json_pointer: "/items" },
        right: { type: "json_array", file: "right.json", json_pointer: "/items" },
      },
    ],
    content_rules: [],
    cochange_rules: [],
  };
}

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function commit(root, message) {
  execSync("git add -A", { cwd: root, stdio: "pipe" });
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: root, stdio: "pipe" });
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
}

function makeRepo({ brokenState = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-merge-group-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeTree(dir, {
    "repo-policy.json": JSON.stringify(basePolicy(), null, 2),
    "left.json": JSON.stringify({ items: ["alpha"] }),
    "right.json": JSON.stringify({ items: ["alpha"] }),
  });
  const base = commit(dir, "base");
  writeTree(dir, {
    "src/new.mjs": "export const combined = true;\n",
    ...(brokenState ? { "right.json": JSON.stringify({ items: ["beta"] }) } : {}),
  });
  const head = commit(dir, "merge group candidate");
  const eventPath = join(dir, "merge-group-event.json");
  writeFileSync(eventPath, JSON.stringify({
    action: "checks_requested",
    merge_group: {
      base_ref: "refs/heads/main",
      base_sha: base,
      head_ref: "refs/heads/gh-readonly-queue/main/pr-1-test",
      head_sha: head,
    },
    repository: { full_name: "example/repo" },
  }));
  return { dir, base, head, eventPath };
}

function runMergeGroup(repo, extraEnv = {}) {
  const result = spawnSync(process.execPath, [
    repoGuard,
    "--repo-root", repo.dir,
    "check-merge-group",
    "--format", "json",
  ], {
    cwd: projectRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: repo.eventPath,
      GITHUB_SHA: repo.head,
      ...extraEnv,
    },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "");
  } catch {}
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    parsed,
  };
}

console.log("\n--- merge_group event normalization ---");
{
  const payload = {
    action: "checks_requested",
    merge_group: {
      base_ref: "refs/heads/main",
      base_sha: SHA_B,
      head_ref: "refs/heads/gh-readonly-queue/main/pr-1-test",
      head_sha: SHA_A,
    },
    repository: { full_name: "example/repo" },
  };
  const normalized = normalizeGitHubMergeGroupEvent(payload, { githubSha: SHA_A });
  expect("merge_group checks_requested is first-class", normalized.ok, true);
  expect("provider is explicit", normalized.provider, "github_merge_queue");
  expect("exact candidate SHA comes from merge-group evidence", normalized.candidateSha, SHA_A);
  expect("base SHA is retained when present", normalized.baseSha, SHA_B);
  expect("base ref is retained when present", normalized.baseRef, "refs/heads/main");
  expect("repository identity is retained", normalized.repoFullName, "example/repo");
}

{
  const mismatch = normalizeGitHubMergeGroupEvent({
    action: "checks_requested",
    merge_group: { head_sha: SHA_A },
  }, { githubSha: SHA_B });
  expect("payload/environment candidate disagreement fails closed", mismatch.ok, false);
  expect("candidate mismatch is machine-readable", mismatch.error, "candidate_sha_mismatch");
}

{
  const missing = normalizeGitHubMergeGroupEvent({
    action: "checks_requested",
    merge_group: {},
  }, { githubSha: "" });
  expect("missing exact candidate SHA fails closed", missing.ok, false);
  expect("missing candidate reason is machine-readable", missing.error, "missing_candidate_sha");
}

{
  const unsupported = normalizeGitHubMergeGroupEvent({
    action: "destroyed",
    merge_group: { head_sha: SHA_A },
  }, { githubSha: SHA_A });
  expect("unknown merge_group action fails closed", unsupported.ok, false);
  expect("unsupported action reason is machine-readable", unsupported.error, "unsupported_merge_group_action");
}

console.log("\n--- state-only canonical pipeline over exact group candidate ---");
{
  const repo = makeRepo();
  try {
    const result = runMergeGroup(repo);
    expect("transaction-only diff budget does not block merge-group state pass", result.code, 0);
    expect("JSON output stays on stdout only", result.stderr, "");
    expect("JSON output parses", Boolean(result.parsed), true);
    expect("command is explicit", result.parsed?.command, "check-merge-group");
    expect("provider is machine-visible", result.parsed?.provider, "github_merge_queue");
    expect("execution phase is state", result.parsed?.executionPhase, "state");
    expect("exact candidate SHA is machine-visible", result.parsed?.candidateSha, repo.head);
    expect("exact base SHA is machine-visible", result.parsed?.baseSha, repo.base);
    expect("base ref is machine-visible", result.parsed?.baseRef, "refs/heads/main");
    expect("state relation executes", result.parsed?.ruleResults?.some((entry) => entry.rule === "registry-rules"), true);
    expect("transaction diff budget is excluded", result.parsed?.ruleResults?.some((entry) => entry.rule === "max-new-files"), false);
    expect("merge-group path invents no ChangeIntent check", result.parsed?.ruleResults?.some((entry) => entry.rule === "change-intent"), false);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

console.log("\n--- combined candidate repository-state failure ---");
{
  const repo = makeRepo({ brokenState: true });
  try {
    const result = runMergeGroup(repo);
    expect("broken combined repository state blocks exact candidate", result.code, 1);
    expect("state failure remains structured", result.parsed?.violations?.some((entry) => entry.rule === "registry-rules"), true);
    expect("failed group still reports exact candidate", result.parsed?.candidateSha, repo.head);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

console.log("\n--- existing check-pr does not reinterpret merge_group as a PR ---");
{
  const repo = makeRepo();
  const previousEvent = process.env.GITHUB_EVENT_PATH;
  const previousSha = process.env.GITHUB_SHA;
  const errors = [];
  const originalError = console.error;
  try {
    process.env.GITHUB_EVENT_PATH = repo.eventPath;
    process.env.GITHUB_SHA = repo.head;
    console.error = (...args) => errors.push(args.join(" "));
    const code = runCheckPR({ packageRoot: projectRoot, repoRoot: repo.dir });
    expect("check-pr rejects merge_group event", code, 1);
    expect("check-pr reports missing pull_request rather than fabricating metadata", errors.some((line) => line.includes("does not contain pull_request data")), true);
  } finally {
    console.error = originalError;
    if (previousEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previousEvent;
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

console.log("\nAll GitHub merge-group tests passed");
