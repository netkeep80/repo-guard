import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRepoGuardNativeSelfHostShadowSnapshot, runPolicyPipeline, runPolicyPipelineShadow } from "../dist/runtime/pipeline.mjs";
const input = {
  mode: "check-diff",
  repositoryRoot: "/tmp/rg-i0-fixture",
  policy: {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: { forbidden: ["secret/**"], governance_paths: [], canonical_docs: [], operational_paths: [] },
    diff_rules: { max_new_files: 10, max_new_docs: 10, max_net_added_lines: 100 },
    content_rules: [], cochange_rules: [],
  },
  changeIntent: null,
  changeIntentSource: "none",
  enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
  diffText: [
    "diff --git a/src/feature.mts b/src/feature.mts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/feature.mts",
    "+export const feature = true;",
  ].join("\n"),
  trackedFiles: ["src/feature.mts"],
};
const opts = { quiet: true };
const legacy = () => runPolicyPipeline(input, opts);
function compare(candidate, expected = false) {
  return runPolicyPipelineShadow(input, opts, candidate, expected);
}
test("#707 I0 same normalized observation, identical legacy report, no candidate control over verdict", () => {
  const plain = legacy();
  let count = 0;
  const observed = [];
  const shadow = compare((facts) => {
    count++;
    observed.push(facts.derived.changedPaths);
    return { ok: plain.ok, reasons: ["z", "a", "z"] };
  });
  assert.equal(count, 1);
  assert.deepEqual(observed, [["src/feature.mts"]]);
  assert.deepEqual(shadow.legacy, plain);
  assert.deepEqual(shadow.comparison, {
    legacy: { ok: plain.ok, blocking: plain.exitCode !== 0 },
    candidate: { ok: plain.ok, reasons: ["a", "z"] },
    identical: true,
    classification: "EQUIVALENT",
  });
});
test("#707 I0 unexpected and explicitly expected differences are machine-comparable, not merge-gating", () => {
  const plain = legacy();
  const opposite = () => ({ ok: !plain.ok, reasons: ["INTENTIONAL_RESEARCH_DIFFERENCE"] });
  const unexpected = compare(opposite);
  const expected = compare(opposite, true);
  assert.equal(unexpected.comparison.classification, "UNEXPECTED_DIFFERENCE");
  assert.equal(expected.comparison.classification, "EXPECTED_INTENTIONAL_DIFFERENCE");
  assert.deepEqual(expected.legacy, plain);
  assert.deepEqual(unexpected.legacy, plain);
  assert.equal(unexpected.comparison.identical, false);
});
test("#707 I0 candidate throw/invalid response cannot change existing enforced outcome", () => {
  const plain = legacy();
  const thrown = compare(() => { throw new Error("candidate failure"); });
  const invalid = compare(() => ({}));
  assert.deepEqual(thrown.legacy, plain);
  assert.deepEqual(invalid.legacy, plain);
  assert.match(thrown.comparison.candidate.reasons[0], /^SHADOW_EXECUTION_ERROR:/);
  assert.match(invalid.comparison.candidate.reasons[0], /^SHADOW_EXECUTION_ERROR:/);
});
test("#707 I0 no public policy field, schema or CLI toggle is required", () => {
  assert.equal("shadow" in input.policy, false);
  assert.equal("vnext" in input.policy, false);
  assert.deepEqual(runPolicyPipeline(input, opts), legacy());
});


test("C2.4 native RepoGuard self-host shadow is exact, closed, non-authoritative and legacy-free", () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const shadow = evaluateRepoGuardNativeSelfHostShadowSnapshot({
    repository: "netkeep80/repo-guard",
    revision,
    repositoryRoot: projectRoot,
  });

  assert.equal(shadow.ok, true, shadow.reasons.join(" | "));
  assert.equal(shadow.acceptedAuthorityVerified, false);
  assert.equal(shadow.blockingCutoverEligible, false);
  assert.equal(shadow.rootMigrationRequired, true);

  assert.equal(shadow.legacy.tracked, 359);
  assert.equal(shadow.legacy.justified, 359);
  assert.equal(shadow.native.tracked, 359);
  assert.equal(shadow.native.justified, 359);
  assert.equal(shadow.native.rooted, 8);
  assert.equal(shadow.native.unrooted, 0);

  assert.equal(shadow.equivalence.normativeExact, true);
  assert.equal(shadow.equivalence.ownerEquivalentOnRetainedResources, true);
  assert.equal(shadow.equivalence.sharedOwnershipPaths, 11);
  assert.deepEqual(shadow.equivalence.relationCounts, {
    implemented_by: 143,
    verified_by: 169,
    documents: 50,
    total: 362,
  });
  assert.equal(shadow.equivalence.blanketRequiresProjected, 0);
  assert.equal(shadow.equivalence.rootIdentityChanges, 8);

  assert.deepEqual(shadow.sourceMigration.from, [
    "requirements/repo-guard/RG-01.yaml",
    "requirements/repo-guard/RG-02.yaml",
    "requirements/repo-guard/RG-03.yaml",
    "requirements/repo-guard/RG-04.yaml",
    "requirements/repo-guard/RG-05.yaml",
    "requirements/repo-guard/RG-06.yaml",
    "requirements/repo-guard/RG-07.yaml",
    "requirements/repo-guard/RG-08.yaml",
  ]);
  assert.deepEqual(shadow.sourceMigration.to, [
    "requirements/repo-guard/RG-01.rg.yaml",
    "requirements/repo-guard/RG-02.rg.yaml",
    "requirements/repo-guard/RG-03.rg.yaml",
    "requirements/repo-guard/RG-04.rg.yaml",
    "requirements/repo-guard/RG-05.rg.yaml",
    "requirements/repo-guard/RG-06.rg.yaml",
    "requirements/repo-guard/RG-07.rg.yaml",
    "requirements/repo-guard/RG-08.rg.yaml",
  ]);
});
