import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenariosRoot = resolve(root, "examples/scenarios");

assert.ok(existsSync(scenariosRoot), "C3.5a: каталог examples/scenarios ещё не создан");
const ids = readdirSync(scenariosRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.ok(ids.includes("minimal-diff-policy"), "C3.5a: отсутствует minimal-diff-policy");
