import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
`;

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
  assert.ok(item, JSON.stringify(report.j3.constraints));
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
    assert.equal(clean.status, 0);

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
    git(root, "update-index", "--add", "--cacheinfo", `160000,${first},deps/lib`);
    const base = commit(root, "gitlink base");
    git(root, "update-index", "--cacheinfo", `160000,${second},deps/lib`);
    const head = commit(root, "gitlink head");

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

console.log("#834 deterministic Git transition metric matrix: PASS");
