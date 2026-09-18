import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCliCaptured } from "./support/run-cli.mjs";

const __dirname = new URL(".", import.meta.url).pathname;
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

function expectIncludes(label, str, substring) {
  const passed = str.includes(substring);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected to include: ${JSON.stringify(substring)}, got: ${JSON.stringify(str.slice(0, 200))}`);
  }
}

function expectNotIncludes(label, str, substring) {
  const passed = !str.includes(substring);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected NOT to include: ${JSON.stringify(substring)}`);
  }
}

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "repo-guard-doctor-"));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGitRepo(dir) {
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "init");
}

function validPolicy() {
  return JSON.stringify({
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: { forbidden: [], canonical_docs: ["README.md"], governance_paths: ["repo-policy.json"] },
    diff_rules: { max_new_docs: 2, max_new_files: 15 },
    content_rules: [],
    cochange_rules: []
  });
}

const runDoctor = (args = []) => runCliCaptured(args);

console.log("\n--- self-hosting: doctor on repo-guard itself ---");
{
  const { stdout, code } = await runDoctor(["doctor"]);
  expect("exit code 0 on healthy repo", code, 0);
  expectIncludes("shows header", stdout, "repo-guard doctor");
  expectIncludes("repo root passes", stdout, "PASS: repository-root");
  expectIncludes("git passes", stdout, "PASS: git-available");
  expectIncludes("git evidence passes", stdout, "PASS: git-evidence");
  expectIncludes("policy passes", stdout, "PASS: repo-policy.json");
  expectNotIncludes("workflow text inspection is absent", stdout, "workflow-config");
  expectIncludes("summary line", stdout, "Summary:");
  expectNotIncludes("no failures in summary", stdout, "1 failed");
}

console.log("\n--- self-hosting: doctor catches broken-policy fixture ---");
{
  const dir = makeTmpDir();
  initGitRepo(dir);
  const brokenPolicy = resolve(projectRoot, "tests/fixtures/broken-policy.json");
  writeFileSync(resolve(dir, "repo-policy.json"), readFileSync(brokenPolicy, "utf-8"));
  const { stdout, code } = await runDoctor(["--repo-root", dir, "doctor"]);
  expect("exit code 1 for broken policy", code, 1);
  expectIncludes("detects invalid forbid_regex", stdout, "FAIL: repo-policy.json");
  expectIncludes("mentions bad-regex-rule", stdout, "bad-regex-rule");
  expectIncludes("summary shows failure", stdout, "1 failed");
  rmSync(dir, { recursive: true });
}

console.log("\n--- missing repo-policy.json ---");
{
  const dir = makeTmpDir();
  initGitRepo(dir);
  const { stdout, code } = await runDoctor(["--repo-root", dir, "doctor"]);
  expect("exit code 1 for missing policy", code, 1);
  expectIncludes("policy FAIL", stdout, "FAIL: repo-policy.json");
  expectIncludes("hint mentions init", stdout, "repo-guard init");
  rmSync(dir, { recursive: true });
}

console.log("\n--- malformed JSON in repo-policy.json ---");
{
  const dir = makeTmpDir();
  initGitRepo(dir);
  writeFileSync(resolve(dir, "repo-policy.json"), "{ not valid json }}");
  const { stdout, code } = await runDoctor(["--repo-root", dir, "doctor"]);
  expect("exit code 1 for malformed json", code, 1);
  expectIncludes("policy FAIL with parse error", stdout, "FAIL: repo-policy.json");
  expectIncludes("mentions parse error", stdout, "Parse error");
  rmSync(dir, { recursive: true });
}

console.log("\n--- schema-invalid repo-policy.json ---");
{
  const dir = makeTmpDir();
  initGitRepo(dir);
  writeFileSync(resolve(dir, "repo-policy.json"), JSON.stringify({
    policy_format_version: "0.3.0", repository_kind: "unknown_kind", paths: {}, diff_rules: {}
  }));
  const { stdout, code } = await runDoctor(["--repo-root", dir, "doctor"]);
  expect("exit code 1 for invalid schema", code, 1);
  expectIncludes("policy FAIL with schema error", stdout, "FAIL: repo-policy.json");
  expectIncludes("mentions schema validation", stdout, "Schema validation failed");
  rmSync(dir, { recursive: true });
}

console.log("\n--- not a git repository ---");
{
  const dir = makeTmpDir();
  writeFileSync(resolve(dir, "repo-policy.json"), validPolicy());
  const { stdout, code } = await runDoctor(["--repo-root", dir, "doctor"]);
  expect("exit code 0 (warns, no fails)", code, 0);
  expectIncludes("git WARN for non-repo", stdout, "WARN: git-available");
  expectIncludes("hint mentions git init", stdout, "git init");
  expectNotIncludes("workflow text inspection stays absent", stdout, "workflow-config");
  rmSync(dir, { recursive: true });
}

console.log("\n--- non-existent repo root ---");
{
  const { stdout, code } = await runDoctor(["--repo-root", "/nonexistent/path/xyz", "doctor"]);
  expect("exit code 1 for missing root", code, 1);
  expectIncludes("root FAIL", stdout, "FAIL: repository-root");
}

console.log("\n--- output distinguishes pass / warn / fail ---");
{
  const { stdout } = await runDoctor(["doctor"]);
  expectIncludes("contains PASS", stdout, "PASS:");
  if (process.env.GITHUB_EVENT_PATH) console.log("PASS: skipping WARN check (CI with full context may have no warnings)");
  else expectIncludes("contains WARN", stdout, "WARN:");
  expectIncludes("contains Summary", stdout, "Summary:");
}

console.log("\n--- event context adapts to environment ---");
{
  const { stdout } = await runDoctor(["doctor"]);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    expectIncludes("event-context WARN outside CI", stdout, "WARN: event-context");
    expectIncludes("mentions not in GitHub Actions", stdout, "not in GitHub Actions");
  } else {
    const event = JSON.parse(readFileSync(eventPath, "utf-8"));
    if (event.pull_request) expectIncludes("event-context PASS for pull_request event", stdout, "PASS: event-context");
    else {
      expectIncludes("event-context WARN for non-PR GitHub event", stdout, "WARN: event-context");
      expectIncludes("non-PR event is explained", stdout, "not a pull_request event");
    }
  }
}

console.log("\n--- gh/auth are optional unless linked-issue fallback is used ---");
{
  const { stdout } = await runDoctor(["doctor"]);
  expectNotIncludes("gh-cli absence is never a hard failure", stdout, "FAIL: gh-cli");
  expectNotIncludes("auth-token is never FAIL (auth only needed for linked-issue fallback)", stdout, "FAIL: auth-token");
}

console.log("\n--- --repo-root flag works with doctor ---");
{
  const { stdout, code } = await runDoctor(["--repo-root", projectRoot, "doctor"]);
  expect("exit code 0 with explicit repo-root", code, 0);
  expectIncludes("shows repo root path", stdout, projectRoot);
  expectNotIncludes("no workflow text semantics", stdout, "workflow-config");
}

console.log("\n=========================");
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("All doctor tests passed");
