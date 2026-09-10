import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const workflowSource = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const workflowDocument = parseDocument(workflowSource);
assert.equal(workflowDocument.errors.length, 0);
const workflow = workflowDocument.toJS();

assert.deepEqual(Object.keys(workflow.jobs ?? {}).sort(), ["smoke-pack", "validate"]);
const validate = workflow.jobs?.validate;
const smokePack = workflow.jobs?.["smoke-pack"];
assert.ok(validate);
assert.ok(smokePack);

const npmCiSteps = (job) => (job.steps ?? []).filter((step) => step.run === "npm ci");
assert.equal(npmCiSteps(validate).length, 1);
assert.equal(npmCiSteps(smokePack).length, 0);

const smokeStep = smokePack.steps.find((step) => step.name === "Smoke-test packaged artifact");
assert.ok(smokeStep);
assert.match(smokeStep.run, /npm pack --ignore-scripts/);
assert.match(smokeStep.run, /npm install --prefix/);
assert.match(smokeStep.run, /node_modules\/\.bin\/repo-guard/);

const distStep = validate.steps.find((step) => step.name === "Verify generated dist freshness");
assert.ok(distStep);
assert.equal(distStep.run, "npm run check:dist");

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assert.equal(packageJson.scripts.prepack, "npm run build");

const metrics = JSON.parse(execFileSync(
  process.execPath,
  ["scripts/compression-metrics.mjs", "--ref", "HEAD"],
  { cwd: root, encoding: "utf8" },
));
assert.equal(metrics.ci.npm_ci_runs, 1);
assert.equal(metrics.ci.effective_check_dist_runs, 1);

console.log("C3.8d smoke-pack install/build dedup contract passed");
