import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");

assert.deepEqual(COMMANDS, [
  "validate", "check-diff", "check-pr", "check-merge-group",
  "init", "doctor", "portable-coordinator", "validate-integration",
]);
for (const path of [
  "src/agent-lifecycle.mts", "src/status.mts", "src/migrate.mts",
  "src/migration-plan.mts", "src/migration-apply.mts",
  "docs/v2-migration.md",
]) assert.equal(existsSync(resolve(root, path)), false, `${path} must be deleted`);

const runtime = read("src/checks/rules/constraints.mts");
const kindBlock = runtime.match(/type RuntimeConstraintKind =([\s\S]*?);/);
const kinds = kindBlock ? [...kindBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() : [];
assert.deepEqual(kinds, ["integration", "primitive_relation"]);
assert.equal(relationDescriptors().length, 10);

const factSource = read("src/document-facts.mts").match(/export type FactSource = ([^;]+);/);
const sources = factSource ? [...factSource[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() : [];
assert.deepEqual(sources, ["change_intent", "diff", "document", "repository"]);
console.log("C3.3e E3a compatibility deletion contract passed.");
