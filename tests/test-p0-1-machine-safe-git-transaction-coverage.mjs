import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNameStatusZ } from "../dist/diff/parser.mjs";

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

function policy({ governance = [], immutable = [] } = {}) {
  return {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: governance,
      operational_paths: [],
      ...(immutable.length ? { pr_immutable: immutable } : {}),
    },
    diff_rules: { max_new_docs: 20, max_new_files: 50, max_net_added_lines: 5000 },
    content_rules: [],
    cochange_rules: [],
  };
}

function setupRepo(repoPolicy) {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-p01-coverage-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Repo Guard Test");
  git(root, "config", "core.filemode", "true");
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(repoPolicy, null, 2));
  return root;
}

function check(root, base, head) {
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

function expectBlocked(label, root, base, head, path) {
  const result = check(root, base, head);
  expect(label, () => assert.equal(result.status, 1, output(result)));
  if (path && !path.includes("\n")) {
    expect(`${label}: diagnostic retains exact path`, () => assert.ok(output(result).includes(path), output(result)));
  }
}

{
  const protectedPath = "docs/delete.md";
  const root = setupRepo(policy({ immutable: [protectedPath] }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, protectedPath), "delete me\n");
  const base = commit(root, "base protected delete");
  rmSync(join(root, protectedPath));
  const head = commit(root, "delete protected file");
  expectBlocked("protected delete is blocked from real Git diff", root, base, head, protectedPath);
  rmSync(root, { recursive: true, force: true });
}

{
  const protectedPath = "docs/add.md";
  const root = setupRepo(policy({ immutable: [protectedPath] }));
  const base = commit(root, "base before protected add");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, protectedPath), "new protected identity\n");
  const head = commit(root, "add protected file");
  expectBlocked("protected add is blocked from real Git diff", root, base, head, protectedPath);
  rmSync(root, { recursive: true, force: true });
}

{
  const protectedPath = "docs/protected.md";
  const sourcePath = "docs/source.md";
  const root = setupRepo(policy({ immutable: [protectedPath] }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, sourcePath), "same identity\n");
  const base = commit(root, "base rename source");
  git(root, "mv", sourcePath, protectedPath);
  const head = commit(root, "rename into protected path");
  expectBlocked("rename into protected path is blocked", root, base, head, protectedPath);
  rmSync(root, { recursive: true, force: true });
}

{
  const protectedPath = "docs/no-renames.md";
  const movedPath = "archive/no-renames.md";
  const root = setupRepo(policy({ immutable: [protectedPath] }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, protectedPath), "rename without detection\n");
  const base = commit(root, "base rename detection off");
  git(root, "config", "diff.renames", "false");
  mkdirSync(join(root, "archive"), { recursive: true });
  git(root, "mv", protectedPath, movedPath);
  const head = commit(root, "move protected with rename detection disabled");
  expectBlocked("delete+add representation still protects old identity", root, base, head, protectedPath);
  rmSync(root, { recursive: true, force: true });
}

{
  const protectedPath = "bin/blob.dat";
  const root = setupRepo(policy({ immutable: [protectedPath] }));
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, protectedPath), Buffer.from([0, 1, 2, 3, 4]));
  const base = commit(root, "base binary");
  writeFileSync(join(root, protectedPath), Buffer.from([0, 1, 9, 3, 4]));
  const head = commit(root, "modify protected binary");
  expectBlocked("protected binary modification is blocked", root, base, head, protectedPath);
  rmSync(root, { recursive: true, force: true });
}

{
  const protectedPath = "scripts/tool.sh";
  const root = setupRepo(policy({ immutable: [protectedPath] }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, protectedPath), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, protectedPath), 0o644);
  const base = commit(root, "base mode");
  chmodSync(join(root, protectedPath), 0o755);
  const head = commit(root, "change protected mode only");
  expectBlocked("protected mode-only modification is blocked", root, base, head, protectedPath);
  rmSync(root, { recursive: true, force: true });
}

{
  const protectedPath = "docs/line\nbreak.md";
  const root = setupRepo(policy({ immutable: [protectedPath] }));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, protectedPath), "base\n");
  const base = commit(root, "base newline path");
  writeFileSync(join(root, protectedPath), "base\nchanged\n");
  const head = commit(root, "modify newline path");
  expectBlocked("newline-containing protected filename is blocked by exact identity", root, base, head);
  rmSync(root, { recursive: true, force: true });
}

expect("malformed NUL-delimited identity evidence fails closed", () => {
  assert.throws(() => parseNameStatusZ("R100\0only-old\0"), /missing destination path/);
  assert.throws(() => parseNameStatusZ("U\0conflicted.md\0"), /unsupported git diff status/);
});

if (failures) {
  console.error(`\n${failures} machine-safe mutation coverage regression(s) failed`);
  process.exit(1);
}
console.log("\nAll machine-safe mutation coverage regressions passed");
