import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const workflowSource = readFileSync(
  resolve(root, ".github/workflows/ci.yml"),
  "utf8",
);
const workflowDocument = parseDocument(workflowSource);
assert.equal(workflowDocument.errors.length, 0);
const workflow = workflowDocument.toJS();

assert.deepEqual(Object.keys(workflow.jobs ?? {}).sort(), ["smoke-pack", "validate"]);

const validate = workflow.jobs?.validate;
const smokePack = workflow.jobs?.["smoke-pack"];
assert.ok(validate);
assert.ok(smokePack);

const explicitDistIndexes = validate.steps
  .map((step, index) => ({ step, index }))
  .filter(({ step }) => (
    typeof step.run === "string"
    && /\bnpm\s+run\s+check:dist\b/.test(step.run)
  ));
assert.equal(explicitDistIndexes.length, 1);

const testIndex = validate.steps.findIndex(
  (step) => step.name === "Run discovered test suite",
);
assert.ok(testIndex > explicitDistIndexes[0].index);
assert.equal(validate.steps[testIndex].run, "node tests/run.mjs");
assert.doesNotMatch(validate.steps[testIndex].run, /\bnpm\s+test\b/);

const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
assert.equal(packageJson.scripts.pretest, "npm run check:dist");
assert.equal(packageJson.scripts.test, "node tests/run.mjs");

const prPolicyStep = validate.steps.find(
  (step) => step.name === "Run PR policy check",
);
assert.ok(prPolicyStep);
assert.equal(prPolicyStep.uses, "./");
assert.equal(prPolicyStep.with?.mode, "check-pr");
assert.equal(prPolicyStep.with?.enforcement, "blocking");

console.log("C3.8a CI duplicate check-dist elimination contract passed");
