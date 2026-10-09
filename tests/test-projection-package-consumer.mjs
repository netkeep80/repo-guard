import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(".");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tempRoot = mkdtempSync(join(tmpdir(), "repo-guard-projection-package-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return result;
}

try {
  const packed = run(npm, [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    tempRoot,
  ]);
  assert.equal(
    packed.status,
    0,
    `npm pack failed:\n${packed.stdout}\n${packed.stderr}`,
  );

  const packResult = JSON.parse(packed.stdout);
  assert.equal(packResult.length, 1, "npm pack must produce exactly one artifact");
  const tarball = join(tempRoot, packResult[0].filename);

  const consumerRoot = join(tempRoot, "consumer");
  const installed = run(
    npm,
    [
      "install",
      "--prefix",
      consumerRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
  );
  assert.equal(
    installed.status,
    0,
    `package install failed:\n${installed.stdout}\n${installed.stderr}`,
  );

  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
  );
  writeFileSync(
    join(consumerRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ["consumer.mts"],
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(consumerRoot, "consumer.mts"),
    [
      'import {',
      '  insertMarkdownChild,',
      '  listMarkdownSections,',
      '  normalizeProjectionModel,',
      '  type ProjectionModel,',
      '} from "repo-guard/dist/projection-api.mjs";',
      '',
      'const model: ProjectionModel = normalizeProjectionModel({',
      '  schema: "repo-guard/projection-model/v0",',
      '  id: "consumer.package.surface",',
      '  sources: [],',
      '  target: { path: "README.md", ownership: "generated" },',
      '  generator: { contract_id: "consumer/v1" },',
      '  required_evidence: [],',
      '});',
      'const sections = listMarkdownSections("# Title\\n");',
      'const inserted = insertMarkdownChild({',
      '  source: \'<a id="root"></a>\\n# Root\\n\',',
      '  mode: "hybrid",',
      '  parentAnchorId: "root",',
      '  child: { anchorId: "child", title: "Child" },',
      '  options: { transparentOwnedBlocks: [] },',
      '});',
      'void model;',
      'void sections;',
      'void inserted;',
      '',
    ].join("\n"),
  );

  const compiler = resolve(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const checked = run(
    process.execPath,
    [compiler, "--project", join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot },
  );

  assert.equal(
    checked.status,
    0,
    [
      "packed repo-guard must be directly consumable by strict NodeNext TypeScript",
      checked.stdout,
      checked.stderr,
    ].join("\n"),
  );

  console.log("Projection package consumer surface passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
