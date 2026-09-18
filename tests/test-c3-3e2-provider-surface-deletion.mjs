import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { COMMANDS } from "../dist/repo-guard.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
const json = (path) => JSON.parse(read(path));

assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "init", "doctor"]);
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
assert.equal(Object.hasOwn(policy, "integration"), false, "self policy must not retain the deleted integration product container");
const schema = json("schemas/repo-policy.schema.json");
const validate = new Ajv({ allErrors: true }).compile(schema);
assert.equal(validate(policy), true);
assert.equal(validate({ ...policy, integration: {} }), false, "public schema must reject the deleted integration product surface");

const providerResiduePattern = [
  "portable-coordinator", "check-merge-group", "--parallel",
  "parallel-readiness", "parallel-doctor", "parallel-control-plane",
  "github-control-plane", "github-merge-group", "portable-integration",
  "repo_guard_portable_coordinator", "repo_guard_merge_group_gate",
].join("|");
let residue = "";
try {
  residue = execFileSync("git", [
    "grep", "-n", "-I", "-E", providerResiduePattern, "--", ".",
    ":(exclude)docs/superpowers/**",
    ":(exclude)tests/test-c3-3e2-provider-surface-deletion.mjs",
  ], { cwd: root, encoding: "utf-8" });
} catch (error) {
  if (error?.status !== 1) throw error;
  residue = error.stdout || "";
}
assert.equal(residue, "", `active provider residue must be zero outside historical docs/superpowers:\n${residue}`);

console.log("C3.3e E3b provider deletion contract passed.");
