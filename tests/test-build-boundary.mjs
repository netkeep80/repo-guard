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
  assert.equal(config.compilerOptions.allowJs, true);
  assert.equal(config.compilerOptions.checkJs, false);
  assert.deepEqual(config.compilerOptions.types, ["node"]);
  assert.deepEqual(config.include, ["src/**/*.mjs", "src/**/*.mts"]);

  assert.equal(existsSync(resolve(projectRoot, "src/utils/collections.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/utils/collections.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/utils/path-patterns.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/utils/path-patterns.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/utils/repository-files.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/utils/repository-files.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/git.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/git.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/diff/parser.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/diff/parser.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/diff/growth.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/diff/growth.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/diff/classification.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/diff/classification.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/diff/filters.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/diff/filters.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/enforcement.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/enforcement.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/document-facts.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/document-facts.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/extractors/anchors.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/extractors/anchors.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/facts/input.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/facts/input.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/relation-kernel.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/relation-kernel.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rule-registry.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rule-registry.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/default-rule-families.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/default-rule-families.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/orchestrator.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/orchestrator.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/constraints.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/constraints.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/anchor-rules.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/anchor-rules.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/content-rules.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/content-rules.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/governance-paths.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/governance-paths.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/size-rules.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/size-rules.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/advisory-text-rules.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/advisory-text-rules.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/change-profiles.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/change-profiles.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/policy-delta-rules.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/policy-delta-rules.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/registry-rules.mts")), true);
  assert.equal(existsSync(resolve(projectRoot, "src/checks/rules/registry-rules.mjs")), false);
  assert.equal(existsSync(resolve(projectRoot, "dist/utils/repository-files.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/git.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/diff/parser.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/diff/growth.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/diff/classification.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/diff/filters.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/enforcement.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/document-facts.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/extractors/anchors.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/facts/input.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/relation-kernel.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rule-registry.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/default-rule-families.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/orchestrator.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/constraints.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/anchor-rules.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/content-rules.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/governance-paths.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/size-rules.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/advisory-text-rules.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/change-profiles.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/policy-delta-rules.mjs")), true);
  assert.equal(existsSync(resolve(projectRoot, "dist/checks/rules/registry-rules.mjs")), true);

  const action = read("action.yml");
  assert.match(action, /node \$\{GITHUB_ACTION_PATH\}\/dist\/repo-guard\.mjs/);
  assert.doesNotMatch(action, /GITHUB_ACTION_PATH\}\/src\/repo-guard\.mjs/);
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
