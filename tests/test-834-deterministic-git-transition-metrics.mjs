import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cli = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
const beforeLines = [
  "L4","L7","L3","L4","L5","L5","L2","L4","L6","L1","L5","L2","L7","L6","L7","L5","L5",
  "L7","L6","L6","L5","L2","L5","L2","L0","L0","L3","L5","L5","L2","L7","L7","L2",
];
const afterLines = [
  "L7","L1","L4","L5","L5","L2","L4","L6","L1","L5","L4","L7","L3","L2","L2","L5","L2",
  "L0","L5","L6","L5","L5","L7","L6","L6","L2","L7","L7","L2",
];
const requirement = `format: repo-guard/requirement-v1
id: CORE
normative: "deterministic git transition metrics"
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "src/a.txt"
constraints:
  - id: lines
    scope:
      relations: [implemented_by]
    metric:
      key: git.changed_lines
      max: 24
`;

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-834-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=#834 Fixture", "-c", "user.email=834@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    put("requirements/core.rg.yaml", requirement);
    put("src/a.txt", beforeLines.join("\n") + "\n");
    const base = commit("base");
    put("src/a.txt", afterLines.join("\n") + "\n");
    const head = commit("head");
    return fn({ root, git, base, head });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function rawChangedLines(root, base, head, algorithm) {
  const raw = execFileSync("git", [
    "-c", `diff.algorithm=${algorithm}`,
    "diff", "--numstat", "-z", "--find-renames", base, head,
  ], { cwd: root, encoding: "utf8" });
  const [record] = raw.split("\0");
  const [added, deleted] = record.split("\t");
  return Number(added) + Number(deleted);
}

function check(root, base, head, algorithm) {
  execFileSync("git", ["config", "diff.algorithm", algorithm], { cwd: root });
  const result = spawnSync(process.execPath, [
    cli, "--repo-root", root, "check", "--base", base, "--head", head, "--format", "json",
  ], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.error, undefined);
  const report = JSON.parse(result.stdout);
  const lines = report.j3.constraints.find((item) => item.constraintId === "lines");
  assert.ok(lines, JSON.stringify(report.j3.constraints));
  return { status: result.status, ok: report.ok, observed: lines.observed };
}

test("#834 F1 exact BASE/HEAD is invariant under local diff.algorithm (known 22/28, max 24)", () => {
  fixture(({ root, base, head }) => {
    assert.equal(rawChangedLines(root, base, head, "myers"), 22);
    assert.equal(rawChangedLines(root, base, head, "histogram"), 28);
    const myers = check(root, base, head, "myers");
    const histogram = check(root, base, head, "histogram");
    assert.deepEqual({ myers, histogram }, {
      myers: { status: 0, ok: true, observed: 22 },
      histogram: { status: 0, ok: true, observed: 22 },
    });
  });
});
