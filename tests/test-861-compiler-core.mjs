import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateLocalCompiler } from "../dist/local-compiler.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const put = (root, path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
};
const commit = (root, message) => {
  git(root, "add", "-A");
  git(root, "-c", "user.name=#861 A1", "-c", "user.email=861@example.invalid", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
};

test("#861 A1 accepted LocalGit whole-report characterization", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-861-a1-"));
  try {
    git(root, "init", "-q", "--object-format=sha1");
    put(root, "requirements/core.rg.yaml", `format: repo-guard/requirement-v1
id: CORE
normative: "Slice A characterization"
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "src/a.txt"
`);
    put(root, "src/a.txt", "before\n");
    const base = commit(root, "base");
    put(root, "src/a.txt", "after\n");
    const head = commit(root, "head");

    const report = evaluateLocalCompiler({
      root,
      repository: "fixture/861",
      base,
      head,
    });

    assert.deepEqual(report, {
      format: "repo-guard/local-compiler-v1",
      repository: "fixture/861",
      base,
      head,
      ok: true,
      j1: {
        base: true,
        head: true,
        tracked: 2,
        justified: 2,
      },
      j2: {
        base: true,
        head: true,
        rooted: 1,
      },
      j3: {
        changed: 1,
        ok: true,
        affectedRequirements: ["CORE"],
        deltas: [{
          id: "resource_modify:src/a.txt",
          kind: "resource_modify",
          subject: "src/a.txt",
          afterPath: "src/a.txt",
          beforePath: "src/a.txt",
        }],
        constraints: [],
      },
      diagnostics: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("#861 Slice A LocalGit whole-report characterization loaded");
