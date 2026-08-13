import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoGuard = resolve(projectRoot, "dist/repo-guard.mjs");
let failures = 0;
const expect = (label, condition) => { const ok = Boolean(condition); console.log(`${ok ? "PASS" : "FAIL"}: ${label}`); if (!ok) failures++; };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
const commit = (cwd, message) => { git(cwd, "add", "-A"); git(cwd, "commit", "-m", message); return git(cwd, "rev-parse", "HEAD"); };

function writePolicy(root) {
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify({
    policy_format_version: "0.1.0", repository_kind: "library", enforcement: { mode: "blocking" },
    paths: { forbidden: [], canonical_docs: [], governance_paths: ["governance.txt"] },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 }, content_rules: [], cochange_rules: [],
  }, null, 2));
}

function changeIntentBody({ docs = false } = {}) {
  const scope = docs ? ["src/**", "docs/**"] : ["src/**"];
  const mustTouch = docs ? "docs/theory/Основания МТС.md" : "src/kernel.txt";
  return [
    "```repo-guard-yaml", `change_type: ${docs ? "docs" : "bugfix"}`, "scope:", ...scope.map((item) => `  - ${item}`),
    "budgets:", "  max_new_files: 5", ...(docs ? ["  max_new_docs: 5"] : []), "  max_net_added_lines: 500",
    "must_touch:", `  - ${mustTouch}`, "must_not_touch:", "  - governance.txt", "expected_effects:",
    `  - ${docs ? "UTF-8 path is preserved" : "kernel change only"}`, "```",
  ].join("\n");
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-current-base-"));
  git(root, "init", "-b", "main"); git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test");
  writePolicy(root); mkdirSync(join(root, "src"), { recursive: true }); writeFileSync(join(root, "src/kernel.txt"), "base\n");
  const oldBase = commit(root, "base");
  writeFileSync(join(root, "governance.txt"), "landed-on-base\n");
  const currentBase = commit(root, "advance base with unrelated governance");
  git(root, "update-ref", "refs/remotes/origin/main", currentBase); git(root, "switch", "-c", "feature");
  writeFileSync(join(root, "src/kernel.txt"), "base\nfeature\n");
  return { root, oldBase, currentBase, head: commit(root, "feature kernel change") };
}

function runCheck(root, event) {
  const eventFile = join(root, "event.json"); writeFileSync(eventFile, JSON.stringify(event));
  return spawnSync(process.execPath, [repoGuard, "--repo-root", root, "--enforcement", "blocking", "check-pr"], {
    cwd: root, env: { ...process.env, GITHUB_EVENT_PATH: eventFile }, encoding: "utf-8",
  });
}
const event = (number, base, head, body, baseRef = "main") => ({
  pull_request: { number, base: { sha: base, ref: baseRef }, head: { sha: head }, body }, repository: { full_name: "owner/repo" },
});
const output = (result) => `${result.stdout || ""}${result.stderr || ""}`;

{
  const { root, oldBase, currentBase, head } = setupRepo();
  const result = runCheck(root, event(100, oldBase, head, changeIntentBody())); const text = output(result);
  expect("advanced base: check-pr passes", result.status === 0);
  expect("advanced base: diagnostic reports current base", text.includes(currentBase.slice(0, 7)));
  expect("advanced base: old snapshot is recognized as stale", text.includes(oldBase.slice(0, 7)));
  expect("advanced base: already-landed governance is not in PR diff", !text.includes("touched: governance.txt"));
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, oldBase, currentBase } = setupRepo(); writeFileSync(join(root, "governance.txt"), "landed-on-base\nchanged-by-pr\n");
  const result = runCheck(root, event(101, oldBase, commit(root, "feature also changes governance"), changeIntentBody())); const text = output(result);
  expect("genuine governance delta: current base remains selected", text.includes(currentBase.slice(0, 7)));
  expect("genuine governance delta: blocking check fails", result.status === 1);
  expect("genuine governance delta: must-not-touch reports governance file", text.includes("governance.txt"));
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, oldBase, head } = setupRepo(); const result = runCheck(root, event(102, oldBase, head, changeIntentBody(), "missing-base"));
  expect("missing current base ref: check-pr fails closed", result.status === 1);
  expect("missing current base ref: diagnostic is explicit", output(result).includes("cannot resolve current PR base ref missing-base"));
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, oldBase } = setupRepo(); mkdirSync(join(root, "docs/theory"), { recursive: true });
  writeFileSync(join(root, "docs/theory/Основания МТС.md"), "# Основания МТС\n");
  const result = runCheck(root, event(103, oldBase, commit(root, "add Cyrillic documentation path"), changeIntentBody({ docs: true })));
  expect("UTF-8 diff path: check-pr passes", result.status === 0);
  expect("UTF-8 diff path: must-touch does not lose Cyrillic filename", !output(result).includes("FAIL: must-touch"));
  rmSync(root, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} current-base regression test(s) failed`); process.exit(1); }
console.log("\nAll current-base regression tests passed");
