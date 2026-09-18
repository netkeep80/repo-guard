import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCliCaptured } from "./support/run-cli.mjs";

let failures = 0;

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function expectIncludes(label, str, substring) {
  const passed = str.includes(substring);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected to include: ${JSON.stringify(substring)}`);
    console.error(`  output: ${JSON.stringify(str.slice(0, 1000))}`);
  }
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makePolicy(enforcementMode) {
  const policy = {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: {
      max_new_docs: 5,
      max_new_files: 0,
      max_net_added_lines: 500,
    },
    content_rules: [],
    cochange_rules: [],
  };
  if (enforcementMode) policy.enforcement = { mode: enforcementMode };
  return policy;
}

function makeRepo(enforcementMode) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-enforcement-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "repo-policy.json"), JSON.stringify(makePolicy(enforcementMode), null, 2));
  writeFileSync(join(dir, "README.md"), "# Test\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  writeFileSync(join(dir, "new-file.txt"), "new\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "add-file");
  return { dir, base: git(dir, "rev-parse", "HEAD~1"), head: git(dir, "rev-parse", "HEAD") };
}

async function runDiff(repo, extra = []) {
  return runCliCaptured([
    "--repo-root", repo.dir,
    "check-diff",
    "--base", repo.base,
    "--head", repo.head,
    ...extra,
  ]);
}

console.log("\n--- blocking check-diff fails on policy violation ---");
{
  const repo = makeRepo();
  const result = await runDiff(repo);
  expect("blocking exit code", result.code, 1);
  expectIncludes("blocking reports FAIL", result.output, "FAIL: max-new-files");
  expectIncludes("blocking summary names mode", result.output, "mode: blocking");
  expectIncludes("blocking result failed", result.output, "Result: failed");
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- advisory check-diff reports but does not fail ---");
{
  const repo = makeRepo();
  const result = await runDiff(repo, ["--enforcement", "advisory"]);
  expect("advisory exit code", result.code, 0);
  expectIncludes("advisory reports WARN", result.output, "WARN: max-new-files");
  expectIncludes("advisory summary has zero enforced failures", result.output, "0 failed");
  expectIncludes("advisory summary names advisory violations", result.output, "advisory violation");
  expectIncludes("advisory result still records failed checks", result.output, "Result: failed");
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- compatibility enforcement values are rejected ---");
for (const alias of ["warn", "enforce"]) {
  const repo = makeRepo();
  const result = await runCliCaptured([
    "check-diff",
    "--repo-root", repo.dir,
    "--base", repo.base,
    "--head", repo.head,
    "--enforcement", alias,
  ]);
  expect(`${alias} alias exit code`, result.code, 1);
  expectIncludes(`${alias} alias is rejected`, result.output, "Must be one of: advisory, blocking.");
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- policy config can opt into advisory mode ---");
{
  const repo = makeRepo("advisory");
  const result = await runDiff(repo);
  expect("policy advisory exit code", result.code, 0);
  expectIncludes("policy advisory mode", result.output, "mode: advisory");
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- CLI enforcement overrides policy config ---");
{
  const repo = makeRepo("advisory");
  const result = await runDiff(repo, ["--enforcement", "blocking"]);
  expect("CLI blocking override exit code", result.code, 1);
  expectIncludes("CLI blocking override mode", result.output, "mode: blocking");
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- check-pr missing ChangeIntent is advisory when requested ---");
{
  const repo = makeRepo();
  const eventPath = join(repo.dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      number: 123,
      base: { sha: repo.base },
      head: { sha: repo.head },
      body: "No ChangeIntent here.",
    },
    repository: { full_name: "owner/repo" },
  }));
  const result = await runCliCaptured([
    "--repo-root", repo.dir,
    "--enforcement", "advisory",
    "check-pr",
  ], { env: { GITHUB_EVENT_PATH: eventPath } });
  expect("check-pr advisory missing ChangeIntent exit code", result.code, 0);
  expectIncludes("check-pr missing ChangeIntent warning", result.output, "WARN: change-intent");
  expectIncludes("check-pr advisory summary", result.output, "advisory violation");
  rmSync(repo.dir, { recursive: true });
}

console.log(`\n${failures === 0 ? "All enforcement mode tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
