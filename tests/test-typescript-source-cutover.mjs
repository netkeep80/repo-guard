import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../dist/repo-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(path) {
  const out = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

describe("strict TypeScript source cutover", () => {
  it("keeps the canonical editable runtime mts-only", () => {
    const sourceFiles = filesUnder(resolve(root, "src"));
    assert.ok(sourceFiles.length > 20);
    assert.deepEqual(sourceFiles.filter((path) => /\.(?:mjs|js)$/.test(path)), []);
    assert.equal(sourceFiles.every((path) => path.endsWith(".mts")), true);
  });

  it("removes the allowJs migration bridge from the compiler", () => {
    const tsconfig = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf-8"));
    assert.equal(Object.hasOwn(tsconfig.compilerOptions, "allowJs"), false);
    assert.equal(Object.hasOwn(tsconfig.compilerOptions, "checkJs"), false);
    assert.deepEqual(tsconfig.include, ["src/**/*.mts"]);
  });

  it("keeps the built CLI command inventory explicit", () => {
    assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "check-merge-group", "status", "init", "doctor", "validate-integration"]);
  });
});
