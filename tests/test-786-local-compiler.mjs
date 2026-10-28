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
