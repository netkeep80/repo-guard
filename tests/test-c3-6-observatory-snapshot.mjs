import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  collectObservatorySnapshot,
  stableJson,
} from "../scripts/observatory/collect.mjs";

const repoRoot = resolve(".");
const acceptedSha = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: repoRoot, encoding: "utf8" },
).trim();

const release404 = async () => ({
  status: 404,
  ok: false,
  async json() { return {}; },
});

const input = {
  repoRoot,
  acceptedSha,
  ci: {
    workflow: "CI",
    run_id: 123,
    run_url: "https://example.invalid/runs/123",
    conclusion: "success",
  },
  repository: "netkeep80/repo-guard",
  token: "test-token",
  fetchImpl: release404,
};

const first = await collectObservatorySnapshot(input);
const second = await collectObservatorySnapshot(input);

assert.equal(first.schema_version, 1);
assert.equal(first.accepted.sha, acceptedSha);
assert.equal(first.accepted.ci.conclusion, "success");
assert.equal(first.version.package_version, "2.0.0");
assert.equal(first.version.matching_release_tag, "v2.0.0");
assert.equal(first.version.matching_published_release, false);
assert.equal(first.version.release_truth_status, "package_only");

assert.deepEqual(
  first.architecture.current.architecture.canonical_fact_sources,
  ["change_intent", "diff", "document", "repository"],
);
assert.deepEqual(
  first.architecture.current.architecture.runtime_constraint_kind_names,
  ["primitive_relation"],
);
assert.equal(
  first.architecture.current.architecture.primitive_descriptor_registry_count,
  1,
);

assert.equal(first.scenarios.length, 5);
assert.deepEqual(
  first.scenarios.map((item) => item.id).sort(),
  [
    "contract-evidence",
    "governance-cutover",
    "minimal-diff-policy",
    "surgical-change",
    "version-transition",
  ],
);
assert.ok(first.scenarios.every((item) => item.cases.length === 2));

assert.ok(first.policy.constraint_program.length > 0);
assert.ok(
  first.policy.constraint_program
    .filter((entry) => entry.runtime)
    .every((entry) => entry.runtime.kind === "primitive_relation"),
);

assert.equal(stableJson(first), stableJson(second));
assert.ok(!stableJson(first).includes(repoRoot));

const policy = JSON.parse(
  readFileSync(resolve(repoRoot, "repo-policy.json"), "utf8"),
);
assert.deepEqual(first.policy.accepted, policy);

console.log("C3.6 Observatory snapshot contract passed");
