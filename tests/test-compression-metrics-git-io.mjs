import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const run = (args, options = {}) => execFileSync(
  process.execPath,
  [currentScript, ...args],
  { cwd: root, encoding: "utf8", ...options },
);

function resolveGitBinary() {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git.bat", "git"] : ["git"];
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("git executable not found on PATH");
}

try {
  // Captured from the frozen legacy implementation after CI #1971 proved byte equality.
  for (const { args, digest } of [
    { args: ["--ref", acceptedBase], digest: "f1e5d42b4e6f23a61b48d881ee6f003ecd0350c62083b71332e3c5eb3d2cd450" },
    { args: ["--ref", c3Baseline], digest: "6cc8165cbc55c19316e4f0118d0f9f3ba410d782e6743c0671803b8aa3e7762d" },
    { args: ["--ref", acceptedBase, "--compare", c3Baseline], digest: "e38714b12c63c055c7e3a09fc9594bd64894788574051bbe30fff8ca0325e463" },
  ]) {
    assert.equal(sha256(run(args)), digest, `metrics bytes changed for ${args.join(" ")}`);
  }

  const missingRef = spawnSync(
    process.execPath,
    [currentScript, "--ref", "refs/heads/__repo_guard_missing_metrics_ref__"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(missingRef.status, 0, "missing Git object/ref must fail");
  assert.match(missingRef.stderr, /fatal|Command failed|unknown revision|bad object|not a valid object/i);

  const emptyRepo = join(scratch, "empty-repo");
  mkdirSync(emptyRepo);
  execFileSync("git", ["init", "--quiet"], { cwd: emptyRepo });
  execFileSync(
    "git",
    ["-c", "user.name=repo-guard", "-c", "user.email=repo-guard@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "empty"],
    { cwd: emptyRepo },
  );
  const missingPath = spawnSync(process.execPath, [currentScript, "--ref", "HEAD"], { cwd: emptyRepo, encoding: "utf8" });
  assert.notEqual(missingPath.status, 0, "missing required snapshot path must fail");
  assert.match(missingPath.stderr, /Path repo-policy\.json does not exist at [0-9a-f]{40}/);

  if (process.platform !== "win32") {
    const realGit = resolveGitBinary();
    const wrapperDir = join(scratch, "bin");
    const tracePath = join(scratch, "git-calls.log");
    mkdirSync(wrapperDir);
    const wrapperPath = join(wrapperDir, "git");
    writeFileSync(
      wrapperPath,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$REPO_GUARD_METRICS_GIT_TRACE\"\nexec \"$REPO_GUARD_METRICS_REAL_GIT\" \"$@\"\n",
    );
    chmodSync(wrapperPath, 0o755);

    run(
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
    assert.ok(calls.length <= 5, `current-vs-baseline metrics must use at most 5 Git subprocesses, got ${calls.length}`);
    assert.equal(new Set(calls).size, calls.length, "metrics invocation must not repeat an exact Git command");
    assert.equal(calls.filter((call) => call.startsWith("rev-parse ")).length, 2);
    assert.equal(calls.filter((call) => call.startsWith("ls-tree ")).length, 2);
    assert.equal(calls.filter((call) => call === "cat-file --batch").length, 1);
  }

  console.log("Compression metrics exact-ref Git I/O contract passed.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
