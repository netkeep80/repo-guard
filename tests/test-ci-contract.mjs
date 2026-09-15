import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { observeImmutable } from "./support/immutable-observation.mjs";

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
assert.equal(packageJson.scripts.prepack, "npm run build");

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

const prPolicyStep = validate.steps.find(
  (step) => step.name === "Run PR policy check",
);
assert.ok(prPolicyStep);
assert.equal(prPolicyStep.uses, "./");
assert.equal(prPolicyStep.with?.mode, "check-pr");
assert.equal(prPolicyStep.with?.enforcement, "blocking");

const checkoutStep = validate.steps.find(
  (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
);
assert.ok(checkoutStep);
assert.equal(checkoutStep.with?.["fetch-depth"], 1);
assert.doesNotMatch(workflowSource, /fetch-depth:\s*0/);

const evidenceStep = validate.steps.find((step) => step.name === "Acquire minimal Git evidence");
assert.ok(evidenceStep);
assert.equal(typeof evidenceStep.run, "string");
assert.match(evidenceStep.run, /github\.event_name/);
assert.match(evidenceStep.run, /--unshallow/);
assert.match(evidenceStep.run, /--no-tags/);
assert.match(evidenceStep.run, /refs\/heads\/\$\{\{ github\.base_ref \}\}:refs\/remotes\/origin\/\$\{\{ github\.base_ref \}\}/);
assert.match(evidenceStep.run, /refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge:refs\/remotes\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge/);
assert.match(evidenceStep.run, /refs\/heads\/\$\{\{ github\.ref_name \}\}:refs\/remotes\/origin\/\$\{\{ github\.ref_name \}\}/);
assert.doesNotMatch(evidenceStep.run, /refs\/heads\/\*/);
assert.doesNotMatch(evidenceStep.run, /92432809fcddc290080beb51ba151e13a5761869/);

const evidenceIndex = validate.steps.indexOf(evidenceStep);
for (const name of [
  "Report architecture compression metrics",
  "Run doctor diagnostics on self",
  "Run discovered test suite",
  "Run PR policy check",
]) {
  const index = validate.steps.findIndex((step) => step.name === name);
  assert.ok(index > evidenceIndex, `${name} must run after minimal Git evidence acquisition`);
}

const metrics = JSON.parse(observeImmutable(
  process.execPath,
  ["scripts/compression-metrics.mjs", "--ref", "HEAD"],
  { cwd: root },
));
assert.equal(metrics.ci.test_runs, 1);
assert.equal(metrics.ci.explicit_check_dist_runs, 1);
assert.equal(metrics.ci.effective_check_dist_runs, 1);
assert.equal(metrics.ci.npm_ci_runs, 1);
assert.equal(metrics.ci.full_history_checkouts, 0);

console.log("Current CI workflow/runtime contract passed");
