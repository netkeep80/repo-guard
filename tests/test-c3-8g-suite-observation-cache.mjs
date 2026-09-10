import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const helperUrl = pathToFileURL(resolve(root, "tests/support/immutable-observation.mjs")).href;
const cacheDir = mkdtempSync(join(tmpdir(), "repo-guard-observation-cache-red-"));
const counterFile = join(cacheDir, "executions.txt");
const observationScript = [
  "const fs=require('node:fs');",
  "const p=process.argv[1];",
  "const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;",
  "fs.writeFileSync(p,String(n+1));",
  "process.stdout.write('stable');",
].join("");
const childScript = `
  import { observeImmutable } from ${JSON.stringify(helperUrl)};
  const result = observeImmutable(process.execPath, ${JSON.stringify(["-e", observationScript, counterFile])}, { cwd: ${JSON.stringify(root)} });
  if (result !== "stable") process.exit(2);
`;

try {
  const env = {
    ...process.env,
    REPO_GUARD_TEST_OBSERVATION_CACHE_DIR: cacheDir,
  };
  for (let i = 0; i < 2; i++) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  }

  assert.equal(Number(readFileSync(counterFile, "utf8")), 1);
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}

console.log("C3.8g suite-scoped immutable observation cache contract passed");
