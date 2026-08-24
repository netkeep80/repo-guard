import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import { renderInitScaffold } from "../dist/init.mjs";
import { runCli } from "../dist/repo-guard.mjs";

const ACTION_REF = "cccccccccccccccccccccccccccccccccccccccc";
const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";

function write(repo, path, content) {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function scaffoldRepo(provider) {
  const repo = mkdtempSync(join(tmpdir(), "repo-guard-migrate-rollback-"));
  const scaffold = renderInitScaffold({
    preset: "application",
    mode: "blocking",
    actionRef: ACTION_REF,
    parallel: provider,
  });
  for (const [path, content] of Object.entries(scaffold)) write(repo, path, content);
  return repo;
}

function legacyScaffold() {
  return renderInitScaffold({ preset: "application", mode: "blocking", actionRef: ACTION_REF });
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

function rollbackArgs(repo, provider, mode = "--apply") {
  return [
    "--repo-root", repo,
    "migrate",
    "--parallel", provider,
    "--action-ref", ACTION_REF,
    "--rollback",
    mode,
    "--format", "json",
  ];
}

test("P5d exact-known rollback and compatibility", async (t) => {
  await t.test("dry-runs portable rollback with reverse external order and no writes", async () => {
    const repo = scaffoldRepo("portable"), before = snapshot(repo);
    const result = await capture(rollbackArgs(repo, "portable", "--dry-run"));
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(snapshot(repo), before);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "migrate");
    assert.equal(payload.mode, "dry-run");
    assert.equal(payload.operation, "rollback");
    assert.equal(payload.provider, "portable");
    assert.equal(payload.readyToApply, true);
    assert.deepEqual(payload.files.map(({ path, action }) => [path, action]), [
      [PORTABLE, "delete"],
      [TRANSACTION, "replace"],
      [POLICY, "replace"],
    ]);
    assert.deepEqual(payload.external.map(({ id }) => id), ["ready_label", "branch_protection"]);
  });

  await t.test("applies portable rollback to the exact legacy scaffold", async () => {
    const repo = scaffoldRepo("portable");
    const result = await capture(rollbackArgs(repo, "portable"));
    assert.equal(result.exit, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.operation, "rollback");
    assert.equal(payload.applied, true);
    assert.deepEqual(payload.writes, [PORTABLE, TRANSACTION, POLICY]);
    assert.deepEqual(snapshot(repo), legacyScaffold());
    assert.equal(existsSync(join(repo, PORTABLE)), false);
  });

  await t.test("uses the same rollback protocol for github_merge_queue", async () => {
    const repo = scaffoldRepo("github_merge_queue");
    const dryRun = await capture(rollbackArgs(repo, "github_merge_queue", "--dry-run"));
    assert.equal(dryRun.exit, 0, dryRun.stderr);
    const preview = JSON.parse(dryRun.stdout);
    assert.deepEqual(preview.files.map(({ path, action }) => [path, action]), [
      [NATIVE, "delete"],
      [TRANSACTION, "replace"],
      [POLICY, "replace"],
    ]);
    assert.deepEqual(preview.external.map(({ id }) => id), ["merge_queue"]);

    const applied = await capture(rollbackArgs(repo, "github_merge_queue"));
    assert.equal(applied.exit, 0, applied.stderr);
    assert.deepEqual(snapshot(repo), legacyScaffold());
  });

  await t.test("rolls back a known partial preparation and restores legacy-operable files", async () => {
    const repo = scaffoldRepo("portable");
    rmSync(join(repo, PORTABLE));
    const result = await capture(rollbackArgs(repo, "portable"));
    assert.equal(result.exit, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied, true);
    assert.deepEqual(payload.writes, [TRANSACTION, POLICY]);
    assert.deepEqual(snapshot(repo), legacyScaffold());
  });

  await t.test("refuses a customized provider workflow with zero writes", async () => {
    const repo = scaffoldRepo("portable");
    write(repo, PORTABLE, `${readFileSync(join(repo, PORTABLE), "utf8")}\n# repository-owned customization\n`);
    const before = snapshot(repo);

    const result = await capture(rollbackArgs(repo, "portable"));
    assert.equal(result.exit, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.operation, "rollback");
    assert.equal(payload.applied, false);
    assert.deepEqual(payload.writes, []);
    assert.equal(payload.blockers.some(({ id, path }) => id === "custom_file" && path === PORTABLE), true);
    assert.deepEqual(snapshot(repo), before);
  });

  await t.test("revalidates every rollback precondition before the first write", async () => {
    const { applyParallelRollback } = await import("../dist/migration-apply.mjs");
    assert.equal(typeof applyParallelRollback, "function");

    const target = renderInitScaffold({
      preset: "application",
      mode: "blocking",
      actionRef: ACTION_REF,
      parallel: "portable",
    });
    const files = {
      [POLICY]: target[POLICY],
      [TRANSACTION]: target[TRANSACTION],
      [PORTABLE]: target[PORTABLE],
      [NATIVE]: null,
    };
    const reads = new Map(), writes = [];
    const io = {
      read(path) {
        const count = (reads.get(path) ?? 0) + 1;
        reads.set(path, count);
        if (path === TRANSACTION && count === 2) return `${files[path]}\n# concurrent drift\n`;
        return files[path] ?? null;
      },
      create(path, content) {
        writes.push(["create", path]);
        files[path] = content;
      },
      replace(path, expectedBefore, content) {
        writes.push(["replace", path, expectedBefore]);
        files[path] = content;
      },
      delete(path, expectedBefore) {
        writes.push(["delete", path, expectedBefore]);
        files[path] = null;
      },
    };

    const result = await applyParallelRollback({ provider: "portable", actionRef: ACTION_REF, io });
    assert.equal(result.applied, false);
    assert.deepEqual(result.writes, []);
    assert.deepEqual(writes, []);
    assert.equal(result.blockers.some(({ id, path }) => id === "stale_snapshot" && path === TRANSACTION), true);
    assert.equal([...reads.values()].every((count) => count >= 2), true);
  });

  await t.test("does not change the existing forward dry-run machine shape", async () => {
    const repo = mkdtempSync(join(tmpdir(), "repo-guard-migrate-forward-compat-"));
    for (const [path, content] of Object.entries(legacyScaffold())) write(repo, path, content);
    const result = await capture([
      "--repo-root", repo,
      "migrate",
      "--parallel", "portable",
      "--action-ref", ACTION_REF,
      "--dry-run",
      "--format", "json",
    ]);
    assert.equal(result.exit, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(Object.hasOwn(payload, "operation"), false, "forward v2 machine output stays unchanged");
    assert.deepEqual(payload.external.map(({ id }) => id), ["branch_protection", "ready_label"]);
  });

  await t.test("documents executable rollback and records additive v2.1.0 semver evidence without cutting a release", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    assert.equal(packageJson.version, "2.0.0", "P5d must not cut the release version");

    const doc = readFileSync(resolve("docs/parallel-migration.md"), "utf8");
    assert.match(doc, /--rollback --dry-run/);
    assert.match(doc, /--rollback --apply/);
    assert.match(doc, /ready_label\s*->\s*branch_protection/);
    assert.match(doc, /merge_queue/);
    assert.match(doc, /v2\.1\.0/);
    assert.match(doc, /мажор/i);
    assert.match(doc, /#311/);
  });
});
