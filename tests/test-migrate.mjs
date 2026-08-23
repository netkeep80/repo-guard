import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { renderInitScaffold } from "../dist/init.mjs";
import { COMMANDS, runCli } from "../dist/repo-guard.mjs";

const ACTION_REF = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";

function write(repo, path, content) {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function legacyRepo() {
  const repo = mkdtempSync(join(tmpdir(), "repo-guard-migrate-"));
  const scaffold = renderInitScaffold({ preset: "application", mode: "blocking", actionRef: ACTION_REF });
  for (const [path, content] of Object.entries(scaffold)) write(repo, path, content);
  return repo;
}

function snapshot(root) {
  const out = {};
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf8");
    }
  }
  walk(root);
  return out;
}

async function capture(args) {
  const logs = [], errors = [];
  const oldLog = console.log, oldError = console.error;
  console.log = (...parts) => logs.push(parts.join(" "));
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    const exit = await runCli(args);
    return { exit, stdout: logs.join("\n"), stderr: errors.join("\n") };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

test("P5b migrate dry-run public surface", async (t) => {
  await t.test("is an additive declarative CLI command", () => {
    assert.equal(COMMANDS.includes("migrate"), true);
  });

  await t.test("emits a deterministic portable JSON plan without writing", async () => {
    const repo = legacyRepo(), before = snapshot(repo);
    const first = await capture(["--repo-root", repo, "migrate", "--parallel", "portable", "--action-ref", ACTION_REF, "--dry-run", "--format", "json"]);
    const after = snapshot(repo);
    assert.equal(first.exit, 0, first.stderr);
    assert.deepEqual(after, before, "dry-run never changes repository files");
    const payload = JSON.parse(first.stdout);
    assert.equal(payload.command, "migrate");
    assert.equal(payload.mode, "dry-run");
    assert.equal(payload.provider, "portable");
    assert.equal(payload.actionRef, ACTION_REF);
    assert.equal(payload.readyToApply, true);
    assert.deepEqual(payload.files.map(({ path, action }) => [path, action]), [
      [PORTABLE, "create"],
      [TRANSACTION, "replace"],
      [POLICY, "replace"],
    ]);
    assert.deepEqual(payload.external.map(({ id }) => id), ["branch_protection", "ready_label"]);

    const second = await capture(["--repo-root", repo, "migrate", "--parallel", "portable", "--action-ref", ACTION_REF, "--dry-run", "--format", "json"]);
    assert.equal(second.exit, 0);
    assert.equal(second.stdout, first.stdout, "same repository snapshot yields byte-stable JSON output");
    assert.deepEqual(snapshot(repo), before);
  });

  await t.test("fails closed on a custom workflow and preserves it byte-for-byte", async () => {
    const repo = legacyRepo();
    write(repo, TRANSACTION, `${readFileSync(join(repo, TRANSACTION), "utf8")}\n# custom repository step\n`);
    const before = snapshot(repo);
    const result = await capture(["--repo-root", repo, "migrate", "--parallel", "portable", "--action-ref", ACTION_REF, "--dry-run", "--format", "json"]);
    assert.equal(result.exit, 1);
    assert.deepEqual(snapshot(repo), before);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.readyToApply, false);
    assert.equal(payload.blockers.some(({ id, path }) => id === "custom_file" && path === TRANSACTION), true);
  });

  await t.test("requires explicit dry-run before any future apply surface", async () => {
    const repo = legacyRepo(), before = snapshot(repo);
    const result = await capture(["--repo-root", repo, "migrate", "--parallel", "portable", "--action-ref", ACTION_REF, "--format", "json"]);
    assert.equal(result.exit, 1);
    assert.match(result.stderr, /dry-run/i);
    assert.deepEqual(snapshot(repo), before);
  });

  await t.test("rejects mutable Action refs before planning or writing", async () => {
    const repo = legacyRepo(), before = snapshot(repo);
    const result = await capture(["--repo-root", repo, "migrate", "--parallel", "portable", "--action-ref", "main", "--dry-run", "--format", "json"]);
    assert.equal(result.exit, 1);
    assert.match(result.stderr, /mutable|ambiguous|Action ref/i);
    assert.deepEqual(snapshot(repo), before);
  });

  await t.test("uses the same machine protocol for github_merge_queue", async () => {
    const repo = legacyRepo(), before = snapshot(repo);
    const result = await capture(["--repo-root", repo, "migrate", "--parallel", "github_merge_queue", "--action-ref", ACTION_REF, "--dry-run", "--format", "json"]);
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(snapshot(repo), before);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.provider, "github_merge_queue");
    assert.deepEqual(payload.files.map(({ path, action }) => [path, action]), [
      [NATIVE, "create"],
      [TRANSACTION, "replace"],
      [POLICY, "replace"],
    ]);
    assert.deepEqual(payload.external.map(({ id }) => id), ["merge_queue"]);
  });
});
