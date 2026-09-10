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

const validate = workflow.jobs?.validate;
const smokePack = workflow.jobs?.["smoke-pack"];
assert.ok(validate);
assert.ok(smokePack);

const checkoutStep = validate.steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));
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
for (const name of ["Report architecture compression metrics", "Run doctor diagnostics on self", "Run discovered test suite", "Run PR policy check"]) {
  const index = validate.steps.findIndex((step) => step.name === name);
  assert.ok(index > evidenceIndex, `${name} must run after minimal Git evidence acquisition`);
}

const metrics = JSON.parse(execFileSync(
  process.execPath,
  ["scripts/compression-metrics.mjs", "--ref", "HEAD"],
  { cwd: root, encoding: "utf8" },
));
assert.equal(metrics.ci.full_history_checkouts, 0);
assert.equal(metrics.ci.effective_check_dist_runs, 1);
assert.equal(metrics.ci.npm_ci_runs, 1);

console.log("C3.8f minimal Git evidence contract passed");
