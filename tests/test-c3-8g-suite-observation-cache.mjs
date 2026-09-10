import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const helperUrl = pathToFileURL(resolve(root, "tests/support/immutable-observation.mjs")).href;
const cacheDir = mkdtempSync(join(tmpdir(), "repo-guard-observation-cache-"));

function runChild(source, env) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
}

function incrementScript(path, { fail = false } = {}) {
  return [
    "const fs=require('node:fs');",
    `const p=${JSON.stringify(path)};`,
    "const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;",
    "fs.writeFileSync(p,String(n+1));",
    fail ? "process.exit(7);" : "process.stdout.write('stable');",
  ].join("");
}

function observationChild(args, { expectFailure = false, repeat = 1 } = {}) {
  return `
    import { observeImmutable } from ${JSON.stringify(helperUrl)};
    for (let i = 0; i < ${repeat}; i++) {
      ${expectFailure ? "try {" : "const result ="} observeImmutable(process.execPath, ${JSON.stringify(args)}, { cwd: ${JSON.stringify(root)} });
      ${expectFailure ? "} catch { continue; } process.exit(3);" : "if (result !== 'stable') process.exit(2);"}
    }
  `;
}

try {
  const sharedEnv = {
    ...process.env,
    REPO_GUARD_TEST_OBSERVATION_CACHE_DIR: cacheDir,
  };

  const sharedCounter = join(cacheDir, "shared-executions.txt");
  const sharedArgs = ["-e", incrementScript(sharedCounter)];
  runChild(observationChild(sharedArgs), sharedEnv);
  runChild(observationChild(sharedArgs), sharedEnv);
  assert.equal(Number(readFileSync(sharedCounter, "utf8")), 1);

  const distinctCounter = join(cacheDir, "distinct-executions.txt");
  const distinctArgs = ["-e", incrementScript(distinctCounter), "distinct"];
  runChild(observationChild(distinctArgs), sharedEnv);
  assert.equal(Number(readFileSync(distinctCounter, "utf8")), 1);

  const failureCounter = join(cacheDir, "failure-executions.txt");
  const failureArgs = ["-e", incrementScript(failureCounter, { fail: true })];
  runChild(observationChild(failureArgs, { expectFailure: true }), sharedEnv);
  runChild(observationChild(failureArgs, { expectFailure: true }), sharedEnv);
  assert.equal(Number(readFileSync(failureCounter, "utf8")), 2);

  const standaloneCounter = join(cacheDir, "standalone-executions.txt");
  const standaloneArgs = ["-e", incrementScript(standaloneCounter)];
  const standaloneEnv = { ...process.env };
  delete standaloneEnv.REPO_GUARD_TEST_OBSERVATION_CACHE_DIR;
  runChild(observationChild(standaloneArgs, { repeat: 2 }), standaloneEnv);
  assert.equal(Number(readFileSync(standaloneCounter, "utf8")), 1);

  assert.equal(existsSync(cacheDir), true);
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}

console.log("C3.8g suite-scoped immutable observation cache contract passed");
