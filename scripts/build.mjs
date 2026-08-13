#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const repositoryRoot = resolve(dirname(scriptPath), "..");
export const distRoot = resolve(repositoryRoot, "dist");

function assertSafeBuildRoot() {
  if (dirname(distRoot) !== repositoryRoot || distRoot === repositoryRoot) {
    throw new Error(`refusing to clean unsafe dist path: ${distRoot}`);
  }
}

export function cleanBuild() {
  assertSafeBuildRoot();
  const compiler = resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(compiler)) {
    throw new Error("TypeScript compiler is missing; run npm ci before building");
  }

  rmSync(distRoot, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [compiler, "--project", resolve(repositoryRoot, "tsconfig.json")], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (resolve(process.argv[1] || "") === scriptPath) cleanBuild();
