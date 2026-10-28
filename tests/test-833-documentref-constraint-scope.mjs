import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateLocalCompiler } from "../dist/local-compiler.mjs";

const repository = "local/repository";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function put(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

function commit(root, message, allowEmpty = false) {
  git(root, "add", "-A");
  git(
    root,
    "-c", "user.name=#833 Fixture",
    "-c", "user.email=833@example.invalid",
    "commit",
    "-qm", message,
    ...(allowEmpty ? ["--allow-empty"] : []),
  );
  return git(root, "rev-parse", "HEAD");
}

function requirement({ documentPath, pointer, ownerPath, metric = "git.changed_resources", max = 0 }) {
  return JSON.stringify({
    format: "repo-guard/requirement-v1",
    id: "R1",
    normative: "DocumentRef Constraint scope must be exact and fail closed",
    relations: [
      {
        predicates: ["implemented_by"],
        target: { kind: "artifact", path: ownerPath },
      },
      {
        predicates: ["documents"],
        target: { kind: "document", path: documentPath, pointer },
      },
    ],
    constraints: [
      {
        id: "doc-scope",
        scope: { relations: ["documents"] },
        metric: { key: metric, max },
      },
    ],
  }, null, 2) + "\n";
}

function initFixture() {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-833-"));
  git(root, "init", "-q");
  return root;
}

function constraint(report) {
  const item = report.j3.constraints.find(entry => entry.constraintId === "doc-scope");
  assert.ok(item, JSON.stringify(report, null, 2));
  return item;
}

test("#833 F1 DocumentRef path must seed changed_resources Constraint scope", () => {
  const root = initFixture();
  try {
    put(root, "requirements/r1.rg.json", requirement({
      documentPath: "docs/a.json",
      pointer: "/guarded",
      ownerPath: "docs/a.json",
      max: 0,
    }));
    put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 }, outside: 1 }) + "\n");
    const base = commit(root, "base");

    put(root, "docs/a.json", JSON.stringify({ guarded: { value: 2 }, outside: 1 }) + "\n");
    const head = commit(root, "head");

    const report = evaluateLocalCompiler({ root, repository, base, head });
    const scoped = constraint(report);
    assert.equal(report.ok, false, "changed referenced document must exceed max=0");
    assert.equal(scoped.verdict, "RED");
    assert.equal(scoped.observed, 1);
    assert.deepEqual(scoped.scope, ["docs/a.json"]);
    assert.deepEqual(scoped.touched, ["docs/a.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#833 F2 missing local DocumentRef path must be blocking", () => {
  const root = initFixture();
  try {
    put(root, "requirements/r1.rg.json", requirement({
      documentPath: "docs/missing.json",
      pointer: "/guarded",
      ownerPath: "src/owned.txt",
    }));
    put(root, "src/owned.txt", "owned\n");
    const base = commit(root, "base");
    const head = commit(root, "head", true);

    const report = evaluateLocalCompiler({ root, repository, base, head });
    assert.equal(report.ok, false, "dangling local document path must fail closed");
    assert.ok(
      report.diagnostics.some(item => item.code === "document_ref_missing_path"),
      JSON.stringify(report.diagnostics, null, 2),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#833 F3 missing local DocumentRef pointer must be blocking", () => {
  const root = initFixture();
  try {
    put(root, "requirements/r1.rg.json", requirement({
      documentPath: "docs/a.json",
      pointer: "/missing",
      ownerPath: "docs/a.json",
    }));
    put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 } }) + "\n");
    const base = commit(root, "base");
    const head = commit(root, "head", true);

    const report = evaluateLocalCompiler({ root, repository, base, head });
    assert.equal(report.ok, false, "missing document fragment must fail closed");
    assert.ok(
      report.diagnostics.some(item => item.code === "document_ref_missing_fragment"),
      JSON.stringify(report.diagnostics, null, 2),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("#833 DocumentRef falsification witnesses loaded");
