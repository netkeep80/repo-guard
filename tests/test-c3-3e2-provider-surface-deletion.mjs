import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { computePolicyDelta } from "../dist/checks/rules/policy-delta-rules.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
const json = (path) => JSON.parse(read(path));

assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "init", "doctor", "validate-integration"]);
for (const path of [
  "src/parallel-readiness.mts", "src/parallel-doctor.mts", "src/parallel-control-plane.mts",
  "src/github-control-plane.mts", "src/github-merge-group.mts", "src/portable-integration/public-command.mts",
  ".github/workflows/repo-guard-portable-coordinator.yml",
]) assert.equal(existsSync(resolve(root, path)), false, `${path} must be deleted`);

const action = read("action.yml");
for (const token of ["portable-coordinator", "ready-label", "merge-method", "transaction-checks", "state-checks"]) {
  assert.equal(action.includes(token), false, `Action must not expose ${token}`);
}
const init = read("src/init.mts");
for (const token of ["ParallelProvider", "--parallel", "parallelIntegration", "portableCoordinatorWorkflow", "nativeMergeGroupWorkflow"]) {
  assert.equal(init.includes(token), false, `init must not expose ${token}`);
}

const policy = json("repo-policy.json");
assert.equal(policy.integration.workflows.some((item) => item.id === "repo-guard-portable-coordinator"), false);
const baseLike = structuredClone(policy);
baseLike.integration.workflows.push({
  id: "repo-guard-portable-coordinator", kind: "github_actions",
  path: ".github/workflows/repo-guard-portable-coordinator.yml",
  role: "repo_guard_portable_coordinator",
  expect: { enforcement: "blocking" },
});
const delta = computePolicyDelta(baseLike, policy).relaxations.map((item) => item.pointer);
assert.deepEqual(delta, ["/integration/workflows/repo-guard-portable-coordinator"]);

const schema = json("schemas/repo-policy.schema.json");
const validate = new Ajv({ allErrors: true }).compile(schema);
const invalid = structuredClone(policy);
invalid.integration.workflows.push({ id: "old-provider", kind: "github_actions", path: "x.yml", role: "repo_guard_portable_coordinator", expect: {} });
assert.equal(validate(invalid), false);
console.log("C3.3e E3b provider deletion contract passed.");
