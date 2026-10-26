import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { evaluateLocalCompiler } from "../dist/local-compiler.mjs";
import { parseNameStatusZ } from "../dist/diff/parser.mjs";

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
const coreReq = ({ maxResources, maxLines, evidence = false, verifierRelation = true } = {}) => {
  let text = req("CORE", "src/a.txt");
  if (evidence && verifierRelation) text += `  - predicates: [verified_by]
    target:
      kind: artifact
      path: "tests/verifier.mjs"
`;
  const constraints = [];
  if (maxResources !== undefined) constraints.push(`  - id: resources
    scope:
      relations: [implemented_by]
    metric:
      key: git.changed_resources
      max: ${maxResources}
`);
  if (maxLines !== undefined) constraints.push(`  - id: lines
    scope:
      relations: [implemented_by]
    metric:
      key: git.changed_lines
      max: ${maxLines}
`);
  if (evidence) constraints.push(`  - id: execution
    scope:
      relations: [implemented_by]
    evidence:
      class: execution
      key: tests-pass
      verifier:
        kind: artifact
        path: "tests/verifier.mjs"
`);
  return text + (constraints.length ? "constraints:\n" + constraints.join("") : "");
};


try {
  git("init", "-q");
  put("requirements/core.rg.yaml", req("CORE", "src/a.txt"));
  put("src/a.txt", "first\n");
  const base = commit("base");
  assert.equal(evaluate(base, base).ok, true, "valid structural root must be GREEN");

  // #689: actual Git type/mode transitions must reach the causal compiler without
  // the historical textual-patch identity/content record-count mismatch.
  const identity = (from, to) => {
    const raw = execFileSync("git", ["-c", "core.quotepath=false", "diff",
      "--name-status", "-z", "--find-renames", from, to], { cwd: root, encoding: "utf8" });
    const parsed = parseNameStatusZ(raw);
    assert.equal(parsed.length, 1, "exactly one Git identity record");
    assert.equal(parsed[0].path, "src/a.txt");
    return { raw, file: parsed[0] };
  };
  unlinkSync(join(root, "src/a.txt"));
  symlinkSync("target.txt", join(root, "src/a.txt"));
  const symlinkHead = commit("regular to symlink");
  const forward = identity(base, symlinkHead);
  assert.equal(forward.raw, "T\0src/a.txt\0");
  assert.equal(forward.file.gitStatus, "T");
  assert.equal(forward.file.status, "modified");
  const forwardResult = evaluate(base, symlinkHead);
  assert.equal(forwardResult.ok, true, JSON.stringify(forwardResult.diagnostics));
  assert.equal(forwardResult.j1.base && forwardResult.j1.head && forwardResult.j2.base &&
    forwardResult.j2.head && forwardResult.j3.ok, true);
  assert.equal(forwardResult.diagnostics.length, 0);

  unlinkSync(join(root, "src/a.txt"));
  put("src/a.txt", "restored\n");
  const restoredRegular = commit("symlink to regular");
  const backward = identity(symlinkHead, restoredRegular);
  assert.equal(backward.raw, "T\0src/a.txt\0");
  assert.equal(backward.file.gitStatus, "T");
  const backwardResult = evaluate(symlinkHead, restoredRegular);
  assert.equal(backwardResult.ok, true, JSON.stringify(backwardResult.diagnostics));

  chmodSync(join(root, "src/a.txt"), 0o755);
  const executableHead = commit("executable bit");
  const mode = identity(restoredRegular, executableHead);
  assert.equal(mode.raw, "M\0src/a.txt\0");
  assert.equal(mode.file.gitStatus, undefined);
  const modeResult = evaluate(restoredRegular, executableHead);
  assert.equal(modeResult.ok, true, JSON.stringify(modeResult.diagnostics));
  chmodSync(join(root, "src/a.txt"), 0o644);
  const modeReset = commit("restore file mode");
  assert.equal(evaluate(executableHead, modeReset).ok, true);

  put("src/unowned.txt", "unowned\n");
  const unownedBase = commit("unjustified fixture base");
  unlinkSync(join(root, "src/unowned.txt"));
  symlinkSync("target.txt", join(root, "src/unowned.txt"));
  const unownedHead = commit("unjustified type change");
  const unownedRaw = execFileSync("git", ["diff", "--name-status", "-z",
    unownedBase, unownedHead], { cwd: root, encoding: "utf8" });
  assert.equal(unownedRaw, "T\0src/unowned.txt\0");
  const unownedResult = evaluate(unownedBase, unownedHead);
  assert.equal(unownedResult.ok, false);
  assert.ok(unownedResult.diagnostics.some(item => item.code === "unjustified_resource" &&
    item.subject.endsWith(":src/unowned.txt")), JSON.stringify(unownedResult.diagnostics));
  assert.ok(!unownedResult.diagnostics.some(item => /identity.content mismatch/.test(JSON.stringify(item))));
  git("rm", "-q", "src/unowned.txt");
  const cleanedUnowned = commit("remove unjustified fixture");
  assert.equal(evaluate(modeReset, cleanedUnowned).ok, true);

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

  // #806: clone-local remote configuration is not a versioned compiler input.
  // This must fail on the pre-fix baseline: owner/repository differs by Git remote.
  const sameSnapshotCheck = () => {
    const result = spawnSync(process.execPath, [
      new URL("../dist/repo-guard.mjs", import.meta.url).pathname,
      "--repo-root", root, "check", "--base", normative, "--head", restored, "--format", "json",
    ], { cwd: root, env: { PATH: process.env.PATH }, encoding: null });
    assert.equal(result.error, undefined);
    return result;
  };
  const snapshotHead = git("rev-parse", "HEAD");
  git("remote", "add", "origin", "https://github.com/example/a.git");
  const remoteA = sameSnapshotCheck();
  git("remote", "set-url", "origin", "https://github.com/example/b.git");
  const remoteB = sameSnapshotCheck();
  assert.equal(git("rev-parse", "HEAD"), snapshotHead, "remote changes cannot alter HEAD");
  assert.equal(remoteA.status, 0, "remote A must pass semantic check");
  assert.equal(remoteB.status, remoteA.status, "remote must not affect exit code");
  assert.deepEqual(remoteB.stdout, remoteA.stdout, "#806 entire JSON report must be byte-identical");
  assert.equal(JSON.parse(remoteA.stdout.toString("utf8")).repository, "local/repository");

  git("mv", "src/a.txt", "src/renamed.txt");
  put("requirements/core.rg.yaml", req("CORE", "src/renamed.txt"));
  const renamed = commit("atomic implementation rename");
  assert.equal(evaluate(restored, renamed).ok, true, "atomic justified rename GREEN");

  git("mv", "src/renamed.txt", "src/a.txt");
  put("requirements/core.rg.yaml", req("CORE", "src/a.txt"));
  const renameRestored = commit("atomic rename back");
  assert.equal(evaluate(renamed, renameRestored).ok, true, "rename back remains deterministic");

  put("requirements/core.rg.yaml", coreReq({ maxResources: 0 }));
  const resourceLimitBase = commit("add deterministic resource constraint");
  assert.equal(evaluate(renameRestored, resourceLimitBase).ok, true, "adding deterministic constraint without scoped resource change GREEN");

  put("src/a.txt", "resource-limit-red\n");
  const resourceLimitRed = commit("exceed resource constraint");
  assert.equal(evaluate(resourceLimitBase, resourceLimitRed).ok, false, "changed_resources limit RED");

  put("requirements/core.rg.yaml", coreReq({ maxResources: 1 }));
  const resourceLimitRaised = commit("raise deterministic resource constraint");
  assert.equal(evaluate(resourceLimitRed, resourceLimitRaised).ok, true, "constraint definition change needs no RepoGuard receipt");

  put("src/a.txt", "resource-limit-green\n");
  const resourceLimitGreen = commit("meet resource constraint");
  assert.equal(evaluate(resourceLimitRaised, resourceLimitGreen).ok, true, "changed_resources limit GREEN");

  put("requirements/core.rg.yaml", coreReq({ maxLines: 0 }));
  const lineLimitBase = commit("add deterministic changed-lines constraint");
  assert.equal(evaluate(resourceLimitGreen, lineLimitBase).ok, true);

  put("src/a.txt", "line-limit-red\n");
  const lineLimitRed = commit("exceed changed-lines constraint");
  assert.equal(evaluate(lineLimitBase, lineLimitRed).ok, false, "local Git changed_lines observation drives RED");

  put("requirements/core.rg.yaml", coreReq({ maxLines: 10 }));
  const lineLimitRaised = commit("raise changed-lines constraint");
  assert.equal(evaluate(lineLimitRed, lineLimitRaised).ok, true);

  put("src/a.txt", "line-limit-green\n");
  const lineLimitGreen = commit("meet changed-lines constraint");
  assert.equal(evaluate(lineLimitRaised, lineLimitGreen).ok, true, "local Git changed_lines observation drives GREEN");

  put("requirements/core.rg.yaml", coreReq({ evidence: true }));
  put("tests/verifier.mjs", "process.exit(0);\n");
  const evidenceBase = commit("declare external CI evidence traceability");
  assert.equal(evaluate(lineLimitGreen, evidenceBase).ok, true);

  put("src/a.txt", "external-evidence-delegated\n");
  const evidenceGreen = commit("change under external CI evidence constraint");
  const delegated = evaluate(evidenceBase, evidenceGreen);
  assert.equal(delegated.ok, true, "external execution truth is delegated to ordinary CI");
  assert.equal(delegated.j3.constraints.some(item => item.constraintId === "execution" && item.verdict === "DELEGATED"), true);

  put("requirements/core.rg.yaml", coreReq({ evidence: true, verifierRelation: false }));
  git("rm", "-q", "tests/verifier.mjs");
  put("src/a.txt", "invalid-external-verifier\n");
  const evidenceRed = commit("remove external verifier traceability");
  assert.equal(evaluate(evidenceGreen, evidenceRed).ok, false, "execution constraint without verified_by traceability RED");

  const cliPath = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
  const cleanJson = execFileSync(process.execPath, [
    cliPath, "--repo-root", root, "check", "--base", evidenceBase, "--head", evidenceGreen, "--format", "json",
  ], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  const ciJson = execFileSync(process.execPath, [
    cliPath, "--repo-root", root, "check", "--base", evidenceBase, "--head", evidenceGreen, "--format", "json",
  ], { cwd: root, encoding: "utf8", env: {
    PATH: process.env.PATH,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_PATH: "/nonexistent/event.json",
    GH_TOKEN: "must-not-be-read",
  } });
  assert.deepEqual(JSON.parse(ciJson), JSON.parse(cleanJson), "exact BASE/HEAD verdict must be independent of GitHub CI environment");
  console.log("C1 local compiler structural/constraint/equivalence witnesses: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
