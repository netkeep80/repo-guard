import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const files = [
  "validate-schemas.mjs",
  ...readdirSync(testsDir).filter((name) => /^test-.*\.mjs$/.test(name)).sort(),
];
const observationCacheDir = mkdtempSync(join(tmpdir(), "repo-guard-test-observations-"));
let failedStatus = null;

try {
  for (const file of files) {
    console.log(`\n=== ${file} ===`);
    const result = spawnSync(process.execPath, [resolve(testsDir, file)], {
      stdio: "inherit",
      env: {
        ...process.env,
        REPO_GUARD_TEST_OBSERVATION_CACHE_DIR: observationCacheDir,
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        console.error(`::error title=repo-guard test failed::${file} exited with status ${result.status ?? 1}`);
      }
      failedStatus = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(observationCacheDir, { recursive: true, force: true });
}

if (failedStatus !== null) process.exit(failedStatus);
console.log(`\nAll ${files.length} test files passed.`);
