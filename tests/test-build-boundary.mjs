import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const read = (path) => readFileSync(resolve(projectRoot, path), "utf-8");

console.log("\n--- package and Action execute checked dist without runtime TypeScript ---");
{
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.main, "dist/repo-guard.mjs");
  assert.equal(pkg.bin["repo-guard"], "dist/repo-guard.mjs");
  assert.equal(pkg.files.includes("dist/"), true);
  assert.equal(pkg.files.includes("src/"), false);
  assert.equal(pkg.dependencies.typescript, undefined);
  assert.equal(pkg.dependencies["@types/node"], undefined);
  assert.equal(pkg.devDependencies.typescript, "7.0.2");
  assert.equal(pkg.devDependencies["@types/node"], "20.19.43");

  const config = JSON.parse(read("tsconfig.json"));
  assert.equal(config.compilerOptions.module, "NodeNext");
  assert.equal(config.compilerOptions.moduleResolution, "NodeNext");
  assert.equal(Object.hasOwn(config.compilerOptions, "allowJs"), false);
  assert.equal(Object.hasOwn(config.compilerOptions, "checkJs"), false);
  assert.deepEqual(config.compilerOptions.types, ["node"]);
  assert.deepEqual(config.include, ["src/**/*.mts"]);

  assert.equal(existsSync(resolve(projectRoot, "src/repo-guard.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/repo-guard.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "dist/repo-guard.mjs")), true);

  const action = read("action.yml");
  assert.match(action, /node \$\{GITHUB_ACTION_PATH\}\/dist\/repo-guard\.mjs/);
  assert.doesNotMatch(action, /GITHUB_ACTION_PATH\}\/src\/repo-guard\.(?:mjs|mts)/);
  assert.match(action, /npm install --omit=dev --silent/);

  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /name: Verify generated dist freshness\n\s+run: npm run check:dist/);
  assert.match(workflow, /node dist\/repo-guard\.mjs --enforcement advisory check-diff/);
}

console.log("\n--- stale generated dist is rejected ---");
{
  const sourcePath = resolve(projectRoot, "src/utils/collections.mts");
  const distPath = resolve(projectRoot, "dist/utils/collections.mjs");
  const sourceBefore = readFileSync(sourcePath, "utf-8");
  const distBefore = readFileSync(distPath, "utf-8");
  try {
    writeFileSync(sourcePath, `${sourceBefore}\n// stale-dist-fixture\n`);
    const result = spawnSync(process.execPath, [resolve(projectRoot, "scripts/check-dist.mjs")], {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Generated dist is stale/);
  } finally {
    writeFileSync(sourcePath, sourceBefore);
    writeFileSync(distPath, distBefore);
  }
}

console.log("\n--- untracked generated output is rejected ---");
{
  const sourcePath = resolve(projectRoot, "src/untracked-dist-fixture.mts");
  const distPath = resolve(projectRoot, "dist/untracked-dist-fixture.mjs");
  try {
    writeFileSync(sourcePath, "export const fixture = true;\n");
    const result = spawnSync(process.execPath, [resolve(projectRoot, "scripts/check-dist.mjs")], {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Generated dist contains untracked files/);
  } finally {
    try { unlinkSync(sourcePath); } catch {}
    try { unlinkSync(distPath); } catch {}
  }
}

console.log("Build boundary tests passed.");
