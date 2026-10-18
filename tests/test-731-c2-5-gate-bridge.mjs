import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historicalMigration = "5bd71de602ecce3295ff78beed74a7f4a8c4d7b1";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function cloneCurrent() {
  const clone = mkdtempSync(join(tmpdir(), "repo-guard-c25-bridge-"));
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", root, clone], { encoding: "utf8" });
  git(clone, ["config", "user.email", "c2.5-bridge@example.invalid"]);
  git(clone, ["config", "user.name", "C2.5 Gate Bridge"]);
  const current = git(root, ["rev-parse", "HEAD"]);
  git(clone, ["checkout", "-q", current]);
  return clone;
}

function runInventory(cwd) {
  return spawnSync(process.execPath, [resolve(cwd, "tests/test-645-self-host-relation-inventory.mjs")], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
}

test("C2.5 bridge preserves legacy self-host inventory", () => {
  const result = runInventory(root);
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
});

test("C2.5 bridge makes the accepted native representation self-host inventory GREEN", () => {
  const clone = cloneCurrent();
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "candidate/731-c2-5-native-root-migration"], { cwd: clone, encoding: "utf8" });
    assert.equal(git(clone, ["rev-parse", "FETCH_HEAD"]), historicalMigration);
    execFileSync("git", ["cherry-pick", "-q", historicalMigration], { cwd: clone, encoding: "utf8" });
    const result = runInventory(clone);
    assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test("C2.5 bridge exposes one exact native TrustedRoot transition evaluator", async () => {
  const pipeline = await import("../dist/runtime/pipeline.mjs");
  assert.equal(typeof pipeline.evaluateRepoGuardTrustedRootMigrationSnapshot, "function");
});
