import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, chmodSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { evaluateLocalCompiler } from "../dist/local-compiler.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { evaluateTransitionCauseClosure, resourceDeltasFromParsedDiff } from "../dist/runtime/transition-closure.mjs";
import { loadNativeRequirements, lowerNativeRequirements, validateCompiledConstraint } from "../dist/runtime/canonical-requirements.mjs";
import { parseNameStatusZ } from "../dist/diff/parser.mjs";
import { listTrackedEntriesAtRef, readFileBytesAtRef } from "../dist/git.mjs";

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


// #834 deterministic Git transition metric hardening matrix.
{
  
  const cli = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
  const beforeLines = [
    "L4","L7","L3","L4","L5","L5","L2","L4","L6","L1","L5","L2","L7","L6","L7","L5","L5",
    "L7","L6","L6","L5","L2","L5","L2","L0","L0","L3","L5","L5","L2","L7","L7","L2",
  ];
  const afterLines = [
    "L7","L1","L4","L5","L5","L2","L4","L6","L1","L5","L4","L7","L3","L2","L2","L5","L2",
    "L0","L5","L6","L5","L5","L7","L6","L6","L2","L7","L7","L2",
  ];
  
  const metricRequirement = (paths, metric = "git.changed_lines", max = 24) => `format: repo-guard/requirement-v1
  id: CORE
  normative: "deterministic git transition metrics"
  relations:
  ${paths.map((path) => `  - predicates: [implemented_by]
      target:
        kind: artifact
        path: "${path}"
  `).join("")}constraints:
    - id: metric
      scope:
        relations: [implemented_by]
      metric:
        key: ${metric}
        max: ${max}
  `.replace(/^  /gm, "");
  
  function init(root) {
    execFileSync("git", ["init", "-q"], { cwd: root });
  }
  function git(root, ...args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  }
  function put(root, path, value) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  }
  function commit(root, message) {
    git(root, "add", "-A");
    git(root, "-c", "user.name=#834 Fixture", "-c", "user.email=834@example.invalid", "commit", "-qm", message);
    return git(root, "rev-parse", "HEAD");
  }
  function setConfig(root, key, value) {
    if (value === null) {
      spawnSync("git", ["config", "--unset-all", key], { cwd: root });
      return;
    }
    git(root, "config", key, value);
  }
  function runCheck(root, base, head, env = {}) {
    const result = spawnSync(process.execPath, [
      cli, "--repo-root", root, "check", "--base", base, "--head", head, "--format", "json",
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH, ...env },
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.stdout, "", result.stderr);
    return { status: result.status, report: JSON.parse(result.stdout) };
  }
  function constraint(report) {
    const item = report.j3.constraints.find((entry) => entry.constraintId === "metric");
    assert.ok(item, JSON.stringify({ diagnostics: report.diagnostics, j3: report.j3 }, null, 2));
    return item;
  }
  function semantic(check) {
    return {
      status: check.status,
      ok: check.report.ok,
      changed: check.report.j3.changed,
      deltas: check.report.j3.deltas,
      diagnostics: check.report.diagnostics,
      constraint: constraint(check.report),
    };
  }
  function lineFixture(fn) {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-834-lines-"));
    try {
      init(root);
      put(root, "requirements/core.rg.yaml", metricRequirement(["src/a.txt"]));
      put(root, "src/a.txt", beforeLines.join("\n") + "\n");
      const base = commit(root, "base");
      put(root, "src/a.txt", afterLines.join("\n") + "\n");
      const head = commit(root, "head");
      return fn({ root, base, head });
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
  
  test("#834 F1 exact BASE/HEAD is invariant under local diff.algorithm (known 22/28, max 24)", () => {
    lineFixture(({ root, base, head }) => {
      assert.equal(rawChangedLines(root, base, head, "myers"), 22);
      assert.equal(rawChangedLines(root, base, head, "histogram"), 28);
  
      setConfig(root, "diff.algorithm", "myers");
      const myers = runCheck(root, base, head);
      setConfig(root, "diff.algorithm", "histogram");
      const histogram = runCheck(root, base, head);
  
      assert.deepEqual(
        {
          myers: { status: myers.status, ok: myers.report.ok, observed: constraint(myers.report).observed },
          histogram: { status: histogram.status, ok: histogram.report.ok, observed: constraint(histogram.report).observed },
        },
        {
          myers: { status: 0, ok: true, observed: 22 },
          histogram: { status: 0, ok: true, observed: 22 },
        },
      );
    });
  });
  
  test("#834 F2 algorithm, indent heuristic and config-injection environment cannot change changed_lines", () => {
    lineFixture(({ root, base, head }) => {
      let expected;
      for (const algorithm of ["default", "myers", "histogram", "patience", "minimal"]) {
        setConfig(root, "diff.algorithm", algorithm);
        for (const indent of ["true", "false"]) {
          setConfig(root, "diff.indentHeuristic", indent);
          const current = semantic(runCheck(root, base, head));
          expected ??= current;
          assert.deepEqual(current, expected, `algorithm=${algorithm} indent=${indent}`);
          assert.equal(current.constraint.observed, 22);
        }
      }
  
      const injected = semantic(runCheck(root, base, head, {
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "diff.algorithm",
        GIT_CONFIG_VALUE_0: "histogram",
        GIT_CONFIG_KEY_1: "diff.renameLimit",
        GIT_CONFIG_VALUE_1: "1",
        GIT_CONFIG_KEY_2: "diff.ignoreSubmodules",
        GIT_CONFIG_VALUE_2: "all",
        GIT_DIFF_OPTS: "-w",
      }));
      assert.deepEqual(injected, expected);
    });
  });
  
  test("#834 F3 rename identity and changed_resources ignore local diff.renames/diff.renameLimit", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-834-renames-"));
    try {
      init(root);
      const oldPaths = Array.from({ length: 6 }, (_, i) => `src/old${i}.txt`);
      const newPaths = Array.from({ length: 6 }, (_, i) => `src/new${i}.txt`);
      put(root, "requirements/core.rg.yaml", metricRequirement(oldPaths, "git.changed_resources", 6));
      for (let i = 0; i < oldPaths.length; i++) {
        put(root, oldPaths[i], Array.from({ length: 20 }, (_, j) => `common-${i}-${j}`).join("\n") + "\nold-tail\n");
      }
      const base = commit(root, "rename base");
  
      for (let i = 0; i < oldPaths.length; i++) {
        git(root, "mv", oldPaths[i], newPaths[i]);
        put(root, newPaths[i], Array.from({ length: 20 }, (_, j) => `common-${i}-${j}`).join("\n") + "\nnew-tail\n");
      }
      put(root, "requirements/core.rg.yaml", metricRequirement(newPaths, "git.changed_resources", 6));
      const head = commit(root, "rename head");
  
      const configs = [
        { "diff.renames": "true", "diff.renameLimit": "1000" },
        { "diff.renames": "false", "diff.renameLimit": "1" },
        { "diff.renames": "copies", "diff.renameLimit": "2" },
      ];
      let expected;
      for (const config of configs) {
        for (const [key, value] of Object.entries(config)) setConfig(root, key, value);
        const current = semantic(runCheck(root, base, head));
        expected ??= current;
        assert.deepEqual(current, expected);
        assert.equal(current.constraint.observed, 6);
        assert.equal(current.constraint.verdict, "PASS");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  
  function binaryFixture(versionedText, fn) {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-834-binary-"));
    try {
      init(root);
      const paths = ["src/a.bin", ...(versionedText ? [".gitattributes"] : [])];
      put(root, "requirements/core.rg.yaml", metricRequirement(paths, "git.changed_lines", 100));
      if (versionedText) put(root, ".gitattributes", "*.bin diff\n");
      put(root, "src/a.bin", Buffer.from([0x61, 0x00, 0x78, 0x0a]));
      const base = commit(root, "binary base");
      put(root, "src/a.bin", Buffer.from([0x62, 0x00, 0x79, 0x0a]));
      const head = commit(root, "binary head");
      return fn({ root, base, head });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  
  test("#834 F4 unversioned attributes/external diff/textconv cannot change binary changed_lines semantics", () => {
    binaryFixture(false, ({ root, base, head }) => {
      const clean = semantic(runCheck(root, base, head));
      assert.equal(clean.status, 1);
      assert.equal(clean.constraint.observed, null);
      assert.equal(clean.constraint.verdict, "RED");
  
      mkdirSync(join(root, ".git", "info"), { recursive: true });
      put(root, ".git/info/attributes", "*.bin diff=evil\n");
      const marker = join(root, "external-diff-ran");
      const helper = join(root, "hostile-diff.sh");
      writeFileSync(helper, `#!/bin/sh\necho hit >> "${marker}"\nprintf 'converted\\n'\n`);
      chmodSync(helper, 0o755);
      setConfig(root, "diff.evil.textconv", helper);
      setConfig(root, "diff.external", helper);
  
      const globalAttributes = join(root, "global-attributes");
      writeFileSync(globalAttributes, "*.bin diff\n");
      setConfig(root, "core.attributesFile", globalAttributes);
  
      const systemConfig = join(root, "system.gitconfig");
      writeFileSync(systemConfig, `[core]\n\tattributesFile = ${globalAttributes}\n[diff]\n\talgorithm = histogram\n`);
  
      const hostile = semantic(runCheck(root, base, head, {
        GIT_EXTERNAL_DIFF: helper,
        GIT_CONFIG_SYSTEM: systemConfig,
        GIT_ATTR_NOSYSTEM: "0",
        HOME: root,
        XDG_CONFIG_HOME: root,
      }));
      assert.deepEqual(hostile, clean);
      assert.equal(existsSync(marker), false, "external/textconv helper must not execute");
    });
  
    binaryFixture(true, ({ root, base, head }) => {
      const versioned = semantic(runCheck(root, base, head));
      assert.equal(versioned.status, 0);
      assert.equal(versioned.constraint.observed, 2, "HEAD-versioned .gitattributes remains semantic input");
      assert.equal(versioned.constraint.verdict, "PASS");
  
      put(root, ".git/info/attributes", "*.bin -diff\n");
      const overriddenLocally = semantic(runCheck(root, base, head));
      assert.deepEqual(overriddenLocally, versioned, ".git/info/attributes cannot override exact-HEAD attributes");
    });
  });
  
  test("#834 F5 full Constraint-relevant report is invariant under materially hostile local Git config/environment", () => {
    lineFixture(({ root, base, head }) => {
      for (const key of ["diff.algorithm", "diff.indentHeuristic", "diff.renameLimit", "diff.ignoreSubmodules", "core.attributesFile"]) {
        setConfig(root, key, null);
      }
      const clean = runCheck(root, base, head);
      assert.equal(clean.status, 0, JSON.stringify(clean.report, null, 2));
  
      const attrs = join(root, "hostile-attributes");
      writeFileSync(attrs, "*.txt -diff\n");
      const home = join(root, "hostile-home");
      mkdirSync(join(home, ".config", "git"), { recursive: true });
      writeFileSync(join(home, ".gitconfig"), "[diff]\n\talgorithm = histogram\n\trenameLimit = 1\n");
      writeFileSync(join(home, ".config", "git", "attributes"), "*.txt -diff\n");
      setConfig(root, "diff.algorithm", "histogram");
      setConfig(root, "diff.indentHeuristic", "false");
      setConfig(root, "diff.renameLimit", "1");
      setConfig(root, "diff.ignoreSubmodules", "all");
      setConfig(root, "core.attributesFile", attrs);
  
      const hostile = runCheck(root, base, head, {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "diff.algorithm",
        GIT_CONFIG_VALUE_0: "histogram",
        GIT_DIFF_OPTS: "-w",
        GIT_EXTERNAL_DIFF: join(root, "must-not-run"),
      });
      assert.deepEqual(hostile.report, clean.report);
      assert.equal(hostile.status, clean.status);
    });
  });
  
  test("#834 F6 submodule transition identity ignores diff.ignoreSubmodules", () => {
    const objects = mkdtempSync(join(tmpdir(), "repo-guard-834-subobjects-"));
    const root = mkdtempSync(join(tmpdir(), "repo-guard-834-submodule-"));
    try {
      init(objects);
      put(objects, "f.txt", "a\n");
      const first = commit(objects, "sub first");
      put(objects, "f.txt", "b\n");
      const second = commit(objects, "sub second");
  
      init(root);
      put(root, "requirements/core.rg.yaml", metricRequirement(["deps/lib"], "git.changed_resources", 0));
      git(root, "add", "requirements/core.rg.yaml");
      git(root, "update-index", "--add", "--cacheinfo", `160000,${first},deps/lib`);
      git(root, "-c", "user.name=#834 Fixture", "-c", "user.email=834@example.invalid", "commit", "-qm", "gitlink base");
      const base = git(root, "rev-parse", "HEAD");
      git(root, "update-index", "--cacheinfo", `160000,${second},deps/lib`);
      git(root, "-c", "user.name=#834 Fixture", "-c", "user.email=834@example.invalid", "commit", "-qm", "gitlink head");
      const head = git(root, "rev-parse", "HEAD");
  
      setConfig(root, "diff.ignoreSubmodules", "none");
      const visible = semantic(runCheck(root, base, head));
      setConfig(root, "diff.ignoreSubmodules", "all");
      const hiddenLocally = semantic(runCheck(root, base, head));
      assert.deepEqual(hiddenLocally, visible);
      assert.equal(visible.constraint.observed, 1);
      assert.equal(visible.constraint.verdict, "RED");
    } finally {
      rmSync(objects, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  
  test("#834 F7 hostile GIT_TEMPLATE_DIR cannot inject temp-repo attributes", () => {
    binaryFixture(false, ({ root, base, head }) => {
      const template = join(root, "hostile-template");
      mkdirSync(join(template, "info"), { recursive: true });
      writeFileSync(join(template, "info", "attributes"), "*.bin diff\n");

      const controlRoot = mkdtempSync(join(tmpdir(), "repo-guard-834-template-control-"));
      const controlGitDir = join(controlRoot, "repo.git");
      try {
        execFileSync("git", ["init", "--bare", "-q", controlGitDir], {
          cwd: root,
          env: { ...process.env, GIT_TEMPLATE_DIR: template, GIT_DEFAULT_HASH: "sha1" },
        });
        assert.equal(existsSync(join(controlGitDir, "info", "attributes")), true,
          "ordinary unprotected git init must copy hostile info/attributes");

        const objectDirectory = join(git(root, "rev-parse", "--absolute-git-dir"), "objects");
        const raw = execFileSync("git", [
          `--git-dir=${controlGitDir}`,
          `--attr-source=${head}`,
          "-c", "core.quotepath=false",
          "-c", `core.attributesFile=${devNull}`,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=none",
          "--diff-algorithm=myers",
          "--indent-heuristic",
          "--find-renames=50%",
          "-l1000",
          "--numstat",
          "-z",
          base,
          head,
        ], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory },
        });
        assert.equal(raw, "1\t1\tsrc/a.bin\0",
          "unprotected temp-repo info/attributes must change binary numstat to numeric");
      } finally {
        rmSync(controlRoot, { recursive: true, force: true });
      }

      const clean = semantic(runCheck(root, base, head));
      const hostile = semantic(runCheck(root, base, head, { GIT_TEMPLATE_DIR: template }));
      assert.deepEqual(hostile, clean);
      assert.equal(clean.constraint.observed, null);
      assert.equal(clean.constraint.verdict, "RED");
    });
  });

  test("#834 F8 GIT_DEFAULT_HASH cannot alter temp observation repository format", () => {
    lineFixture(({ root, base, head }) => {
      const controlRoot = mkdtempSync(join(tmpdir(), "repo-guard-834-hash-control-"));
      const controlGitDir = join(controlRoot, "repo.git");
      const emptyTemplate = join(controlRoot, "empty-template");
      try {
        mkdirSync(emptyTemplate);
        execFileSync("git", ["init", "--bare", "-q", controlGitDir], {
          cwd: root,
          env: {
            ...process.env,
            GIT_TEMPLATE_DIR: emptyTemplate,
            GIT_DEFAULT_HASH: "sha256",
          },
        });
        const objectFormat = execFileSync("git", [
          `--git-dir=${controlGitDir}`,
          "rev-parse",
          "--show-object-format",
        ], { cwd: root, encoding: "utf8" }).trim();
        assert.equal(objectFormat, "sha256",
          "ordinary unprotected git init must honor GIT_DEFAULT_HASH=sha256");
      } finally {
        rmSync(controlRoot, { recursive: true, force: true });
      }

      const clean = semantic(runCheck(root, base, head));
      const hostile = semantic(runCheck(root, base, head, { GIT_DEFAULT_HASH: "sha256" }));
      assert.deepEqual(hostile, clean);
      assert.equal(clean.status, 0);
      assert.equal(clean.constraint.observed, 22);
      assert.equal(clean.constraint.verdict, "PASS");
    });
  });

  console.log("#834 deterministic Git transition metric matrix: PASS");
}


{
  const r833Repository = "local/repository";

  const r833Git = (root, ...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  const r833Put = (root, path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };

  const r833Commit = (root, message, allowEmpty = false) => {
    r833Git(root, "add", "-A");
    r833Git(
      root,
      "-c", "user.name=#833 Fixture",
      "-c", "user.email=833@example.invalid",
      "commit",
      "-qm", message,
      ...(allowEmpty ? ["--allow-empty"] : []),
    );
    return r833Git(root, "rev-parse", "HEAD");
  };

  const r833Requirement = ({ documentPath, pointer, ownerPath, metric = "git.changed_resources", max = 0 }) =>
    JSON.stringify({
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

  const r833Constraint = (report) => {
    const item = report.j3.constraints.find(entry => entry.constraintId === "doc-scope");
    assert.ok(item, JSON.stringify(report, null, 2));
    return item;
  };

  const r833Init = () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-833-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  };

  test("#833 F1 DocumentRef path must seed changed_resources Constraint scope", () => {
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833Requirement({
        documentPath: "docs/a.json",
        pointer: "/guarded",
        ownerPath: "docs/a.json",
        max: 0,
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 }, outside: 1 }) + "\n");
      const base = r833Commit(root, "base");
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 2 }, outside: 1 }) + "\n");
      const head = r833Commit(root, "head");

      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      const scoped = r833Constraint(report);
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
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833Requirement({
        documentPath: "docs/missing.json",
        pointer: "/guarded",
        ownerPath: "src/owned.txt",
      }));
      r833Put(root, "src/owned.txt", "owned\n");
      const base = r833Commit(root, "base");
      const head = r833Commit(root, "head", true);

      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
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
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833Requirement({
        documentPath: "docs/a.json",
        pointer: "/missing",
        ownerPath: "docs/a.json",
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 } }) + "\n");
      const base = r833Commit(root, "base");
      const head = r833Commit(root, "head", true);

      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      assert.equal(report.ok, false, "missing document fragment must fail closed");
      assert.ok(
        report.diagnostics.some(item => item.code === "document_ref_missing_fragment"),
        JSON.stringify(report.diagnostics, null, 2),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const r833NativeRequirement = ({
    id = "R1",
    ownerPaths = [],
    predicate = "documents",
    target = null,
    metric = "git.changed_resources",
    max = 0,
    includeConstraint = true,
  } = {}) => JSON.stringify({
    format: "repo-guard/requirement-v1",
    id,
    normative: "bounded #833 target-kind matrix",
    relations: [
      ...ownerPaths.map(path => ({
        predicates: ["implemented_by"],
        target: { kind: "artifact", path },
      })),
      ...(target ? [{ predicates: [predicate], target }] : []),
    ],
    ...(includeConstraint ? {
      constraints: [{
        id: "doc-scope",
        scope: { relations: [predicate] },
        metric: { key: metric, max },
      }],
    } : {}),
  }, null, 2) + "\n";

  test("#833 F4 valid unchanged DocumentRef is NOT_APPLICABLE", () => {
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833Requirement({
        documentPath: "docs/a.json", pointer: "/guarded", ownerPath: "docs/a.json", max: 0,
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 }, outside: 1 }) + "\n");
      const base = r833Commit(root, "base");
      const head = r833Commit(root, "head", true);
      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      const scoped = r833Constraint(report);
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2));
      assert.equal(scoped.verdict, "NOT_APPLICABLE");
      assert.deepEqual(scoped.scope, ["docs/a.json"]);
      assert.deepEqual(scoped.touched, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#833 F5 changed DocumentRef under changed_resources limit passes", () => {
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833Requirement({
        documentPath: "docs/a.json", pointer: "/guarded", ownerPath: "docs/a.json", max: 1,
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 } }) + "\n");
      const base = r833Commit(root, "base");
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 2 } }) + "\n");
      const head = r833Commit(root, "head");
      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      const scoped = r833Constraint(report);
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2));
      assert.equal(scoped.verdict, "PASS");
      assert.equal(scoped.observed, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#833 F6 changed DocumentRef over changed_resources limit fails", () => {
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833Requirement({
        documentPath: "docs/a.json", pointer: "/guarded", ownerPath: "docs/a.json", max: 0,
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 } }) + "\n");
      const base = r833Commit(root, "base");
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 2 } }) + "\n");
      const head = r833Commit(root, "head");
      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      const scoped = r833Constraint(report);
      assert.equal(report.ok, false);
      assert.equal(scoped.verdict, "RED");
      assert.equal(scoped.observed, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#833 F7 DocumentRef changed_lines uses deterministic file-level numstat", () => {
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833Requirement({
        documentPath: "docs/a.json",
        pointer: "/guarded",
        ownerPath: "docs/a.json",
        metric: "git.changed_lines",
        max: 2,
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 }, outside: 1 }) + "\n");
      const base = r833Commit(root, "base");
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 2 }, outside: 1 }) + "\n");
      const head = r833Commit(root, "head");
      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      const scoped = r833Constraint(report);
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2));
      assert.equal(scoped.verdict, "PASS");
      assert.equal(scoped.observed, 2);
      assert.deepEqual(scoped.observationSources, [{ path: "docs/a.json", metric: "changed_lines", value: 2 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#833 F8 file change outside referenced fragment still counts at path level", () => {
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833Requirement({
        documentPath: "docs/a.json", pointer: "/guarded", ownerPath: "docs/a.json", max: 0,
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 }, outside: 1 }) + "\n");
      const base = r833Commit(root, "base");
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 }, outside: 2 }) + "\n");
      const head = r833Commit(root, "head");
      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      const scoped = r833Constraint(report);
      assert.equal(report.ok, false);
      assert.equal(scoped.verdict, "RED");
      assert.equal(scoped.observed, 1);
      assert.deepEqual(scoped.scope, ["docs/a.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#833 F9 BASE DocumentRef obligation cannot be erased by HEAD relation or Constraint removal", () => {
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
        ownerPaths: ["docs/a.json"],
        target: { kind: "document", path: "docs/a.json", pointer: "/guarded" },
        max: 0,
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 } }) + "\n");
      const base = r833Commit(root, "base");
      r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
        ownerPaths: ["docs/a.json"],
        includeConstraint: false,
      }));
      r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 2 } }) + "\n");
      const head = r833Commit(root, "head");
      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      const scoped = r833Constraint(report);
      assert.equal(report.ok, false);
      assert.equal(scoped.verdict, "RED");
      assert.equal(scoped.observed, 1);
      assert.deepEqual(scoped.scope, ["docs/a.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#833 F10 document delete and rename retain transition obligation", () => {
    {
      const root = r833Init();
      try {
        r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
          ownerPaths: ["docs/a.json", "src/owned.txt"],
          target: { kind: "document", path: "docs/a.json", pointer: "/guarded" },
          max: 0,
        }));
        r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 } }) + "\n");
        r833Put(root, "src/owned.txt", "owned\n");
        const base = r833Commit(root, "base");
        r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
          ownerPaths: ["src/owned.txt"],
          includeConstraint: false,
        }));
        unlinkSync(join(root, "docs/a.json"));
        const head = r833Commit(root, "head");
        const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
        const scoped = r833Constraint(report);
        assert.equal(report.ok, false);
        assert.equal(scoped.verdict, "RED");
        assert.equal(scoped.observed, 1);
        assert.deepEqual(scoped.scope, ["docs/a.json"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    {
      const root = r833Init();
      try {
        r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
          ownerPaths: ["docs/a.json"],
          target: { kind: "document", path: "docs/a.json", pointer: "/guarded" },
          max: 0,
        }));
        r833Put(root, "docs/a.json", JSON.stringify({ guarded: { value: 1 } }) + "\n");
        const base = r833Commit(root, "base");
        r833Git(root, "mv", "docs/a.json", "docs/b.json");
        r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
          ownerPaths: ["docs/b.json"],
          target: { kind: "document", path: "docs/b.json", pointer: "/guarded" },
          max: 0,
        }));
        const head = r833Commit(root, "head");
        const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
        const scoped = r833Constraint(report);
        assert.equal(report.ok, false);
        assert.equal(scoped.verdict, "RED");
        assert.equal(scoped.observed, 1);
        assert.deepEqual(scoped.scope, ["docs/a.json", "docs/b.json"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("#833 F11 accepted unsupported Constraint targets fail closed instead of disappearing", () => {
    {
      const root = r833Init();
      try {
        r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
          ownerPaths: ["src/owned.txt"],
          target: {
            kind: "external_document",
            repository: "other/repository",
            revision: "a".repeat(40),
            path: "docs/ext.json",
            pointer: "/guarded",
          },
          max: 0,
        }));
        r833Put(root, "src/owned.txt", "owned\n");
        const base = r833Commit(root, "base");
        const head = r833Commit(root, "head", true);
        const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
        assert.equal(report.ok, false);
        assert.ok(report.diagnostics.some(item =>
          item.code === "j3" &&
          item.subject.includes("I7:unsupported_scope_target:R1:") &&
          item.subject.endsWith(":external_document")
        ), JSON.stringify(report.diagnostics, null, 2));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    {
      const root = r833Init();
      try {
        r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
          ownerPaths: ["src/owned.txt"],
          predicate: "constrains",
          target: { kind: "requirement", id: "R2" },
          max: 0,
        }));
        r833Put(root, "requirements/r2.rg.json", r833NativeRequirement({
          id: "R2",
          includeConstraint: false,
        }));
        r833Put(root, "src/owned.txt", "owned\n");
        const base = r833Commit(root, "base");
        const head = r833Commit(root, "head", true);
        const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
        assert.equal(report.ok, false);
        assert.ok(report.diagnostics.some(item =>
          item.code === "j3" &&
          item.subject.includes("I7:unsupported_scope_target:R1:") &&
          item.subject.endsWith(":requirement")
        ), JSON.stringify(report.diagnostics, null, 2));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("#833 F12 existing ArtifactRef scoped-change behavior is unchanged", () => {
    const root = r833Init();
    try {
      r833Put(root, "requirements/r1.rg.json", r833NativeRequirement({
        ownerPaths: ["src/a.txt"],
        predicate: "implemented_by",
        max: 0,
      }));
      r833Put(root, "src/a.txt", "before\n");
      const base = r833Commit(root, "base");
      r833Put(root, "src/a.txt", "after\n");
      const head = r833Commit(root, "head");
      const report = evaluateLocalCompiler({ root, repository: r833Repository, base, head });
      const scoped = r833Constraint(report);
      assert.equal(report.ok, false);
      assert.equal(scoped.verdict, "RED");
      assert.equal(scoped.observed, 1);
      assert.deepEqual(scoped.scope, ["src/a.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  console.log("#833 DocumentRef regression matrix: PASS");
}


{
  const b1Requirement = ({ id, relations, constraint }) => JSON.stringify({
    format: "repo-guard/requirement-v1",
    id,
    normative: "#833 B1 causal applicability isolation",
    relations,
    ...(constraint ? { constraints: [constraint] } : {}),
  }, null, 2) + "\n";

  const b1Relation = (predicate, target) => ({ predicates: [predicate], target });

  test("#833 B1 blocked-head reproduction: DocumentRef pointer replace must not activate another path owner", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-833-b1-"));
    const g = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const putFile = (path, value) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), value);
    };
    const save = (message) => {
      g("add", "-A");
      g("-c", "user.name=#833 B1", "-c", "user.email=833-b1@example.invalid", "commit", "-qm", message);
      return g("rev-parse", "HEAD");
    };
    const a = b1Requirement({
      id: "A",
      relations: [
        b1Relation("implemented_by", { kind: "artifact", path: "docs/a.json" }),
        b1Relation("constrains", { kind: "artifact", path: "src/b.txt" }),
      ],
      constraint: {
        id: "guard",
        activation: "requirement_cause",
        scope: { relations: ["constrains"] },
        metric: { key: "git.changed_resources", max: 0 },
      },
    });
    const b = (pointer) => b1Requirement({
      id: "B",
      relations: [
        b1Relation("implemented_by", { kind: "artifact", path: "src/b.txt" }),
        b1Relation("documents", { kind: "document", path: "docs/a.json", pointer }),
      ],
    });

    try {
      g("init", "-q");
      putFile("requirements/a.rg.json", a);
      putFile("requirements/b.rg.json", b("/one"));
      putFile("docs/a.json", JSON.stringify({ one: { value: 1 }, two: { value: 2 } }) + "\n");
      putFile("src/b.txt", "before\n");
      const base = save("base");

      putFile("requirements/b.rg.json", b("/two"));
      putFile("src/b.txt", "after\n");
      const head = save("head");

      const report = evaluateLocalCompiler({ root, repository: "local/repository", base, head });
      const guard = report.j3.constraints.find(item => item.requirementId === "A" && item.constraintId === "guard");
      assert.ok(guard, JSON.stringify(report, null, 2));

      assert.ok(
        report.j3.deltas.some(delta => delta.kind === "relation_replace" && delta.subject === "B"),
        JSON.stringify(report.j3.deltas, null, 2),
      );
      assert.deepEqual(report.j3.affectedRequirements, ["B"]);
      assert.equal(guard.directApplicable, false);
      assert.equal(guard.verdict, "NOT_APPLICABLE");
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}


{
  const causalRef = (predicate, target) => ({ predicates: [predicate], target });
  const causalRequirement = ({ id, relations, guard = false }) => JSON.stringify({
    format: "repo-guard/requirement-v1",
    id,
    normative: "#833 B1 targetPath causal isolation matrix",
    relations,
    ...(guard ? {
      constraints: [{
        id: "guard",
        activation: "requirement_cause",
        scope: { relations: ["constrains"] },
        metric: { key: "git.changed_resources", max: 0 },
      }],
    } : {}),
  }, null, 2) + "\n";

  function runDocumentRelationMutation(mode) {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-833-b1-matrix-"));
    const g = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const putFile = (path, value) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), value);
    };
    const save = (message) => {
      g("add", "-A");
      g("-c", "user.name=#833 B1", "-c", "user.email=833-b1@example.invalid", "commit", "-qm", message);
      return g("rev-parse", "HEAD");
    };
    const a = causalRequirement({
      id: "A",
      guard: true,
      relations: [
        causalRef("implemented_by", { kind: "artifact", path: "docs/a.json" }),
        causalRef("constrains", { kind: "artifact", path: "src/b.txt" }),
      ],
    });
    const b = (pointer) => causalRequirement({
      id: "B",
      relations: [
        causalRef("implemented_by", { kind: "artifact", path: "src/b.txt" }),
        ...(pointer === null ? [] : [
          causalRef("documents", { kind: "document", path: "docs/a.json", pointer }),
        ]),
      ],
    });
    try {
      g("init", "-q");
      putFile("requirements/a.rg.json", a);
      putFile("requirements/b.rg.json", b(mode === "add" ? null : "/one"));
      putFile("docs/a.json", JSON.stringify({ one: { value: 1 }, two: { value: 2 } }) + "\n");
      putFile("src/b.txt", "before\n");
      const base = save("base");

      putFile("requirements/b.rg.json", b(mode === "remove" ? null : mode === "replace" ? "/two" : "/one"));
      putFile("src/b.txt", "after\n");
      const head = save("head");

      const report = evaluateLocalCompiler({ root, repository: "local/repository", base, head });
      const guard = report.j3.constraints.find(item => item.requirementId === "A" && item.constraintId === "guard");
      assert.ok(guard, JSON.stringify(report, null, 2));
      return { report, guard };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  for (const [mode, deltaKind] of [
    ["add", "relation_add"],
    ["remove", "relation_remove"],
    ["replace", "relation_replace"],
  ]) {
    test(`#833 B1 DocumentRef relation ${mode} is causally isolated from path owner`, () => {
      const { report, guard } = runDocumentRelationMutation(mode);
      assert.ok(
        report.j3.deltas.some(delta => delta.kind === deltaKind && delta.subject === "B"),
        JSON.stringify(report.j3.deltas, null, 2),
      );
      assert.deepEqual(report.j3.affectedRequirements, ["B"]);
      assert.equal(guard.directApplicable, false);
      assert.equal(guard.verdict, "NOT_APPLICABLE");
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2));
    });
  }

  test("#833 B1 ArtifactRef targetPath causal semantics remain unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-833-b1-artifact-control-"));
    const g = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const putFile = (path, value) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), value);
    };
    const save = (message) => {
      g("add", "-A");
      g("-c", "user.name=#833 B1", "-c", "user.email=833-b1@example.invalid", "commit", "-qm", message);
      return g("rev-parse", "HEAD");
    };
    const a = causalRequirement({
      id: "A",
      guard: true,
      relations: [
        causalRef("implemented_by", { kind: "artifact", path: "docs/a.json" }),
        causalRef("constrains", { kind: "artifact", path: "src/b.txt" }),
      ],
    });
    const b = (withArtifact) => causalRequirement({
      id: "B",
      relations: [
        causalRef("implemented_by", { kind: "artifact", path: "src/b.txt" }),
        ...(withArtifact ? [
          causalRef("documents", { kind: "artifact", path: "docs/a.json" }),
        ] : []),
      ],
    });
    try {
      g("init", "-q");
      putFile("requirements/a.rg.json", a);
      putFile("requirements/b.rg.json", b(false));
      putFile("docs/a.json", JSON.stringify({ one: 1 }) + "\n");
      putFile("src/b.txt", "before\n");
      const base = save("base");
      putFile("requirements/b.rg.json", b(true));
      putFile("src/b.txt", "after\n");
      const head = save("head");

      const report = evaluateLocalCompiler({ root, repository: "local/repository", base, head });
      const guard = report.j3.constraints.find(item => item.requirementId === "A" && item.constraintId === "guard");
      assert.ok(guard, JSON.stringify(report, null, 2));
      assert.ok(report.j3.deltas.some(delta => delta.kind === "relation_add" && delta.subject === "B"));
      assert.deepEqual(report.j3.affectedRequirements, ["A", "B"]);
      assert.equal(guard.directApplicable, true);
      assert.equal(guard.verdict, "RED");
      assert.equal(report.ok, false);
      assert.ok(
        report.diagnostics.some(item => item.code === "j3" && item.subject === "I7:constraint_exceeded:A:guard:1>0"),
        JSON.stringify(report.diagnostics, null, 2),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#833 B1 DocumentRef validation does not create J1 ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-833-b1-j1-control-"));
    const g = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const putFile = (path, value) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), value);
    };
    const save = (message) => {
      g("add", "-A");
      g("-c", "user.name=#833 B1", "-c", "user.email=833-b1@example.invalid", "commit", "-qm", message);
      return g("rev-parse", "HEAD");
    };
    const a = causalRequirement({
      id: "A",
      relations: [causalRef("implemented_by", { kind: "artifact", path: "docs/a.json" })],
    });
    const b = causalRequirement({
      id: "B",
      relations: [
        causalRef("implemented_by", { kind: "artifact", path: "src/b.txt" }),
        causalRef("documents", { kind: "document", path: "docs/a.json", pointer: "/one" }),
      ],
    });
    try {
      g("init", "-q");
      putFile("requirements/a.rg.json", a);
      putFile("requirements/b.rg.json", b);
      putFile("docs/a.json", JSON.stringify({ one: { value: 1 } }) + "\n");
      putFile("src/b.txt", "stable\n");
      const base = save("base");
      putFile("docs/a.json", JSON.stringify({ one: { value: 2 } }) + "\n");
      const head = save("head");

      const report = evaluateLocalCompiler({ root, repository: "local/repository", base, head });
      assert.deepEqual(report.j3.affectedRequirements, ["A"]);
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  console.log("#833 B1 causal applicability regression matrix: PASS");
}


