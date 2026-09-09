import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { compileConstraintProgram, runtimeConstraints } from "../dist/checks/constraint-program.mjs";
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
]) assert.equal(existsSync(resolve(root, path)), false, `${path} must be deleted`);

const schema = json("schemas/repo-policy.schema.json");
assert.equal(schema.properties?.integration, undefined);
const validate = new Ajv({ allErrors: true }).compile(schema);
const policy = json("repo-policy.json");
assert.equal(Object.hasOwn(policy, "integration"), false);
assert.equal(validate({ ...policy, integration: {} }), false);

const runtimeSource = read("src/checks/rules/constraints.mts");
const kindBlock = runtimeSource.match(/type RuntimeConstraintKind =([\s\S]*?);/);
const kinds = kindBlock ? [...kindBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort() : [];
assert.deepEqual(kinds, ["primitive_relation"]);
assert.equal(runtimeSource.includes("integrationConstraintEntries"), false);
assert.equal(read("src/facts/input.mts").includes("extractIntegration"), false);
assert.equal(read("src/policy-compiler.mts").includes("compileIntegrationPolicy"), false);
assert.equal(read("src/doctor.mts").includes("checkWorkflowConfig"), false);
assert.equal(read("src/doctor.mts").includes("compileIntegrationPolicy"), false);

const kindsFromProgram = [...new Set(runtimeConstraints(compileConstraintProgram(policy, null)).map((item) => item.kind))].sort();
assert.deepEqual(kindsFromProgram, ["primitive_relation"]);

const factSource = read("src/document-facts.mts").match(/export type FactSource = ([^;]+);/);
const sources = factSource ? [...factSource[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort() : [];
assert.deepEqual(sources, ["change_intent", "diff", "document", "repository"]);
assert.equal(relationDescriptors().length, 10);

console.log("C3.3e E3c integration deletion contract passed.");
