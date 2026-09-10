import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const workflowSource = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const workflowDocument = parseDocument(workflowSource);
assert.equal(workflowDocument.errors.length, 0);
const workflow = workflowDocument.toJS();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

assert.deepEqual(Object.keys(workflow.jobs ?? {}).sort(), ["smoke-pack", "validate"]);
const validate = workflow.jobs.validate;
const smokePack = workflow.jobs["smoke-pack"];

const setupNodeSteps = (job) => (job.steps ?? []).filter(
  (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"),
);
assert.equal(setupNodeSteps(validate).length, 1);
assert.equal(setupNodeSteps(validate)[0].with?.["node-version"], "24");
assert.equal(setupNodeSteps(smokePack).length, 0);

assert.equal(packageJson.engines?.node, ">=20.0.0");

const checkout = (smokePack.steps ?? []).find(
  (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
);
assert.ok(checkout);

const smokeStep = (smokePack.steps ?? []).find(
  (step) => step.name === "Smoke-test packaged artifact",
);
assert.ok(smokeStep);
assert.equal(smokeStep.env?.npm_config_engine_strict, "true");
assert.match(smokeStep.run, /npm pack --ignore-scripts/);
assert.match(smokeStep.run, /npm install --prefix/);
assert.match(smokeStep.run, /node_modules\/\.bin\/repo-guard/);

console.log("C3.8h manifest-governed smoke runtime contract passed");