{
  const repo836 = "fixture/836";
  const put836 = (root, path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const git836 = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit836 = (root, message) => {
    git836(root, "add", "-A");
    git836(root, "-c", "user.name=#836", "-c", "user.email=836@example.invalid", "commit", "-qm", message);
    return git836(root, "rev-parse", "HEAD");
  };

  test("#836 D1 metric RED must dominate valid domain delegation", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-836-d1-"));
    try {
      git836(root, "init", "-q");
      const requirement = JSON.stringify({
        format: "repo-guard/requirement-v1",
        id: "R1",
        normative: "#836 D1 metric/evidence conjunction",
        relations: [{
          predicates: ["implemented_by"],
          target: { kind: "artifact", path: "src/a.txt" },
        }],
        constraints: [{
          id: "guard",
          activation: "scoped_change",
          scope: { relations: ["implemented_by"] },
          metric: { key: "git.changed_resources", max: 0 },
          evidence: { class: "domain", key: "domain:test" },
        }],
      }, null, 2) + "\n";
      put836(root, "requirements/r1.rg.json", requirement);
      put836(root, "src/a.txt", "before\n");
      const base = commit836(root, "base");
      put836(root, "src/a.txt", "after\n");
      const head = commit836(root, "head");
      const report = evaluateLocalCompiler({ root, repository: repo836, base, head });
      const guard = report.j3.constraints.find(item => item.requirementId === "R1" && item.constraintId === "guard");
      assert.ok(guard, JSON.stringify(report, null, 2));
      assert.equal(report.ok, false, JSON.stringify(report, null, 2));
      assert.ok(
        report.diagnostics.some(item => item.code === "j3" && item.subject === "I7:constraint_exceeded:R1:guard:1>0"),
        JSON.stringify(report.diagnostics, null, 2),
      );
      assert.equal(
        guard.verdict,
        "RED",
        JSON.stringify({ observed: guard.observed, verdict: guard.verdict, requiredEvidence: guard.requiredEvidence }, null, 2),
      );
      assert.equal(guard.evidenceStatus, "DELEGATED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#836 D2 native and runtime Constraint ID grammar must agree", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-836-d2-"));
    const raw = JSON.stringify({
      format: "repo-guard/requirement-v1",
      id: "R1",
      normative: "#836 D2 identifier grammar",
      relations: [{
        predicates: ["implemented_by"],
        target: { kind: "artifact", path: "src/a.txt" },
      }],
      constraints: [{
        id: "guard:strict",
        scope: { relations: ["implemented_by"] },
        metric: { key: "git.changed_resources", max: 0 },
      }],
    }, null, 2) + "\n";
    try {
      git836(root, "init", "-q");
      put836(root, "requirements/r1.rg.json", raw);
      put836(root, "src/a.txt", "stable\n");
      const revision = commit836(root, "single");

      const native = loadNativeRequirements({
        repository: repo836,
        revision,
        paths: ["requirements/r1.rg.json"],
        readFile: (sha, path) =>
          sha === revision && path === "requirements/r1.rg.json" ? Buffer.from(raw, "utf8") : null,
      });
      const lowered = lowerNativeRequirements(native);
      const report = evaluateLocalCompiler({ root, repository: repo836, base: revision, head: revision });
      const runtimeRejected = report.diagnostics.some(item =>
        item.code === "j3" && item.subject.includes("I7:invalid_constraint:"),
      );

      assert.equal(
        native.ok,
        false,
        JSON.stringify({
          nativeOk: native.ok,
          nativeErrors: native.errors,
          loweredOk: lowered.requirements.ok,
          runtimeRejected,
          runtimeDiagnostics: report.diagnostics,
        }, null, 2),
      );
      assert.ok(native.errors.some(error => error.code === "invalid_constraint"));
      assert.equal(runtimeRejected, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });



  test("#836 F12 Constraint ID grammar is consistent across native and compiled contracts", () => {
    const revision = "a".repeat(40);
    const valid = ["A", "guard", "guard-1", "guard_1", "guard.1", "A0"];
    const invalid = [":guard", "guard:", "guard:strict", "1guard", "guard space", "guard/", ""];
    const rawFor = (id) => JSON.stringify({
      format: "repo-guard/requirement-v1",
      id: "R1",
      normative: "#836 id grammar",
      relations: [{
        predicates: ["implemented_by"],
        target: { kind: "artifact", path: "src/a.txt" },
      }],
      constraints: [{
        id,
        scope: { relations: ["implemented_by"] },
        metric: { key: "git.changed_resources", max: 0 },
      }],
    });

    for (const id of valid) {
      const raw = rawFor(id);
      const native = loadNativeRequirements({
        repository: repo836,
        revision,
        paths: ["requirements/r1.rg.json"],
        readFile: (_sha, path) => path === "requirements/r1.rg.json" ? raw : null,
      });
      assert.equal(native.ok, true, id + ": " + JSON.stringify(native.errors));
      const lowered = lowerNativeRequirements(native);
      assert.equal(lowered.requirements.ok, true, id + ": " + JSON.stringify(lowered.requirements.errors));
      const compiled = lowered.requirements.index.R1.value.constraints[0];
      const checked = validateCompiledConstraint(compiled);
      assert.equal(checked.ok, true, id + ": " + JSON.stringify(checked));
    }
    for (const id of invalid) {
      const raw = rawFor(id);
      const native = loadNativeRequirements({
        repository: repo836,
        revision,
        paths: ["requirements/r1.rg.json"],
        readFile: (_sha, path) => path === "requirements/r1.rg.json" ? raw : null,
      });
      assert.equal(native.ok, false, "native unexpectedly accepted " + JSON.stringify(id));
      assert.ok(native.errors.some(error => error.code === "invalid_constraint"), JSON.stringify(native.errors));
    }
  });

  test("#836 F13 native lowering and compiled Constraint validator remain differential-compatible", () => {
    const revision = "b".repeat(40);
    const samples = [
      { activation: "scoped_change", metric: { key: "git.changed_resources", max: 2 } },
      { activation: "requirement_cause", metric: { key: "git.changed_lines", max: 10 } },
      { activation: "scoped_change", evidence: { class: "domain", key: "domain:test" } },
      { activation: "scoped_change", evidence: { class: "execution", key: "execution:test", verifier: { kind: "artifact", path: "tests/t.mjs" } } },
      { activation: "scoped_change", metric: { key: "git.changed_resources", max: 2 }, evidence: { class: "domain", key: "domain:test" } },
      { activation: "requirement_cause", metric: { key: "git.changed_lines", max: 10 }, evidence: { class: "execution", key: "execution:test", verifier: { kind: "artifact", path: "tests/t.mjs" } } },
    ];
    for (const includeGenerated of [false, true]) {
      for (const sample of samples) {
        const raw = JSON.stringify({
          format: "repo-guard/requirement-v1",
          id: "R1",
          normative: "#836 compiled differential",
          relations: [
            { predicates: ["implemented_by"], target: { kind: "artifact", path: "src/a.txt" } },
            { predicates: ["verified_by"], target: { kind: "artifact", path: "tests/t.mjs" } },
          ],
          constraints: [{
            id: "guard",
            activation: sample.activation,
            scope: { relations: ["implemented_by"], include_generated: includeGenerated },
            ...(sample.metric ? { metric: sample.metric } : {}),
            ...(sample.evidence ? { evidence: sample.evidence } : {}),
          }],
        });
        const native = loadNativeRequirements({
          repository: repo836,
          revision,
          paths: ["requirements/r1.rg.json"],
          readFile: (_sha, path) => path === "requirements/r1.rg.json" ? raw : null,
        });
        assert.equal(native.ok, true, JSON.stringify(native.errors));
        const lowered = lowerNativeRequirements(native);
        assert.equal(lowered.requirements.ok, true, JSON.stringify(lowered.requirements.errors));
        const compiled = lowered.requirements.index.R1.value.constraints[0];
        const checked = validateCompiledConstraint(compiled);
        assert.equal(checked.ok, true, JSON.stringify(checked));
      }
    }

    for (const badMetric of [
      { key: "git.unknown", max: 1 },
      { key: "git.changed_resources", max: 0.5 },
    ]) {
      const raw = JSON.stringify({
        format: "repo-guard/requirement-v1",
        id: "R1",
        normative: "#836 invalid metric",
        relations: [{ predicates: ["implemented_by"], target: { kind: "artifact", path: "src/a.txt" } }],
        constraints: [{ id: "guard", scope: { relations: ["implemented_by"] }, metric: badMetric }],
      });
      const native = loadNativeRequirements({
        repository: repo836,
        revision,
        paths: ["requirements/r1.rg.json"],
        readFile: (_sha, path) => path === "requirements/r1.rg.json" ? raw : null,
      });
      assert.equal(native.ok, false, JSON.stringify(badMetric));
      assert.ok(native.errors.some(error => error.code === "invalid_constraint"), JSON.stringify(native.errors));
    }

    for (const malformed of [
      { id: "guard:strict", relations: ["implemented_by"], metric: "changed_resources", max: 0 },
      { id: "guard", relations: ["generates"], metric: "changed_resources", max: 0 },
      { id: "guard", relations: ["implemented_by"], metric: "unknown", max: 0 },
      { id: "guard", relations: ["implemented_by"], metric: "changed_resources", max: 0.5 },
      { id: "guard", relations: ["implemented_by"], evidence: { kind: "execution", key: "execution:test" } },
    ]) {
      assert.equal(validateCompiledConstraint(malformed).ok, false, JSON.stringify(malformed));
    }
  });

  console.log("#836 D1/D2 and compiled-contract regressions loaded");
}


{
  const cli847 = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
  const git847 = (root, ...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put847 = (root, path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const commit847 = (root, message) => {
    git847(root, "add", "-A");
    git847(root, "-c", "user.name=#847 Fixture", "-c", "user.email=847@example.invalid",
      "commit", "-qm", message);
    return git847(root, "rev-parse", "HEAD");
  };
  const check847 = (root, base, head) => {
    const result = spawnSync(process.execPath, [
      cli847,
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
  };
  const reject847 = (result, label) => {
    assert.equal(result.status, 1, label + " must be rejected before semantic evaluation");
    assert.equal(result.stdout, "", label + " must not emit a semantic report");
  };

  test("#847 public check accepts only literal exact BASE/HEAD commit SHA identities", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-847-"));
    try {
      git847(root, "init", "-q", "--object-format=sha1");
      git847(root, "branch", "-M", "main");

      put847(root, "requirements/core.rg.yaml", `format: repo-guard/requirement-v1
id: CORE
normative: "exact identity fixture"
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "src/a.txt"
`);
      put847(root, "src/a.txt", "base\n");
      const base = commit847(root, "base");

      put847(root, "src/a.txt", "head\n");
      const head = commit847(root, "head");
      git847(root, "tag", "fixture-tag", head);

      const exact = check847(root, base, head);
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
        reject847(check847(root, alias, head), "BASE " + label);
        reject847(check847(root, base, alias), "HEAD " + label);
      }

      const nonexistent = "f".repeat(40);
      assert.notEqual(nonexistent, base);
      assert.notEqual(nonexistent, head);
      reject847(check847(root, nonexistent, head), "nonexistent exact BASE SHA");
      reject847(check847(root, base, nonexistent), "nonexistent exact HEAD SHA");

      const blob = git847(root, "hash-object", "-w", "src/a.txt");
      assert.match(blob, /^[0-9a-f]{40}$/);
      reject847(check847(root, blob, head), "non-commit exact BASE SHA");
      reject847(check847(root, base, blob), "non-commit exact HEAD SHA");

      for (const malformed of ["A".repeat(40), "bad revision", "bad\nrevision"]) {
        reject847(check847(root, malformed, head), "malformed BASE " + JSON.stringify(malformed));
        reject847(check847(root, base, malformed), "malformed HEAD " + JSON.stringify(malformed));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  console.log("#847 literal exact public check identity matrix loaded");
}


{
  const cli850 = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
  const git850 = (root, ...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put850 = (root, path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const commit850 = (root, message) => {
    git850(root, "add", "-A");
    git850(root, "-c", "user.name=#850 Fixture", "-c", "user.email=850@example.invalid",
      "commit", "-qm", message);
    return git850(root, "rev-parse", "HEAD");
  };
  const check850 = (root, base, head) => {
    const callerEnv = { ...process.env, PATH: process.env.PATH };
    delete callerEnv.GIT_NO_REPLACE_OBJECTS;
    assert.equal(
      Object.hasOwn(callerEnv, "GIT_NO_REPLACE_OBJECTS"),
      false,
      "caller environment must not disable replacement refs for the protected invocation",
    );
    const result = spawnSync(process.execPath, [
      cli850,
      "--repo-root", root,
      "check",
      "--base", base,
      "--head", head,
      "--format", "json",
    ], {
      cwd: root,
      encoding: "utf8",
      env: callerEnv,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.stdout, "", result.stderr);
    return { status: result.status, report: JSON.parse(result.stdout) };
  };

  test("#850 exact RepoGuard observation is invariant under Git replacement refs", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-850-"));
    const previousNoReplace = process.env.GIT_NO_REPLACE_OBJECTS;
    delete process.env.GIT_NO_REPLACE_OBJECTS;
    try {
      assert.equal(
        process.env.GIT_NO_REPLACE_OBJECTS,
        undefined,
        "fixture caller environment must leave Git replacement refs enabled",
      );
      git850(root, "init", "-q", "--object-format=sha1");
      git850(root, "branch", "-M", "main");

      const requirementA = `format: repo-guard/requirement-v1
id: CORE
normative: "replacement invariant A"
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "src/a.txt"
`;
      const requirementB = `format: repo-guard/requirement-v1
id: CORE
normative: "replacement invariant B"
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "src/a.txt"
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "src/b.txt"
`;

      put850(root, "requirements/core.rg.yaml", requirementA);
      put850(root, "src/a.txt", "base\n");
      const base = commit850(root, "base");

      put850(root, "src/a.txt", "head-a\n");
      const headA = commit850(root, "head A");

      git850(root, "checkout", "-q", "-b", "replacement", base);
      put850(root, "requirements/core.rg.yaml", requirementB);
      put850(root, "src/b.txt", "replacement-only\n");
      const headB = commit850(root, "head B");

      git850(root, "checkout", "-q", "--detach", headA);

      const clean = check850(root, base, headA);
      assert.equal(clean.status, 0, JSON.stringify(clean.report.diagnostics));
      const cleanEntries = listTrackedEntriesAtRef(headA, root);
      const cleanRequirement = readFileBytesAtRef(headA, "requirements/core.rg.yaml", root);
      assert.ok(cleanRequirement);

      git850(root, "replace", headA, headB);
      assert.equal(git850(root, "rev-parse", "refs/replace/" + headA), headB);
      assert.equal(
        git850(root, "show", headA + ":requirements/core.rg.yaml"),
        requirementB.trim(),
        "fixture must prove ordinary Git is honoring the hostile replacement ref",
      );

      assert.equal(
        process.env.GIT_NO_REPLACE_OBJECTS,
        undefined,
        "shared Git helper caller environment must not disable replacement refs",
      );
      const replaced = check850(root, base, headA);
      const replacedEntries = listTrackedEntriesAtRef(headA, root);
      const replacedRequirement = readFileBytesAtRef(headA, "requirements/core.rg.yaml", root);
      assert.ok(replacedRequirement);

      assert.deepEqual(
        replaced,
        clean,
        "same literal exact BASE/HEAD must produce identical RepoGuard report under refs/replace",
      );
      assert.deepEqual(
        replacedEntries,
        cleanEntries,
        "tracked tree enumeration for an exact commit must ignore refs/replace",
      );
      assert.deepEqual(
        replacedRequirement,
        cleanRequirement,
        "byte-exact Git reads for an exact commit must ignore refs/replace",
      );
    } finally {
      if (previousNoReplace === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
      else process.env.GIT_NO_REPLACE_OBJECTS = previousNoReplace;
      rmSync(root, { recursive: true, force: true });
    }
  });

  console.log("#850 replacement-ref exact-object invariant matrix loaded");
}


{
  const repository840 = "fixture/840";
  const collectionSchema840 = "repo-guard/resource-collection/v0";
  const relation840 = (predicate, target, extra = {}) => ({ predicates: [predicate], target, ...extra });
  const requirementRef840 = (id) => ({ kind: "requirement", id });
  const artifactRef840 = (path) => ({ kind: "artifact", path });
  const documentRef840 = (path, pointer = "") => ({ kind: "document", path, pointer });
  const generates840 = (from, to) => ({
    source: artifactRef840(from),
    predicates: ["generates"],
    target: artifactRef840(to),
  });
  const requirement840 = ({ id, normative = "characterize " + id, relations = [], constraints = [] }) =>
    JSON.stringify({
      format: "repo-guard/requirement-v1",
      id,
      normative,
      ...(relations.length ? { relations } : {}),
      ...(constraints.length ? { constraints } : {}),
    }, null, 2) + "\n";

  const fixture840 = () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-840-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const put = (path, value) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), value);
    };
    const save = (message) => {
      git("add", "-A");
      git("-c", "user.name=#840 Characterization", "-c", "user.email=840@example.invalid", "commit", "-qm", message);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "--object-format=sha1");
    git("branch", "-M", "main");
    return { root, git, put, save };
  };

  const open840 = (root, revision) => {
    const entries = listTrackedEntriesAtRef(revision, root);
    const trackedPaths = entries.map((entry) => entry.path);
    const tracked = new Set(trackedPaths);
    const readExact = (sha, path) =>
      sha === revision && tracked.has(path) ? readFileBytesAtRef(sha, path, root) : null;
    const paths = trackedPaths.filter((path) => /^requirements\/.*\.rg\.(?:yaml|json)$/.test(path));
    const native = loadNativeRequirements({
      repository: repository840,
      revision,
      paths,
      readFile: readExact,
    });
    assert.equal(native.ok, true, JSON.stringify(native.errors, null, 2));
    const lowered = lowerNativeRequirements(native);
    assert.equal(lowered.requirements.ok, true, JSON.stringify(lowered.requirements.errors, null, 2));
    const structural = native.requirements
      .filter((item) => !item.relations.some((relation) => relation.predicate === "derives_from"))
      .map((item) => item.semantic);
    const j2 = evaluateRootedRequirements({ requirements: lowered.requirements, trustedRoots: structural });
    assert.equal(j2.ok, true, JSON.stringify(j2, null, 2));
    const resolver = createResourceResolver({
      repository: repository840,
      revision,
      requirements: lowered.requirements,
      readers: { [repository840]: readExact },
    });
    const j1 = evaluateTrackedResourceClosure({
      repository: repository840,
      revision,
      requirements: lowered.requirements,
      j2,
      trackedPaths,
      resourceRelations: lowered.resourceRelations,
      resolver,
    });
    assert.equal(j1.ok, true, JSON.stringify(j1, null, 2));
    return {
      revision,
      native,
      lowered,
      requirements: lowered.requirements,
      lifecycle: lowered.lifecycle,
      resourceRelations: lowered.resourceRelations,
      j2,
      j1,
    };
  };

  const transitionState840 = (state) => ({
    revision: state.revision,
    requirements: state.requirements,
    compiledConstraints: state.lowered.compiledConstraints,
    j2: state.j2,
    j1: state.j1,
    resourceRelations: state.resourceRelations,
  });
  const legacyTransitionState840 = (state) => ({
    revision: state.revision,
    requirements: state.requirements,
    j2: state.j2,
    j1: state.j1,
    resourceRelations: state.resourceRelations,
  });
  const transition840 = (baseState, headState, resourceDeltas = []) =>
    evaluateTransitionCauseClosure({
      repository: repository840,
      base: transitionState840(baseState),
      head: transitionState840(headState),
      trustedAuthorityBase: transitionState840(baseState),
      resourceDeltas,
      baseLifecycle: baseState.lifecycle,
      headLifecycle: headState.lifecycle,
    });
  const legacyTransition840 = (baseState, headState, resourceDeltas = []) =>
    evaluateTransitionCauseClosure({
      repository: repository840,
      base: legacyTransitionState840(baseState),
      head: legacyTransitionState840(headState),
      trustedAuthorityBase: legacyTransitionState840(baseState),
      resourceDeltas,
      baseLifecycle: baseState.lifecycle,
      headLifecycle: headState.lifecycle,
    });
  const diffResources840 = (fx, base, head) => resourceDeltasFromParsedDiff(parseNameStatusZ(
    execFileSync("git", [
      "-c", "core.quotepath=false",
      "diff", "--name-status", "-z", "--find-renames", base, head,
    ], { cwd: fx.root, encoding: "utf8" }),
  ));

  test("#840 C1 native structural-root and J2 behavior is characterized through real native sources", () => {
    const fx = fixture840();
    try {
      const docs = [
        ["R0", []],
        ["DEP", [relation840("depends_on", requirementRef840("R0"))]],
        ["CON", [relation840("constrains", requirementRef840("R0"))]],
        ["SUP", [relation840("supersedes", requirementRef840("R0"))]],
        ["REQ", [relation840("requires", artifactRef840("src/req.txt"))]],
        ["IMP", [relation840("implemented_by", artifactRef840("src/imp.txt"))]],
        ["VER", [relation840("verified_by", artifactRef840("tests/verifier.txt"))]],
        ["DOC", [relation840("documents", artifactRef840("docs/doc.md"))]],
        ["AROOT", []],
        ["BROOT", []],
        ["MULTI", [
          relation840("derives_from", requirementRef840("BROOT")),
          relation840("derives_from", requirementRef840("AROOT")),
        ]],
        ["LEAF", [
          relation840("derives_from", requirementRef840("MULTI")),
          relation840("derives_from", requirementRef840("BROOT")),
        ]],
      ];
      const proofResources = {
        DEP: "src/dep-proof.txt",
        MULTI: "src/multi-proof.txt",
        LEAF: "src/leaf-proof.txt",
      };
      const rootProofConstraint = {
        id: "root-proof",
        scope: { relations: ["implemented_by"] },
        metric: { key: "git.changed_resources", max: 0 },
      };
      for (const [id, relations] of docs) {
        const proofPath = proofResources[id];
        fx.put("requirements/" + id + ".rg.json", requirement840({
          id,
          relations: proofPath
            ? [...relations, relation840("implemented_by", artifactRef840(proofPath))]
            : relations,
          constraints: proofPath ? [rootProofConstraint] : [],
        }));
      }
      for (const [path, value] of [
        ["src/req.txt", "required\n"],
        ["src/imp.txt", "implementation\n"],
        ["tests/verifier.txt", "verification\n"],
        ["docs/doc.md", "documentation\n"],
        ["src/dep-proof.txt", "DEP proof resource\n"],
        ["src/multi-proof.txt", "MULTI proof resource\n"],
        ["src/leaf-proof.txt", "LEAF proof resource\n"],
      ]) fx.put(path, value);

      const productionRootProof = (report, id) => {
        const constraint = report.j3.constraints.find((item) =>
          item.requirementId === id && item.constraintId === "root-proof");
        assert.ok(constraint, id + ": missing production Constraint explanation");
        return constraint.rootedProof;
      };
      const assertProductionRootProofs = (report) => {
        assert.deepEqual(productionRootProof(report, "MULTI"), ["AROOT", "MULTI"]);
        assert.deepEqual(productionRootProof(report, "LEAF"), ["BROOT", "LEAF"]);
        assert.deepEqual(productionRootProof(report, "DEP"), ["DEP"]);
      };

      const base = fx.save("C1 native roots");
      const report = evaluateLocalCompiler({ root: fx.root, repository: repository840, base, head: base });
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2));
      assert.equal(report.j2.rooted, docs.length);
      assertProductionRootProofs(report);

      const state = open840(fx.root, base);
      assert.deepEqual(state.j2.rooted, [
        "AROOT", "BROOT", "CON", "DEP", "DOC", "IMP", "LEAF", "MULTI", "R0", "REQ", "SUP", "VER",
      ]);
      assert.deepEqual(state.j2.unrooted, []);
      assert.deepEqual(state.j2.errors, []);
      for (const id of ["R0", "DEP", "CON", "SUP", "REQ", "IMP", "VER", "DOC", "AROOT", "BROOT"])
        assert.deepEqual(state.j2.explanations[id], [id], id);
      assert.deepEqual(state.j2.explanations.MULTI, ["AROOT", "MULTI"]);
      assert.deepEqual(state.j2.explanations.LEAF, ["BROOT", "LEAF"]);

      fx.put("requirements/DEP.rg.json", requirement840({
        id: "DEP",
        relations: [
          relation840("derives_from", requirementRef840("R0")),
          relation840("implemented_by", artifactRef840("src/dep-proof.txt")),
        ],
        constraints: [rootProofConstraint],
      }));
      const changed = fx.save("C1 negative control derives_from");
      const changedReport = evaluateLocalCompiler({
        root: fx.root,
        repository: repository840,
        base: changed,
        head: changed,
      });
      assert.equal(changedReport.ok, true, JSON.stringify(changedReport.diagnostics, null, 2));
      assert.deepEqual(productionRootProof(changedReport, "DEP"), ["R0", "DEP"]);

      const changedState = open840(fx.root, changed);
      assert.deepEqual(changedState.j2.explanations.DEP, ["R0", "DEP"]);
      assert.notDeepEqual(changedState.j2.explanations.DEP, ["DEP"]);

    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("#840 Slice 1 typed J2 ignores non-bearing native Requirement predicates exactly like legacy J2", () => {
    const fx = fixture840();
    try {
      for (const [id, relations] of [
        ["ROOT", []],
        ["DEP", [relation840("depends_on", requirementRef840("ROOT"))]],
        ["CON", [relation840("constrains", requirementRef840("ROOT"))]],
        ["SUP", [relation840("supersedes", requirementRef840("ROOT"))]],
      ]) {
        fx.put("requirements/" + id + ".rg.json", requirement840({ id, relations }));
      }

      const revision = fx.save("Slice 1 typed non-bearing predicate parity");
      const trackedPaths = listTrackedEntriesAtRef(revision, fx.root).map((entry) => entry.path);
      const tracked = new Set(trackedPaths);
      const requirementPaths = trackedPaths.filter((path) => /^requirements\/.*\.rg\.(?:yaml|json)$/.test(path));
      const native = loadNativeRequirements({
        repository: repository840,
        revision,
        paths: requirementPaths,
        readFile: (sha, path) =>
          sha === revision && tracked.has(path) ? readFileBytesAtRef(sha, path, fx.root) : null,
      });
      assert.equal(native.ok, true, JSON.stringify(native.errors, null, 2));

      const lowered = lowerNativeRequirements(native);
      assert.equal(lowered.requirements.ok, true, JSON.stringify(lowered.requirements.errors, null, 2));

      const root = native.index.ROOT.semantic;
      const legacy = evaluateRootedRequirements({
        requirements: lowered.requirements,
        trustedRoots: [root],
      });
      const typed = evaluateRootedRequirements({
        requirements: lowered.requirements,
        trustedRoots: [root],
        nativeRequirements: native.requirements,
      });

      assert.deepEqual(typed, legacy);
      assert.deepEqual(typed, {
        ok: false,
        rooted: ["ROOT"],
        unrooted: ["CON", "DEP", "SUP"],
        errors: [],
        explanations: {
          ROOT: ["ROOT"],
        },
      });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("#840 C2 native J1 target-kind, collection and generates ownership matrix is characterized", () => {
    const fx = fixture840();
    try {
      const rootRelations = [
        relation840("requires", artifactRef840("src/requires.txt")),
        relation840("implemented_by", artifactRef840("src/impl.txt")),
        relation840("verified_by", artifactRef840("tests/verifier.mjs")),
        relation840("documents", artifactRef840("docs/owned.md")),
        relation840("requires", artifactRef840("inventory/resources.json"), { collection: true }),
        relation840("implemented_by", artifactRef840("src/source.txt")),
        generates840("src/source.txt", "gen/out.txt"),
        relation840("constrains", artifactRef840("src/shared.txt")),
      ];
      fx.put("requirements/ROOT.rg.json", requirement840({ id: "ROOT", relations: rootRelations }));
      fx.put("requirements/OWNER.rg.json", requirement840({
        id: "OWNER",
        relations: [relation840("implemented_by", artifactRef840("src/shared.txt"))],
      }));
      fx.put("requirements/DOC.rg.json", requirement840({
        id: "DOC",
        relations: [relation840("documents", documentRef840("docs/data.json", "/section"))],
      }));
      fx.put("requirements/DOCOWNER.rg.json", requirement840({
        id: "DOCOWNER",
        relations: [relation840("implemented_by", artifactRef840("docs/data.json"))],
      }));
      for (const [path, value] of [
        ["src/requires.txt", "requires\n"],
        ["src/impl.txt", "implementation\n"],
        ["tests/verifier.mjs", "export {};\n"],
        ["docs/owned.md", "owned docs\n"],
        ["src/source.txt", "source\n"],
        ["gen/out.txt", "generated\n"],
        ["src/shared.txt", "shared\n"],
        ["docs/data.json", JSON.stringify({ section: { value: 1 } }) + "\n"],
        ["inventory/resources.json", JSON.stringify({
          schema: collectionSchema840,
          members: ["tests/member.txt"],
        }, null, 2) + "\n"],
        ["tests/member.txt", "member\n"],
      ]) fx.put(path, value);

      const revision = fx.save("C2 ownership matrix");
      const state = open840(fx.root, revision);
      for (const path of ["src/requires.txt", "src/impl.txt", "tests/verifier.mjs", "docs/owned.md", "src/source.txt"])
        assert.deepEqual(state.j1.owners[path], ["ROOT"], path);
      assert.deepEqual(state.j1.explanations["src/requires.txt"], ["ROOT", "requires:src/requires.txt"]);
      assert.deepEqual(state.j1.explanations["src/impl.txt"], ["ROOT", "implemented_by:src/impl.txt"]);
      assert.deepEqual(state.j1.explanations["tests/verifier.mjs"], ["ROOT", "verified_by:tests/verifier.mjs"]);
      assert.deepEqual(state.j1.explanations["docs/owned.md"], ["ROOT", "documents:docs/owned.md"]);
      assert.deepEqual(state.j1.owners["src/shared.txt"], ["OWNER"]);
      assert.deepEqual(state.j1.owners["docs/data.json"], ["DOCOWNER"]);
      assert.deepEqual(state.j1.owners["inventory/resources.json"], ["ROOT"]);
      assert.deepEqual(state.j1.owners["tests/member.txt"], ["ROOT"]);
      assert.deepEqual(state.j1.owners["gen/out.txt"], ["ROOT"]);

      assert.deepEqual(state.j1.explanations["gen/out.txt"], [
        "ROOT",
        "implemented_by:src/source.txt",
        "generates:gen/out.txt",
      ]);
      assert.deepEqual(state.j1.explanations["tests/member.txt"], [
        "ROOT",
        "requires:inventory/resources.json",
        "collection:" + collectionSchema840,
        "member:tests/member.txt",
      ]);
      assert.deepEqual(state.j1.collections, [{
        owner: "ROOT",
        predicate: "requires",
        manifest: "inventory/resources.json",
        schema: collectionSchema840,
        members: ["tests/member.txt"],
      }]);
      assert.deepEqual(state.resourceRelations, [{
        from: "src/source.txt",
        kind: "generates",
        to: "gen/out.txt",
      }]);
      const loweredRootRelations = state.requirements.index.ROOT.value.relations;
      assert.equal(Object.values(loweredRootRelations).some((item) => item.predicate === "generates"), false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("#840 Slice 2 typed J1 ownership is exact legacy parity without authority broadening", () => {
    const fx = fixture840();
    try {
      fx.put("requirements/ROOT.rg.json", requirement840({
        id: "ROOT",
        relations: [
          relation840("requires", artifactRef840("src/requires.txt")),
          relation840("implemented_by", artifactRef840("src/impl.txt")),
          relation840("verified_by", artifactRef840("tests/verifier.mjs")),
          relation840("documents", artifactRef840("docs/owned.md")),
          relation840("requires", artifactRef840("inventory/resources.json"), { collection: true }),
          relation840("implemented_by", artifactRef840("src/source.txt")),
          generates840("src/source.txt", "gen/out.txt"),
          relation840("documents", documentRef840("docs/data.json", "/section")),
          relation840("constrains", artifactRef840("src/constrained.txt")),
          relation840("depends_on", requirementRef840("TARGET")),
          relation840("supersedes", requirementRef840("TARGET")),
        ],
      }));
      fx.put("requirements/TARGET.rg.json", requirement840({ id: "TARGET" }));
      fx.put("requirements/CHILD.rg.json", requirement840({
        id: "CHILD",
        relations: [relation840("derives_from", requirementRef840("ROOT"))],
      }));

      for (const [path, value] of [
        ["src/requires.txt", "requires\n"],
        ["src/impl.txt", "implementation\n"],
        ["tests/verifier.mjs", "export {};\n"],
        ["docs/owned.md", "owned documentation\n"],
        ["src/source.txt", "generator source\n"],
        ["gen/out.txt", "generated output\n"],
        ["src/constrained.txt", "valid but not J1-owned\n"],
        ["docs/data.json", JSON.stringify({ section: { value: 1 } }) + "\n"],
        ["inventory/resources.json", JSON.stringify({
          schema: collectionSchema840,
          members: ["tests/member.txt"],
        }, null, 2) + "\n"],
        ["tests/member.txt", "collection member\n"],
      ]) fx.put(path, value);

      const revision = fx.save("Slice 2 typed J1 parity");
      const entries = listTrackedEntriesAtRef(revision, fx.root);
      const trackedPaths = entries.map((entry) => entry.path);
      const tracked = new Set(trackedPaths);
      const readExact = (sha, path) =>
        sha === revision && tracked.has(path) ? readFileBytesAtRef(sha, path, fx.root) : null;
      const requirementPaths = trackedPaths.filter((path) => /^requirements\/.*\.rg\.(?:yaml|json)$/.test(path));
      const native = loadNativeRequirements({
        repository: repository840,
        revision,
        paths: requirementPaths,
        readFile: readExact,
      });
      assert.equal(native.ok, true, JSON.stringify(native.errors, null, 2));

      const lowered = lowerNativeRequirements(native);
      assert.equal(lowered.requirements.ok, true, JSON.stringify(lowered.requirements.errors, null, 2));
      const roots = native.requirements
        .filter((item) => !item.relations.some((relation) => relation.predicate === "derives_from"))
        .map((item) => item.semantic);
      const j2 = evaluateRootedRequirements({
        requirements: lowered.requirements,
        trustedRoots: roots,
        nativeRequirements: native.requirements,
      });
      assert.equal(j2.ok, true, JSON.stringify(j2, null, 2));

      const resolver = createResourceResolver({
        repository: repository840,
        revision,
        requirements: lowered.requirements,
        readers: { [repository840]: readExact },
      });
      const common = {
        repository: repository840,
        revision,
        requirements: lowered.requirements,
        j2,
        trackedPaths,
        resourceRelations: lowered.resourceRelations,
        resolver,
      };
      const legacy = evaluateTrackedResourceClosure(common);
      const typed = evaluateTrackedResourceClosure({
        ...common,
        nativeRequirements: native.requirements,
      });

      assert.deepEqual(typed, legacy);
      assert.equal(typed.ok, false);
      assert.deepEqual(typed.errors, []);
      assert.deepEqual(typed.unjustified, ["docs/data.json", "src/constrained.txt"]);

      assert.deepEqual(typed.owners["src/requires.txt"], ["ROOT"]);
      assert.deepEqual(typed.owners["src/impl.txt"], ["ROOT"]);
      assert.deepEqual(typed.owners["tests/verifier.mjs"], ["ROOT"]);
      assert.deepEqual(typed.owners["docs/owned.md"], ["ROOT"]);

      assert.equal(Object.hasOwn(typed.owners, "docs/data.json"), false);
      assert.equal(Object.hasOwn(typed.owners, "src/constrained.txt"), false);
      assert.equal(Object.hasOwn(typed.owners, "TARGET"), false);

      assert.deepEqual(typed.owners["inventory/resources.json"], ["ROOT"]);
      assert.deepEqual(typed.owners["tests/member.txt"], ["ROOT"]);
      assert.deepEqual(typed.collections, [{
        owner: "ROOT",
        predicate: "requires",
        manifest: "inventory/resources.json",
        schema: collectionSchema840,
        members: ["tests/member.txt"],
      }]);
      assert.deepEqual(typed.explanations["tests/member.txt"], [
        "ROOT",
        "requires:inventory/resources.json",
        "collection:" + collectionSchema840,
        "member:tests/member.txt",
      ]);

      assert.deepEqual(typed.owners["src/source.txt"], ["ROOT"]);
      assert.deepEqual(typed.owners["gen/out.txt"], ["ROOT"]);
      assert.deepEqual(typed.explanations["gen/out.txt"], [
        "ROOT",
        "implemented_by:src/source.txt",
        "generates:gen/out.txt",
      ]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("#840 C3 native J3 relation delta reconstruction and predicate impact are characterized", () => {
    const fx = fixture840();
    try {
      const baseDocs = {
        REPLACE: [relation840("depends_on", requirementRef840("B1"))],
        B1: [],
        C1: [],
        REMOVE: [relation840("constrains", requirementRef840("B2"))],
        B2: [],
        ADD: [],
        B3: [],
        COLL: [relation840("requires", artifactRef840("inventory/empty.resources.json"))],
        GEN: [relation840("implemented_by", artifactRef840("src/source.txt"))],
      };
      for (const [id, relations] of Object.entries(baseDocs))
        fx.put("requirements/" + id + ".rg.json", requirement840({ id, relations }));
      fx.put("src/source.txt", "source\n");
      fx.put("inventory/empty.resources.json", JSON.stringify({
        schema: collectionSchema840,
        members: [],
      }, null, 2) + "\n");
      const base = fx.save("C3 relation base");

      fx.put("requirements/REPLACE.rg.json", requirement840({
        id: "REPLACE",
        relations: [relation840("depends_on", requirementRef840("C1"))],
      }));
      fx.put("requirements/REMOVE.rg.json", requirement840({ id: "REMOVE" }));
      fx.put("requirements/ADD.rg.json", requirement840({
        id: "ADD",
        relations: [relation840("supersedes", requirementRef840("B3"))],
      }));
      fx.put("requirements/COLL.rg.json", requirement840({
        id: "COLL",
        relations: [relation840("requires", artifactRef840("inventory/empty.resources.json"), { collection: true })],
      }));
      fx.put("requirements/GEN.rg.json", requirement840({
        id: "GEN",
        relations: [
          relation840("implemented_by", artifactRef840("src/source.txt")),
          generates840("src/source.txt", "gen/out.txt"),
        ],
      }));
      fx.put("gen/out.txt", "generated\n");
      const head = fx.save("C3 relation head");

      const transition = transition840(open840(fx.root, base), open840(fx.root, head));
      assert.equal(transition.ok, true, JSON.stringify(transition.reasons, null, 2));
      const relationDeltas = transition.deltas.filter((delta) => delta.kind.startsWith("relation_"));
      const addId =
        'relation_add:{"from":"ADD","origin":"requirement","predicate":"supersedes","target":"{\\\"id\\\":\\\"B3\\\",\\\"kind\\\":\\\"requirement\\\"}"}';
      const generatesId =
        'relation_add:{"from":"src/source.txt","origin":"resource","predicate":"generates","target":"{\\\"kind\\\":\\\"artifact\\\",\\\"path\\\":\\\"gen/out.txt\\\"}"}';
      const removeId =
        'relation_remove:{"from":"REMOVE","origin":"requirement","predicate":"constrains","target":"{\\\"id\\\":\\\"B2\\\",\\\"kind\\\":\\\"requirement\\\"}"}';
      const collectionBefore =
        '{"from":"COLL","origin":"requirement","predicate":"requires","target":"{\\\"kind\\\":\\\"artifact\\\",\\\"path\\\":\\\"inventory/empty.resources.json\\\"}"}';
      const collectionAfter =
        '{"collection":true,"from":"COLL","origin":"requirement","predicate":"requires","target":"{\\\"kind\\\":\\\"artifact\\\",\\\"path\\\":\\\"inventory/empty.resources.json\\\"}"}';
      const collectionId = "relation_replace:" + collectionBefore + "->" + collectionAfter;
      const replaceBefore =
        '{"from":"REPLACE","origin":"requirement","predicate":"depends_on","target":"{\\\"id\\\":\\\"B1\\\",\\\"kind\\\":\\\"requirement\\\"}"}';
      const replaceAfter =
        '{"from":"REPLACE","origin":"requirement","predicate":"depends_on","target":"{\\\"id\\\":\\\"C1\\\",\\\"kind\\\":\\\"requirement\\\"}"}';
      const replaceId = "relation_replace:" + replaceBefore + "->" + replaceAfter;
      assert.deepEqual(relationDeltas, [
        { id: addId, kind: "relation_add", subject: "ADD" },
        { id: generatesId, kind: "relation_add", subject: "src/source.txt" },
        { id: removeId, kind: "relation_remove", subject: "REMOVE" },
        { id: collectionId, kind: "relation_replace", subject: "COLL" },
        { id: replaceId, kind: "relation_replace", subject: "REPLACE" },
      ]);
      const relationWhy = transition.explanations.whyChanged.filter((item) => item.kind.startsWith("relation_"));
      assert.deepEqual(relationWhy, [
        {
          id: addId, kind: "relation_add", subject: "ADD",
          affected: ["ADD", "B3"], applicable: ["ADD", "B3"],
          directApplicable: ["ADD", "B3"], reverseImpact: [],
          causalCandidates: ["ADD", "B3"], causes: ["ADD", "B3"],
        },
        {
          id: generatesId, kind: "relation_add", subject: "src/source.txt",
          affected: ["GEN"], applicable: ["GEN"], directApplicable: ["GEN"], reverseImpact: [],
          causalCandidates: ["GEN"], causes: ["GEN"],
        },
        {
          id: removeId, kind: "relation_remove", subject: "REMOVE",
          affected: ["B2", "REMOVE"], applicable: ["B2", "REMOVE"],
          directApplicable: ["B2", "REMOVE"], reverseImpact: [],
          causalCandidates: ["B2", "REMOVE"], causes: ["B2", "REMOVE"],
        },
        {
          id: collectionId, kind: "relation_replace", subject: "COLL",
          affected: ["COLL"], applicable: ["COLL"], directApplicable: ["COLL"], reverseImpact: [],
          causalCandidates: ["COLL"], causes: ["COLL"],
        },
        {
          id: replaceId, kind: "relation_replace", subject: "REPLACE",
          affected: ["B1", "C1", "REPLACE"], applicable: ["B1", "C1", "REPLACE"],
          directApplicable: ["B1", "C1", "REPLACE"], reverseImpact: [],
          causalCandidates: ["B1", "C1", "REPLACE"], causes: ["B1", "C1", "REPLACE"],
        },
      ]);
      assert.deepEqual(transition.affectedRequirements, [
        "ADD", "B1", "B2", "B3", "C1", "COLL", "GEN", "REMOVE", "REPLACE",
      ]);

      // Directional impact negative controls use Requirement semantic mutation, not relation deltas,
      // so direct relation endpoints do not mask reverse-impact semantics.
      fx.git("checkout", "-q", base);
      for (const id of ["DPARENT", "DCHILD", "DEPTARGET", "DEPEND", "CONTARGET", "CONSTRAINER"]) {
        const relations =
          id === "DCHILD" ? [relation840("derives_from", requirementRef840("DPARENT"))] :
          id === "DEPEND" ? [relation840("depends_on", requirementRef840("DEPTARGET"))] :
          id === "CONSTRAINER" ? [relation840("constrains", requirementRef840("CONTARGET"))] :
          [];
        fx.put("requirements/" + id + ".rg.json", requirement840({ id, relations }));
      }
      const impactBase = fx.save("C3 impact base");

      for (const id of ["DPARENT", "DEPTARGET", "CONTARGET"]) {
        const relations =
          id === "DEPTARGET" ? [] :
          id === "CONTARGET" ? [] : [];
        fx.put("requirements/" + id + ".rg.json", requirement840({
          id,
          normative: "changed target " + id,
          relations,
        }));
      }
      const targetHead = fx.save("C3 impact targets");
      const targetImpact = transition840(open840(fx.root, impactBase), open840(fx.root, targetHead));
      const targetWhy = Object.fromEntries(
        targetImpact.explanations.whyChanged
          .filter((item) => item.kind === "requirement_modify")
          .map((item) => [item.subject, item]),
      );
      const expectedRequirementImpact = (subject, affected, reverseImpact) => ({
        id: "requirement_modify:" + subject,
        kind: "requirement_modify",
        subject,
        affected,
        applicable: affected,
        directApplicable: [subject],
        reverseImpact,
        causalCandidates: [subject],
        causes: [subject],
      });
      assert.deepEqual(
        targetWhy.DPARENT,
        expectedRequirementImpact("DPARENT", ["DCHILD", "DPARENT"], ["DCHILD"]),
      );
      assert.deepEqual(
        targetWhy.DEPTARGET,
        expectedRequirementImpact("DEPTARGET", ["DEPEND", "DEPTARGET"], ["DEPEND"]),
      );
      assert.deepEqual(
        targetWhy.CONTARGET,
        expectedRequirementImpact("CONTARGET", ["CONSTRAINER", "CONTARGET"], ["CONSTRAINER"]),
      );

      fx.git("checkout", "-q", impactBase);
      fx.put("requirements/DCHILD.rg.json", requirement840({
        id: "DCHILD",
        normative: "changed source DCHILD",
        relations: [relation840("derives_from", requirementRef840("DPARENT"))],
      }));
      fx.put("requirements/DEPEND.rg.json", requirement840({
        id: "DEPEND",
        normative: "changed source DEPEND",
        relations: [relation840("depends_on", requirementRef840("DEPTARGET"))],
      }));
      fx.put("requirements/CONSTRAINER.rg.json", requirement840({
        id: "CONSTRAINER",
        normative: "changed source CONSTRAINER",
        relations: [relation840("constrains", requirementRef840("CONTARGET"))],
      }));
      const sourceHead = fx.save("C3 impact sources");
      const sourceImpact = transition840(open840(fx.root, impactBase), open840(fx.root, sourceHead));
      const sourceWhy = Object.fromEntries(
        sourceImpact.explanations.whyChanged
          .filter((item) => item.kind === "requirement_modify")
          .map((item) => [item.subject, item]),
      );
      assert.deepEqual(
        sourceWhy.DCHILD,
        expectedRequirementImpact("DCHILD", ["DCHILD", "DPARENT"], ["DPARENT"]),
      );
      assert.deepEqual(
        sourceWhy.DEPEND,
        expectedRequirementImpact("DEPEND", ["DEPEND"], []),
      );
      assert.deepEqual(
        sourceWhy.CONSTRAINER,
        expectedRequirementImpact("CONSTRAINER", ["CONSTRAINER"], []),
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("#840 C4 native Constraint lowering and J3 scope equivalence are characterized", () => {
    const defaults = fixture840();
    try {
      const relations = [
        relation840("implemented_by", artifactRef840("src/a.txt")),
        relation840("verified_by", artifactRef840("tests/v.mjs")),
      ];
      defaults.put("requirements/R.rg.json", requirement840({
        id: "R",
        relations,
        constraints: [{
          id: "guard",
          scope: { relations: ["verified_by", "implemented_by"] },
          metric: { key: "git.changed_resources", max: 10 },
        }],
      }));
      defaults.put("src/a.txt", "a\n");
      defaults.put("tests/v.mjs", "export {};\n");
      const base = defaults.save("C4 defaults base");
      defaults.put("requirements/R.rg.json", requirement840({
        id: "R",
        relations,
        constraints: [{
          id: "guard",
          activation: "scoped_change",
          scope: { relations: ["implemented_by", "verified_by"], include_generated: false },
          metric: { key: "git.changed_resources", max: 10 },
        }],
      }));
      const head = defaults.save("C4 explicit defaults head");
      const baseState = open840(defaults.root, base);
      const headState = open840(defaults.root, head);
      assert.deepEqual(baseState.native.index.R.constraints, headState.native.index.R.constraints);
      assert.deepEqual(
        baseState.requirements.index.R.value.constraints,
        headState.requirements.index.R.value.constraints,
      );
      assert.deepEqual(baseState.lowered.compiledConstraints, headState.lowered.compiledConstraints);
      const convergence = transition840(baseState, headState);
      const legacyConvergence = legacyTransition840(baseState, headState);
      assert.deepEqual(convergence, legacyConvergence);
      assert.equal(convergence.ok, true, JSON.stringify(convergence.reasons, null, 2));
      assert.equal(convergence.deltas.some((delta) => delta.kind.startsWith("constraint_")), false);
      const guards = convergence.explanations.constraints.filter((item) =>
        item.requirementId === "R" && item.constraintId === "guard");
      assert.equal(guards.length, 1, JSON.stringify(convergence.explanations.constraints, null, 2));
      assert.deepEqual(guards[0], {
        requirementId: "R",
        constraintId: "guard",
        basis: "AUTHORITY",
        activation: "scoped_change",
        directApplicable: false,
        selectedCause: false,
        reverseImpacted: false,
        rootedProof: ["R"],
        exactTransition: {
          authorityBaseRevision: base,
          baseRevision: base,
          headRevision: head,
        },
        metric: "changed_resources",
        max: 10,
        scope: ["src/a.txt", "tests/v.mjs"],
        scopeProofs: {
          "src/a.txt": ["R", "implemented_by:src/a.txt"],
          "tests/v.mjs": ["R", "verified_by:tests/v.mjs"],
        },
        touched: [],
        observed: null,
        observationSources: [],
        requiredEvidence: null,
        evidenceStatus: null,
        verdict: "NOT_APPLICABLE",
      });
    } finally {
      rmSync(defaults.root, { recursive: true, force: true });
    }

    const fx = fixture840();
    try {
      fx.put("requirements/ART.rg.json", requirement840({
        id: "ART",
        relations: [relation840("implemented_by", artifactRef840("src/art.txt"))],
        constraints: [{
          id: "c-art",
          scope: { relations: ["implemented_by"] },
          metric: { key: "git.changed_resources", max: 1 },
        }],
      }));
      fx.put("requirements/DOC.rg.json", requirement840({
        id: "DOC",
        relations: [relation840("documents", documentRef840("docs/data.json", "/section"))],
        constraints: [{
          id: "c-doc",
          scope: { relations: ["documents"] },
          metric: { key: "git.changed_resources", max: 1 },
        }],
      }));
      fx.put("requirements/DOCOWNER.rg.json", requirement840({
        id: "DOCOWNER",
        relations: [relation840("implemented_by", artifactRef840("docs/data.json"))],
      }));
      fx.put("requirements/COL.rg.json", requirement840({
        id: "COL",
        relations: [relation840("requires", artifactRef840("inventory/resources.json"), { collection: true })],
        constraints: [{
          id: "c-col",
          scope: { relations: ["requires"] },
          metric: { key: "git.changed_resources", max: 1 },
        }],
      }));
      fx.put("requirements/GEN.rg.json", requirement840({
        id: "GEN",
        relations: [
          relation840("implemented_by", artifactRef840("src/source.txt")),
          generates840("src/source.txt", "gen/out.txt"),
        ],
        constraints: [{
          id: "c-gen",
          scope: { relations: ["implemented_by"], include_generated: true },
          metric: { key: "git.changed_resources", max: 1 },
        }],
      }));
      fx.put("src/art.txt", "before art\n");
      fx.put("docs/data.json", JSON.stringify({ section: { value: "before" } }) + "\n");
      fx.put("inventory/resources.json", JSON.stringify({
        schema: collectionSchema840,
        members: ["tests/member.txt"],
      }, null, 2) + "\n");
      fx.put("tests/member.txt", "before member\n");
      fx.put("src/source.txt", "stable source\n");
      fx.put("gen/out.txt", "before generated\n");
      const base = fx.save("C4 scope base");

      fx.put("src/art.txt", "after art\n");
      fx.put("docs/data.json", JSON.stringify({ section: { value: "after" } }) + "\n");
      fx.put("tests/member.txt", "after member\n");
      fx.put("gen/out.txt", "after generated\n");
      const head = fx.save("C4 scope head");

      const baseState = open840(fx.root, base);
      const headState = open840(fx.root, head);
      const resourceDeltas = diffResources840(fx, base, head);
      const transition = transition840(baseState, headState, resourceDeltas);
      const legacyTransition = legacyTransition840(baseState, headState, resourceDeltas);
      assert.deepEqual(transition, legacyTransition);
      assert.equal(transition.ok, true, JSON.stringify(transition.reasons, null, 2));
      const constraints = Object.fromEntries(
        transition.explanations.constraints.map((item) => [item.constraintId, item]),
      );
      for (const id of ["c-art", "c-doc", "c-col", "c-gen"]) {
        assert.ok(constraints[id], JSON.stringify(transition.explanations.constraints, null, 2));
        assert.equal(constraints[id].basis, "AUTHORITY");
        assert.equal(constraints[id].activation, "scoped_change");
        assert.equal(constraints[id].observed, 1);
        assert.equal(constraints[id].metric, "changed_resources");
        assert.equal(constraints[id].max, 1);
        assert.equal(constraints[id].requiredEvidence, null);
        assert.equal(constraints[id].evidenceStatus, null);
        assert.equal(constraints[id].verdict, "PASS");
      }
      assert.deepEqual(constraints["c-art"].scope, ["src/art.txt"]);
      assert.deepEqual(constraints["c-art"].touched, ["src/art.txt"]);
      assert.deepEqual(constraints["c-doc"].scope, ["docs/data.json"]);
      assert.deepEqual(constraints["c-doc"].touched, ["docs/data.json"]);
      assert.deepEqual(constraints["c-col"].scope, ["inventory/resources.json", "tests/member.txt"]);
      assert.deepEqual(constraints["c-col"].touched, ["tests/member.txt"]);
      assert.deepEqual(constraints["c-gen"].scope, ["gen/out.txt", "src/source.txt"]);
      assert.deepEqual(constraints["c-gen"].touched, ["gen/out.txt"]);
      assert.deepEqual(constraints["c-art"].scopeProofs, {
        "src/art.txt": ["ART", "implemented_by:src/art.txt"],
      });
      assert.deepEqual(constraints["c-doc"].scopeProofs, {
        "docs/data.json": ["DOC", "documents:docs/data.json"],
      });
      assert.deepEqual(constraints["c-col"].scopeProofs, {
        "inventory/resources.json": ["COL", "requires:inventory/resources.json"],
        "tests/member.txt": [
          "COL",
          "requires:inventory/resources.json",
          "collection:" + collectionSchema840,
          "member:tests/member.txt",
        ],
      });
      assert.deepEqual(constraints["c-gen"].scopeProofs, {
        "gen/out.txt": ["GEN", "implemented_by:src/source.txt", "generates:gen/out.txt"],
        "src/source.txt": ["GEN", "implemented_by:src/source.txt"],
      });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });


  test("#840 Slice 3 typed compiled Constraint engine is exact legacy parity for activation metrics generation and evidence", () => {
    const fx = fixture840();
    try {
      const relations = [
        relation840("implemented_by", artifactRef840("src/a.txt")),
        relation840("implemented_by", artifactRef840("src/ui.txt")),
        relation840("implemented_by", artifactRef840("docs/data.json")),
        relation840("documents", documentRef840("docs/data.json", "/section")),
        relation840("verified_by", artifactRef840("tests/v.mjs")),
        relation840("constrains", artifactRef840("src/ui.txt")),
        generates840("src/a.txt", "gen/a.js"),
      ];
      const constraints = [
        {
          id: "scoped",
          activation: "scoped_change",
          scope: { relations: ["implemented_by"], include_generated: false },
          metric: { key: "git.changed_resources", max: 10 },
        },
        {
          id: "generated",
          scope: { relations: ["implemented_by"], include_generated: true },
          metric: { key: "git.changed_resources", max: 10 },
        },
        {
          id: "cause",
          activation: "requirement_cause",
          scope: { relations: ["constrains"] },
          metric: { key: "git.changed_resources", max: 10 },
        },
        {
          id: "lines",
          scope: { relations: ["documents"] },
          metric: { key: "git.changed_lines", max: 10 },
        },
        {
          id: "domain",
          scope: { relations: ["implemented_by"] },
          evidence: { class: "domain", key: "domain:parity" },
        },
        {
          id: "execution",
          scope: { relations: ["implemented_by"] },
          evidence: {
            class: "execution",
            key: "execution:tests/v.mjs",
            verifier: artifactRef840("tests/v.mjs"),
          },
        },
      ];
      fx.put("requirements/R.rg.json", requirement840({ id: "R", relations, constraints }));
      fx.put("src/a.txt", "before a\n");
      fx.put("src/ui.txt", "before ui\n");
      fx.put("docs/data.json", JSON.stringify({ section: { value: "before" } }) + "\n");
      fx.put("tests/v.mjs", "export {};\n");
      fx.put("gen/a.js", "before generated\n");
      const base = fx.save("Slice 3 parity base");

      fx.put("src/a.txt", "after a\n");
      fx.put("src/ui.txt", "after ui\n");
      fx.put("docs/data.json", JSON.stringify({ section: { value: "after" } }) + "\n");
      fx.put("gen/a.js", "after generated\n");
      const head = fx.save("Slice 3 parity head");

      const baseState = open840(fx.root, base);
      const headState = open840(fx.root, head);
      const resourceDeltas = diffResources840(fx, base, head);
      const observationFacts = [{
        authorityBaseRevision: base,
        baseRevision: base,
        headRevision: head,
        path: "docs/data.json",
        metric: "changed_lines",
        value: 2,
      }];
      const evaluateWith = (stateOf) => evaluateTransitionCauseClosure({
        repository: repository840,
        base: stateOf(baseState),
        head: stateOf(headState),
        trustedAuthorityBase: stateOf(baseState),
        resourceDeltas,
        baseLifecycle: baseState.lifecycle,
        headLifecycle: headState.lifecycle,
        observationFacts,
      });
      const typed = evaluateWith(transitionState840);
      const legacy = evaluateWith(legacyTransitionState840);
      assert.deepEqual(typed, legacy);
      assert.equal(typed.ok, true, JSON.stringify(typed.reasons, null, 2));

      const byId = Object.fromEntries(typed.explanations.constraints.map((item) => [item.constraintId, item]));
      for (const id of ["scoped", "generated", "cause", "lines", "domain", "execution"]) {
        assert.equal(
          typed.explanations.constraints.filter((item) => item.constraintId === id).length,
          1,
          id + " must execute once across AUTHORITY/BASE/HEAD",
        );
      }
      assert.equal(byId.scoped.activation, "scoped_change");
      assert.equal(byId.cause.activation, "requirement_cause");
      assert.equal(byId.cause.directApplicable, true);
      assert.equal(byId.scoped.metric, "changed_resources");
      assert.equal(byId.lines.metric, "changed_lines");
      assert.equal(byId.lines.observed, 2);
      assert.equal(byId.scoped.scope.includes("gen/a.js"), false);
      assert.equal(byId.generated.scope.includes("gen/a.js"), true);
      assert.equal(byId.domain.evidenceStatus, "DELEGATED");
      assert.equal(byId.domain.verdict, "DELEGATED");
      assert.equal(byId.execution.evidenceStatus, "DELEGATED");
      assert.equal(byId.execution.verdict, "DELEGATED");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("#840 Slice 3 typed Constraint deltas preserve add modify remove identity ordering and legacy parity", () => {
    const fx = fixture840();
    try {
      const relations = [relation840("implemented_by", artifactRef840("src/a.txt"))];
      fx.put("requirements/R.rg.json", requirement840({
        id: "R",
        relations,
        constraints: [
          {
            id: "modify",
            scope: { relations: ["implemented_by"] },
            metric: { key: "git.changed_resources", max: 1 },
          },
          {
            id: "remove",
            scope: { relations: ["implemented_by"] },
            metric: { key: "git.changed_resources", max: 1 },
          },
        ],
      }));
      fx.put("src/a.txt", "stable\n");
      const base = fx.save("Slice 3 delta base");

      fx.put("requirements/R.rg.json", requirement840({
        id: "R",
        relations,
        constraints: [
          {
            id: "add",
            scope: { relations: ["implemented_by"] },
            metric: { key: "git.changed_resources", max: 1 },
          },
          {
            id: "modify",
            scope: { relations: ["implemented_by"] },
            metric: { key: "git.changed_resources", max: 2 },
          },
        ],
      }));
      const head = fx.save("Slice 3 delta head");

      const baseState = open840(fx.root, base);
      const headState = open840(fx.root, head);
      const typed = transition840(baseState, headState);
      const legacy = legacyTransition840(baseState, headState);
      assert.deepEqual(typed, legacy);
      assert.deepEqual(
        typed.deltas.filter((delta) => delta.kind.startsWith("constraint_")),
        [
          { id: "constraint_add:R:add", kind: "constraint_add", subject: "R", constraintId: "add" },
          { id: "constraint_modify:R:modify", kind: "constraint_modify", subject: "R", constraintId: "modify" },
          { id: "constraint_remove:R:remove", kind: "constraint_remove", subject: "R", constraintId: "remove" },
        ],
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("#840 C5 native local-compiler diagnostics multiplicity and ordering are characterized", () => {
    const dangling = fixture840();
    try {
      dangling.put("requirements/A.rg.json", requirement840({
        id: "A",
        relations: [relation840("derives_from", requirementRef840("MISSING"))],
      }));
      const revision = dangling.save("C5 dangling requirement");
      const entries = listTrackedEntriesAtRef(revision, dangling.root);
      const requirementPath = "requirements/A.rg.json";
      const raw = readFileBytesAtRef(revision, requirementPath, dangling.root);
      assert.ok(raw);
      const native = loadNativeRequirements({
        repository: repository840,
        revision,
        paths: [requirementPath],
        readFile: (sha, path) => sha === revision && path === requirementPath ? raw : null,
      });
      assert.equal(native.ok, true, JSON.stringify(native.errors, null, 2));
      const lowered = lowerNativeRequirements(native);
      assert.equal(lowered.requirements.ok, true, JSON.stringify(lowered.requirements.errors, null, 2));
      const j2 = evaluateRootedRequirements({ requirements: lowered.requirements, trustedRoots: [] });
      assert.deepEqual(j2, {
        ok: false,
        rooted: [],
        unrooted: ["A"],
        errors: [{ code: "missing_requirement_target", requirement: "A", target: "MISSING" }],
        explanations: {},
      });
      assert.deepEqual(entries.map((entry) => entry.path), [requirementPath]);

      const report = evaluateLocalCompiler({
        root: dangling.root,
        repository: repository840,
        base: revision,
        head: revision,
      });
      assert.equal(report.ok, false);
      assert.deepEqual(report.diagnostics, [
        { code: "j2_not_rooted", subject: revision + ":", detail: undefined },
        { code: "j3", subject: "authority_base:j2_not_rooted" },
        { code: "j3", subject: "base:j2_not_rooted" },
        { code: "j3", subject: "head:j1_not_closed" },
        { code: "j3", subject: "head:j2_not_rooted" },
        { code: "missing_requirement_target", subject: revision + ":A", detail: "MISSING" },
        { code: "missing_requirement_target", subject: revision + ":A", detail: "MISSING" },
        { code: "unjustified_resource", subject: revision + ":requirements/A.rg.json" },
        { code: "unrooted_requirement", subject: revision + ":A" },
      ]);
    } finally {
      rmSync(dangling.root, { recursive: true, force: true });
    }

    const cycle = fixture840();
    try {
      cycle.put("requirements/A.rg.json", requirement840({
        id: "A",
        relations: [relation840("derives_from", requirementRef840("B"))],
      }));
      cycle.put("requirements/B.rg.json", requirement840({
        id: "B",
        relations: [relation840("derives_from", requirementRef840("A"))],
      }));
      const revision = cycle.save("C5 unrooted cycle");
      const report = evaluateLocalCompiler({
        root: cycle.root,
        repository: repository840,
        base: revision,
        head: revision,
      });
      assert.equal(report.ok, false);
      assert.deepEqual(report.diagnostics, [
        { code: "j2_not_rooted", subject: revision + ":", detail: undefined },
        { code: "j3", subject: "authority_base:j2_not_rooted" },
        { code: "j3", subject: "base:j2_not_rooted" },
        { code: "j3", subject: "head:j1_not_closed" },
        { code: "j3", subject: "head:j2_not_rooted" },
        { code: "unjustified_resource", subject: revision + ":requirements/A.rg.json" },
        { code: "unjustified_resource", subject: revision + ":requirements/B.rg.json" },
        { code: "unrooted_requirement", subject: revision + ":A" },
        { code: "unrooted_requirement", subject: revision + ":B" },
      ]);
    } finally {
      rmSync(cycle.root, { recursive: true, force: true });
    }

    const missing = fixture840();
    try {
      missing.put("requirements/ROOT.rg.json", requirement840({
        id: "ROOT",
        relations: [relation840("implemented_by", artifactRef840("src/missing.txt"))],
      }));
      const revision = missing.save("C5 missing resource");
      const report = evaluateLocalCompiler({
        root: missing.root,
        repository: repository840,
        base: revision,
        head: revision,
      });
      assert.equal(report.ok, false);
      assert.deepEqual(report.diagnostics, [
        { code: "j3", subject: "head:j1_not_closed" },
        { code: "missing_resource_target", subject: revision + ":ROOT", detail: "src/missing.txt" },
      ]);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
    }
  });

  console.log("#840 characterization scaffold C1-C5 loaded; C6 remains covered by test-707-i5 legacy value.transition sentinel");
}
