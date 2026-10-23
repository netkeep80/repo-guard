export const MAX_TEST_WORKERS = 4;

export function resolveWorkerCount(raw, defaultWorkers = 1) {
  const value = raw === undefined || raw === "" ? defaultWorkers : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TEST_WORKERS) {
    throw new Error(
      `test worker count must be an integer between 1 and ${MAX_TEST_WORKERS}`,
    );
  }
  return value;
}

export function buildExecutionBatches(files, manifest) {
  const batches = [];
  let parallelFiles = [];

  const flushParallel = () => {
    if (parallelFiles.length === 0) return;
    batches.push({ execution: "parallel", files: parallelFiles });
    parallelFiles = [];
  };

  for (const file of files) {
    const entry = manifest[file];
    if (!entry || !["parallel", "serial"].includes(entry.execution)) {
      throw new Error(`${file}: missing or invalid isolation manifest entry`);
    }

    if (entry.execution === "parallel") {
      parallelFiles.push(file);
      continue;
    }

    flushParallel();
    batches.push({ execution: "serial", files: [file] });
  }

  flushParallel();
  return batches;
}

async function runBounded(files, workerCount, runFile) {
  const results = new Array(files.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) return;
      results[index] = await runFile(files[index]);
    }
  }

  const activeWorkers = Math.min(workerCount, files.length);
  await Promise.all(
    Array.from({ length: activeWorkers }, () => worker()),
  );
  return results;
}

export async function executeBatches(
  batches,
  { workerCount, runFile, emitResult },
) {
  resolveWorkerCount(String(workerCount), 1);

  for (const batch of batches) {
    const results = batch.execution === "serial"
      ? [await runFile(batch.files[0])]
      : await runBounded(batch.files, workerCount, runFile);

    let failedStatus = null;
    for (let index = 0; index < batch.files.length; index += 1) {
      const file = batch.files[index];
      const result = results[index];
      emitResult(file, result);
      if (failedStatus === null && result.status !== 0) {
        failedStatus = result.status ?? 1;
      }
    }

    if (failedStatus !== null) return failedStatus;
  }

  return null;
}

// Test-only legacy transport for archived regression witnesses (not a public CLI command).
// The published repo-guard CLI does not dispatch check-pr.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../../dist/repo-guard.mjs", import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === cli) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("check-pr");
  if (at >= 0) {
    let repoRoot = process.cwd(), enforcementMode = null;
    for (let index = 0; index < at; index++) {
      if (argv[index] === "--repo-root") repoRoot = resolve(argv[++index]);
      else if (argv[index] === "--enforcement") enforcementMode = argv[++index];
    }
    const { runCheckPR } = await import("../../dist/github-pr.mjs");
    const status = runCheckPR({
      repoRoot,
      packageRoot: fileURLToPath(new URL("../..", import.meta.url)),
      enforcementMode,
    }, argv.slice(at + 1));
    process.exit(status);
  }
}
