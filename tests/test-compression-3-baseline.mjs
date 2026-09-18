import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openingMain = "92432809fcddc290080beb51ba151e13a5761869";

const raw = execFileSync(process.execPath, ["scripts/compression-metrics.mjs", "--ref", openingMain], {
  cwd: repoRoot,
  encoding: "utf8",
});
const metrics = JSON.parse(raw);

assert.equal(metrics.ref, openingMain);
assert.deepEqual(metrics.physical.src, { files: 62, lines: 10471, bytes: 494446 });
assert.deepEqual(metrics.physical.schemas, { files: 3, lines: 1032, bytes: 38637 });
assert.deepEqual(metrics.physical.tests, { files: 89, lines: 12832, bytes: 542830 });
assert.equal(metrics.physical.docs.files, 7);
assert.equal(metrics.physical.docs.bytes, 35481);
assert.equal(metrics.physical.examples.files, 4);
assert.equal(metrics.physical.examples.bytes, 5986);

assert.equal(metrics.architecture.registered_rule_families, 6);
assert.deepEqual(metrics.architecture.document_relation_kinds, [
  "referenced_paths_exist",
  "referenced_pointer_exists",
  "scalar_equal",
  "scalar_equals_literal",
  "scalar_strictly_greater",
  "set_equal",
  "set_subset",
]);
assert.equal(metrics.architecture.document_selector_kinds, 4);
assert.equal(metrics.architecture.document_fact_types, 6);
assert.equal(metrics.architecture.relation_kernel_operations, 3);

assert.equal(metrics.policy.bytes, 7123);
assert.equal(metrics.policy.surfaces, 10);
assert.equal(metrics.policy.new_file_classes, 10);
assert.equal(metrics.policy.change_profiles, 5);

assert.equal(metrics.ci.jobs, 2);
assert.equal(metrics.ci.npm_ci_runs, 2);
assert.equal(metrics.ci.explicit_check_dist_runs, 1);
assert.equal(metrics.ci.effective_check_dist_runs, 2);
assert.equal(metrics.ci.test_runs, 1);
assert.equal(metrics.ci.full_history_checkouts, 1);

console.log("Compression 3 baseline metric contract passed.");
