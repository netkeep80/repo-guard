import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const yaml = (path) => {
  const doc = parseDocument(read(path));
  assert.deepEqual(doc.errors, [], `${path}: invalid YAML`);
  return doc.toJS();
};

const ci = yaml(".github/workflows/ci.yml");
assert.deepEqual(Object.keys(ci.jobs ?? {}).sort(), ["smoke-pack", "validate"]);
assert.deepEqual(ci.permissions, { contents: "read" });
assert.deepEqual([...(ci.on?.pull_request?.types ?? [])].sort(), ["edited", "opened", "ready_for_review", "reopened", "synchronize"]);

const validate = ci.jobs.validate;
const names = (validate.steps ?? []).map((step) => step.name).filter(Boolean);
for (const name of [
  "Acquire minimal Git evidence",
  "Verify generated dist freshness",
  "Verify real local documentation projections",
  "Run compiler-only self-host witness",
  "Run discovered test suite",
]) assert.ok(names.includes(name), `missing CI step ${name}`);
for (const retired of [
  "Validate repo-policy.json",
  "Run doctor diagnostics on self",
  "Exercise advisory policy mode",
  "Report architecture compression metrics",
]) assert.equal(names.includes(retired), false, `retired CI step remains: ${retired}`);

const workflowText = read(".github/workflows/ci.yml");
for (const token of ["repo-policy.json", "check-diff", "--enforcement", "doctor"]) {
  assert.equal(workflowText.includes(token), false, `CI still exposes legacy token ${token}`);
}

const smoke = ci.jobs["smoke-pack"].steps.find((step) => step.name === "Smoke-test packaged artifact");
assert.ok(smoke);
assert.match(smoke.run, /repo-guard.*check/s);
assert.match(smoke.run, /--base/);
assert.match(smoke.run, /--head/);

const gate = yaml(".github/workflows/compiler-gate.yml");
const gateSteps = gate.jobs?.["compiler-gate"]?.steps ?? [];
assert.ok(gateSteps.some((step) => step.with?.ref === "${{ github.event.pull_request.base.sha }}"));
assert.ok(gateSteps.some((step) => /node dist\/repo-guard\.mjs check/.test(step.run ?? "")));

console.log("Current compiler-only CI contract passed");
