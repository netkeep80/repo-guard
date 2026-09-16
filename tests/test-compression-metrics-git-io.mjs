import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acceptedBase = "26767a2dc2d3ad26e005cea17fb64b10eebc03a4";
const c3Baseline = "92432809fcddc290080beb51ba151e13a5761869";
const currentScript = resolve(root, "scripts/compression-metrics.mjs");
const scratch = mkdtempSync(join(tmpdir(), "repo-guard-compression-metrics-"));

const run = (script, args, options = {}) => execFileSync(
  process.execPath,
  [script, ...args],
  {
    cwd: root,
    encoding: "utf8",
    ...options,
  },
);

function resolveGitBinary() {
  const names = process.platform === "win32"
    ? ["git.exe", "git.cmd", "git.bat", "git"]
    : ["git"];
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("git executable not found on PATH");
}

try {
  const legacySource = execFileSync(
    "git",
    ["show", `${acceptedBase}:scripts/compression-metrics.mjs`],
    { cwd: root, encoding: "utf8" },
  );
  const legacyScript = join(scratch, "legacy-compression-metrics.mjs");
  writeFileSync(legacyScript, legacySource);

  for (const args of [
    ["--ref", acceptedBase],
    ["--ref", c3Baseline],
    ["--ref", acceptedBase, "--compare", c3Baseline],
  ]) {
    assert.equal(
      run(currentScript, args),
      run(legacyScript, args),
      `metrics output must remain byte-identical for ${args.join(" ")}`,
    );
  }

  const missingRef = "refs/heads/__repo_guard_missing_metrics_ref__";
  const missing = spawnSync(
    process.execPath,
    [currentScript, "--ref", missingRef],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(missing.status, 0, "missing Git object/ref must fail");
  assert.match(
    missing.stderr,
    /fatal|Command failed|unknown revision|bad object|not a valid object/i,
    "missing Git object/ref failure must remain explicit",
  );

  if (process.platform !== "win32") {
    const realGit = resolveGitBinary();
    const wrapperDir = join(scratch, "bin");
    const tracePath = join(scratch, "git-calls.log");
    mkdirSync(wrapperDir);
    const wrapperPath = join(wrapperDir, "git");
    writeFileSync(
      wrapperPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$REPO_GUARD_METRICS_GIT_TRACE\"",
        "exec \"$REPO_GUARD_METRICS_REAL_GIT\" \"$@\"",
        "",
      ].join("\n"),
    );
    chmodSync(wrapperPath, 0o755);

    run(
      currentScript,
      ["--ref", acceptedBase, "--compare", c3Baseline],
      {
        env: {
          ...process.env,
          PATH: `${wrapperDir}${delimiter}${process.env.PATH || ""}`,
          REPO_GUARD_METRICS_GIT_TRACE: tracePath,
          REPO_GUARD_METRICS_REAL_GIT: realGit,
        },
      },
    );

    const calls = readFileSync(tracePath, "utf8").split(/\r?\n/).filter(Boolean);
    assert.ok(
      calls.length <= 5,
      `current-vs-baseline metrics must use at most 5 Git subprocesses, got ${calls.length}`,
    );
    assert.equal(
      new Set(calls).size,
      calls.length,
      "metrics invocation must not repeat an exact Git command",
    );
    assert.equal(calls.filter((call) => call.startsWith("rev-parse ")).length, 2);
    assert.equal(calls.filter((call) => call.startsWith("ls-tree ")).length, 2);
    assert.equal(calls.filter((call) => call === "cat-file --batch").length, 1);
  }

  console.log("Compression metrics exact-ref Git I/O contract passed.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
