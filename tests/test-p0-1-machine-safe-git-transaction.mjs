import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listTrackedFiles } from "../dist/facts/input.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoGuard = resolve(projectRoot, "dist/repo-guard.mjs");
let failures = 0;

function expect(label, fn) {
  try {
    fn();
    console.log(`PASS: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAIL: ${label}`);
    console.error(`  ${error.message}`);
  }
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
const commit = (cwd, message) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

function policy({ operational = [], governance = [], immutable = [] } = {}) {
  return {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: governance,
      operational_paths: operational,
      ...(immutable.length ? { pr_immutable: immutable } : {}),
    },
    diff_rules: { max_new_docs: 20, max_new_files: 50, max_net_added_lines: 5000 },
    content_rules: [],
    cochange_rules: [],
  };
}

function setupRepo(repoPolicy) {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-p01-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Repo Guard Test");
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(repoPolicy, null, 2));
  return root;
}

function runCheckDiff(root, base, head) {
  return spawnSync(process.execPath, [
    repoGuard,
    "--repo-root", root,
    "--enforcement", "blocking",
    "check-diff",
    "--base", base,
    "--head", head,
  ], { cwd: root, encoding: "utf-8" });
}

const output = (result) => `${result.stdout || ""}${result.stderr || ""}`;

{
  const protectedPath = "docs/owner.md";
  const movedPath = ".claude/owner.md";
  const root = setupRepo(policy({ operational: [".claude/**"], immutable: [protectedPath] }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, protectedPath), "owner\n");
  const base = commit(root, "base protected file");
  mkdirSync(join(root, ".claude"), { recursive: true });
  git(root, "mv", protectedPath, movedPath);
  const head = commit(root, "rename protected path into operational area");
  const result = runCheckDiff(root, base, head);
  const text = output(result);
  expect("protected rename into operational path is blocked", () => assert.equal(result.status, 1, text));
  expect("protected rename diagnostic retains BASE path identity", () => assert.match(text, /docs\/owner\.md/));
  rmSync(root, { recursive: true, force: true });
}

{
  const governancePath = ".github/workflows/ci.yml";
  const movedPath = "archive/ci.yml";
  const root = setupRepo(policy({ governance: [governancePath] }));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, governancePath), "name: ci\n");
  const base = commit(root, "base governance workflow");
  mkdirSync(join(root, "archive"), { recursive: true });
  git(root, "mv", governancePath, movedPath);
  const head = commit(root, "rename governance path away");
  const result = runCheckDiff(root, base, head);
  const text = output(result);
  expect("governance rename-away is blocked without grant", () => assert.equal(result.status, 1, text));
  expect("governance rename diagnostic retains old path identity", () => assert.match(text, /\.github\/workflows\/ci\.yml/));
  rmSync(root, { recursive: true, force: true });
}

{
  const protectedPath = "docs/tab\tname.md";
  const root = setupRepo(policy({ immutable: [protectedPath] }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, protectedPath), "base\n");
  const base = commit(root, "base tab path");
  writeFileSync(join(root, protectedPath), "base\nchanged\n");
  const head = commit(root, "modify tab path");
  const result = runCheckDiff(root, base, head);
  expect("TAB-containing protected filename is blocked by exact identity", () => assert.equal(result.status, 1, output(result)));
  rmSync(root, { recursive: true, force: true });
}

{
  const root = setupRepo(policy());
  const names = [
    "docs/space name.md",
    "docs/tab\tname.md",
    "docs/line\nbreak.md",
    "docs/Кириллица.md",
    "docs/quote\"name.md",
    "docs/back\\slash.md",
  ];
  mkdirSync(join(root, "docs"), { recursive: true });
  for (const name of names) writeFileSync(join(root, name), `${JSON.stringify(name)}\n`);
  commit(root, "track unusual filenames");
  const tracked = listTrackedFiles(root);
  for (const name of names) {
    expect(`tracked-file identity is exact for ${JSON.stringify(name)}`, () => assert.ok(tracked.includes(name), `missing exact path ${JSON.stringify(name)} in ${JSON.stringify(tracked)}`));
  }
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} machine-safe Git transaction regression(s) failed`);
  process.exit(1);
}
console.log("\nAll machine-safe Git transaction regressions passed");
