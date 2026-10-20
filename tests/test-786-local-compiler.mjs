import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateLocalCompiler } from "../dist/local-compiler.mjs";

const root = mkdtempSync(join(tmpdir(), "repo-guard-c1-"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const commit = (message) => { git("add", "-A"); git("-c", "user.name=C1 Fixture", "-c", "user.email=c1@example.invalid", "commit", "-qm", message); return git("rev-parse", "HEAD"); };
const req = (id, target, parent) => `format: repo-guard/requirement-v1
id: ${id}
normative: "testable ${id}"
relations:
${parent ? `  - predicates: [derives_from]
    target:
      kind: requirement
      id: ${parent}
` : ""}${target ? `  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "${target}"
` : ""}`;
const evaluate = (base, head) => evaluateLocalCompiler({ root, repository: "fixture/c1", base, head });

try {
  git("init", "-q");
  put("requirements/core.rg.yaml", req("CORE", "src/a.txt"));
  put("src/a.txt", "first\n");
  const base = commit("base");
  assert.equal(evaluate(base, base).ok, true, "valid structural root must be GREEN");

  put("src/a.txt", "changed\n");
  const changed = commit("implementation change");
  assert.equal(evaluate(base, changed).ok, true, "justified implementation delta");

  put("orphan.tmp", "orphan\n");
  const orphan = commit("unjustified resource");
  assert.equal(evaluate(changed, orphan).ok, false, "orphan tracked resource is RED");

  git("rm", "-q", "orphan.tmp");
  put("requirements/child.rg.yaml", req("CHILD", "src/b.txt", "CORE"));
  put("src/b.txt", "second\n");
  const atom = commit("atomic Requirement and implementation");
  assert.equal(evaluate(changed, atom).ok, true, "atomic rooted Requirement + resource GREEN");

  put("requirements/child.rg.yaml", req("CHILD", "src/b.txt", "ABSENT"));
  const missingParent = commit("missing parent");
  assert.equal(evaluate(atom, missingParent).ok, false, "missing parent RED");

  put("requirements/child.rg.yaml", req("CHILD", "src/b.txt", "CHILD"));
  const cycle = commit("cycle");
  assert.equal(evaluate(atom, cycle).ok, false, "self-cycle RED");

  put("requirements/child.rg.yaml", req("CHILD", "src/b.txt", "CORE"));
  git("rm", "-q", "src/b.txt");
  const deletedRequired = commit("required resource deleted");
  assert.equal(evaluate(atom, deletedRequired).ok, false, "deleted required resource RED");

  put("requirements/child.rg.yaml", req("CHILD", undefined, "CORE"));
  const detached = commit("remove relation atomically");
  assert.equal(evaluate(atom, detached).ok, true, "delete resource and remove relation GREEN");
  put("requirements/core.rg.yaml", req("CORE", "src/a.txt").replace('"testable CORE"', '"amended CORE"'));
  const normative = commit("normative change");
  assert.equal(evaluate(detached, normative).ok, true, "valid normative text change must not require a grant");

  put("requirements/duplicate.rg.yaml", req("CORE"));
  const duplicate = commit("duplicate Requirement identity");
  assert.equal(evaluate(normative, duplicate).ok, false, "duplicate Requirement IDs RED");
  git("rm", "-q", "requirements/duplicate.rg.yaml");

  put("requirements/invalid.rg.yaml", "format: repo-guard/requirement-v1\\nid: INVALID\\n");
  const malformed = commit("malformed Requirement");
  assert.equal(evaluate(normative, malformed).ok, false, "malformed Requirement RED");
  git("rm", "-q", "requirements/invalid.rg.yaml");

  put("requirements/child.rg.yaml", req("CHILD", "src/nonexistent.txt", "CORE"));
  const dangling = commit("dangling resource relation");
  assert.equal(evaluate(normative, dangling).ok, false, "missing Resource target RED");

  put("requirements/child.rg.yaml", req("CHILD", undefined, "CORE"));
  put("requirements/core.rg.yaml", req("CORE", "src/a.txt", "CHILD"));
  const multiCycle = commit("multi-node cycle");
  assert.equal(evaluate(normative, multiCycle).ok, false, "multi-node Requirement cycle RED");

  put("requirements/core.rg.yaml", req("CORE", "src/a.txt"));
  const restored = commit("restore rooted Requirement graph");
  assert.equal(evaluate(normative, restored).ok, true, "restored graph GREEN");

  // No GitHub event, issue, App, authentication or remote is necessary for this executable CLI.
  const cli = execFileSync(process.execPath, [
    new URL("../dist/repo-guard.mjs", import.meta.url).pathname,
    "--repo-root", root, "check", "--base", normative, "--head", restored, "--format", "json",
  ], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  const report = JSON.parse(cli);
  assert.equal(report.ok, true, "local CLI should agree with direct evaluator");
  assert.equal(report.base, normative);
  assert.equal(report.head, restored);
  console.log("C1 local compiler structural witnesses: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
