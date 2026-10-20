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
  console.log("C1 local compiler basic witnesses: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
