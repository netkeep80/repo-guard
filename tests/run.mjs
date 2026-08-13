import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const files = [
  "validate-schemas.mjs",
  ...readdirSync(testsDir).filter((name) => /^test-.*\.mjs$/.test(name)).sort(),
];

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [resolve(testsDir, file)], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(`::error title=repo-guard test failed::${file} exited with status ${result.status ?? 1}`);
    }
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${files.length} test files passed.`);
