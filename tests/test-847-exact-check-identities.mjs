import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const cli = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function put(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=#847 Fixture", "-c", "user.email=847@example.invalid",
    "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

function check(root, base, head) {
  const result = spawnSync(process.execPath, [
    cli,
    "--repo-root", root,
    "check",
    "--base", base,
    "--head", head,
    "--format", "json",
  ], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.error, undefined);
  return result;
}

function assertRejected(result, label) {
  assert.equal(result.status, 1, label + " must be rejected before semantic evaluation");
  assert.equal(result.stdout, "", label + " must not emit a semantic report");
}

test("#847 public check accepts only literal exact BASE/HEAD commit SHA identities", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-847-"));
  try {
    git(root, "init", "-q", "--object-format=sha1");
    git(root, "branch", "-M", "main");

    put(root, "requirements/core.rg.yaml", `format: repo-guard/requirement-v1
id: CORE
normative: "exact identity fixture"
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "src/a.txt"
`);
    put(root, "src/a.txt", "base\n");
    const base = commit(root, "base");

    put(root, "src/a.txt", "head\n");
    const head = commit(root, "head");
    git(root, "tag", "fixture-tag", head);

    const exact = check(root, base, head);
    assert.equal(exact.status, 0, exact.stderr);
    const report = JSON.parse(exact.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.base, base);
    assert.equal(report.head, head);

    const aliases = [
      ["main", "main"],
      ["HEAD", "HEAD"],
      ["tag", "fixture-tag"],
      ["abbreviated SHA", head.slice(0, 12)],
      ["parent expression", head + "^1"],
      ["tilde expression", head + "~1"],
    ];

    for (const [label, alias] of aliases) {
      assertRejected(check(root, alias, head), "BASE " + label);
      assertRejected(check(root, base, alias), "HEAD " + label);
    }

    const nonexistent = "f".repeat(40);
    assert.notEqual(nonexistent, base);
    assert.notEqual(nonexistent, head);
    assertRejected(check(root, nonexistent, head), "nonexistent exact BASE SHA");
    assertRejected(check(root, base, nonexistent), "nonexistent exact HEAD SHA");

    const blob = git(root, "hash-object", "-w", "src/a.txt");
    assert.match(blob, /^[0-9a-f]{40}$/);
    assertRejected(check(root, blob, head), "non-commit exact BASE SHA");
    assertRejected(check(root, base, blob), "non-commit exact HEAD SHA");

    for (const malformed of ["A".repeat(40), "bad revision", "bad\nrevision"]) {
      assertRejected(check(root, malformed, head), "malformed BASE " + JSON.stringify(malformed));
      assertRejected(check(root, base, malformed), "malformed HEAD " + JSON.stringify(malformed));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("#847 literal exact public check identity matrix loaded");
