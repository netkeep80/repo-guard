import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { renderInitScaffold } from "../dist/init.mjs";
import { runCli } from "../dist/repo-guard.mjs";

const ACTION_REF = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
  const repo = mkdtempSync(join(tmpdir(), "repo-guard-migrate-apply-"));
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

function applyArgs(repo, provider = "portable") {
  return ["--repo-root", repo, "migrate", "--parallel", provider, "--action-ref", ACTION_REF, "--apply", "--format", "json"];
}

test("P5c known-template migration apply", async (t) => {
  await t.test("applies only the exact known portable scaffold", async () => {
    const repo = legacyRepo();
    const expected = renderInitScaffold({ preset: "application", mode: "blocking", actionRef: ACTION_REF, parallel: "portable" });

    const result = await capture(applyArgs(repo));
    assert.equal(result.exit, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "migrate");
    assert.equal(payload.mode, "apply");
    assert.equal(payload.provider, "portable");
    assert.equal(payload.applied, true);
    assert.deepEqual(payload.writes, [PORTABLE, TRANSACTION, POLICY]);
    assert.deepEqual(snapshot(repo), expected);
  });

  await t.test("is idempotent after the target scaffold is already exact", async () => {
    const repo = legacyRepo();
    const first = await capture(applyArgs(repo));
    assert.equal(first.exit, 0, first.stderr);
    const before = snapshot(repo);

    const second = await capture(applyArgs(repo));
    assert.equal(second.exit, 0, second.stderr);
    const payload = JSON.parse(second.stdout);
    assert.equal(payload.applied, true);
    assert.deepEqual(payload.writes, []);
    assert.deepEqual(snapshot(repo), before);
  });

  await t.test("refuses a custom repository workflow with zero writes", async () => {
    const repo = legacyRepo();
    write(repo, TRANSACTION, `${readFileSync(join(repo, TRANSACTION), "utf8")}\n# repository-owned customization\n`);
    const before = snapshot(repo);

    const result = await capture(applyArgs(repo));
    assert.equal(result.exit, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied, false);
    assert.deepEqual(payload.writes, []);
    assert.equal(payload.blockers.some(({ id, path }) => id === "custom_file" && path === TRANSACTION), true);
    assert.deepEqual(snapshot(repo), before);
  });

  await t.test("requires exactly one of dry-run or apply", async () => {
    const repo = legacyRepo(), before = snapshot(repo);
    const result = await capture([...applyArgs(repo), "--dry-run"]);
    assert.equal(result.exit, 1);
    assert.match(result.stderr, /dry-run|apply|exactly one|mutually exclusive/i);
    assert.deepEqual(snapshot(repo), before);
  });

  await t.test("refuses an opposite-provider scaffold instead of switching providers", async () => {
    const repo = legacyRepo();
    const native = renderInitScaffold({ preset: "application", mode: "blocking", actionRef: ACTION_REF, parallel: "github_merge_queue" });
    write(repo, NATIVE, native[NATIVE]);
    const before = snapshot(repo);

    const result = await capture(applyArgs(repo, "portable"));
    assert.equal(result.exit, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied, false);
    assert.deepEqual(payload.writes, []);
    assert.equal(payload.blockers.some(({ id, path }) => id === "provider_conflict" && path === NATIVE), true);
    assert.deepEqual(snapshot(repo), before);
  });

  await t.test("revalidates the complete snapshot before the first write", async () => {
    const { applyParallelMigration } = await import("../dist/migration-apply.mjs");
    const legacy = renderInitScaffold({ preset: "application", mode: "blocking", actionRef: ACTION_REF });
    const files = {
      [POLICY]: legacy[POLICY],
      [TRANSACTION]: legacy[TRANSACTION],
      [PORTABLE]: null,
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
    };

    const result = await applyParallelMigration({ provider: "portable", actionRef: ACTION_REF, io });
    assert.equal(result.applied, false);
    assert.deepEqual(result.writes, []);
    assert.deepEqual(writes, []);
    assert.equal(result.blockers.some(({ id, path }) => id === "stale_snapshot" && path === TRANSACTION), true);
    assert.equal([...reads.values()].every((count) => count >= 2), true, "every migration precondition is re-read before mutation");
  });
});
