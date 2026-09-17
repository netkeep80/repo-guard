import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testIsolationManifest } from "./test-isolation-manifest.mjs";
import {
  buildExecutionBatches,
  executeBatches,
  resolveWorkerCount,
} from "./support/test-runner.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const files = [
  "validate-schemas.mjs",
  ...readdirSync(testsDir).filter((name) => /^test-.*\.mjs$/.test(name)).sort(),
];
const workerCount = resolveWorkerCount(process.env.REPO_GUARD_TEST_WORKERS, 4);
const batches = buildExecutionBatches(files, testIsolationManifest);
const observationCacheDir = mkdtempSync(join(tmpdir(), "repo-guard-test-observations-"));

function runFile(file) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [resolve(testsDir, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        REPO_GUARD_TEST_OBSERVATION_CACHE_DIR: observationCacheDir,
      },
    });
    let stdout = "";
    let stderr = "";
    let spawnError = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      resolveResult({
        status: spawnError ? 1 : (code ?? 1),
        stdout,
        stderr,
        error: spawnError,
      });
    });
  });
}

function emitResult(file, result) {
  console.log(`\n=== ${file} ===`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(result.error.stack ?? String(result.error));
  }
  if (result.status !== 0 && process.env.GITHUB_ACTIONS === "true") {
    console.error(
      `::error title=repo-guard test failed::${file} exited with status ${result.status ?? 1}`,
    );
  }
}

let failedStatus = null;
try {
  console.log(`Test runner workers: ${workerCount}.`);
  failedStatus = await executeBatches(batches, {
    workerCount,
    runFile,
    emitResult,
  });
} finally {
  rmSync(observationCacheDir, { recursive: true, force: true });
}

if (failedStatus !== null) process.exit(failedStatus);
console.log(`\nAll ${files.length} test files passed.`);
