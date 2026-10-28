import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, chmodSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
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
