import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
const json = (path) => JSON.parse(read(path));

assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "init", "doctor"]);

for (const path of [
  "src/integration-validator.mts",
  "src/extractors/integration.mts",
  "src/checks/integration-constraints.mts",
  "dist/integration-validator.mjs",
  "dist/extractors/integration.mjs",
  "dist/checks/integration-constraints.mjs",
  "examples/downstream-integration-policy.json",
  "tests/fixtures/integration",
]) assert.equal(existsSync(resolve(root, path)), false, `${path} must be deleted`);

const runtime = read("src/checks/rules/constraints.mts");
const kindBlock = runtime.match(/type RuntimeConstraintKind =([\s\S]*?);/);
const kinds = kindBlock ? [...kindBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort() : [];
assert.deepEqual(kinds, ["primitive_relation"]);
assert.equal(runtime.includes("integrationConstraintEntries"), false, "runtime evaluator must not dispatch integration semantics");

const policy = json("repo-policy.json");
assert.equal(Object.hasOwn(policy, "integration"), false, "self policy must not retain top-level integration DSL");
const schema = json("schemas/repo-policy.schema.json");
assert.equal(Object.hasOwn(schema.properties || {}, "integration"), false, "policy schema must reject top-level integration DSL");

const factsInput = read("src/facts/input.mts");
assert.equal(factsInput.includes("integration"), false, "Fact acquisition must not expose a special integration fact");

const factSource = read("src/document-facts.mts").match(/export type FactSource = ([^;]+);/);
const sources = factSource ? [...factSource[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort() : [];
assert.deepEqual(sources, ["change_intent", "diff", "document", "repository"]);
assert.equal(relationDescriptors().length, 10);

console.log("C3.3e E3c integration runtime deletion contract passed.");
