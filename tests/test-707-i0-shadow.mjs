import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { evaluateRepoGuardNativeSelfHostShadowSnapshot, evaluateRepoGuardTrustedRootMigrationSnapshot, runPolicyPipeline, runPolicyPipelineShadow } from "../dist/runtime/pipeline.mjs";
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


const C25_BASE = "963c3539cea53ae88414116d762ec325af5f6838";
const C25_MIGRATION_HEAD = "5bd71de602ecce3295ff78beed74a7f4a8c4d7b1";
const C25_REPOSITORY = "netkeep80/repo-guard";
let c25Fetched = false;

function c25ProjectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
function c25Git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...options }).trim();
}
function c25EnsureMigrationObject() {
  if (c25Fetched) return;
  const root = c25ProjectRoot();
  c25Git(root, ["fetch", "--quiet", "origin", C25_MIGRATION_HEAD]);
  assert.equal(c25Git(root, ["rev-parse", C25_MIGRATION_HEAD]), C25_MIGRATION_HEAD);
  assert.equal(c25Git(root, ["rev-parse", C25_MIGRATION_HEAD + "^"]), C25_BASE);
  c25Fetched = true;
}
function c25Evaluate(overrides = {}) {
  c25EnsureMigrationObject();
  return evaluateRepoGuardTrustedRootMigrationSnapshot({
    repository: C25_REPOSITORY,
    repositoryRoot: c25ProjectRoot(),
    trustedAuthorityBaseRevision: C25_BASE,
    baseRevision: C25_BASE,
    headRevision: C25_MIGRATION_HEAD,
    ...overrides,
  });
}
function c25Receipt(prepared, overrides = {}) {
  return {
    repository: C25_REPOSITORY,
    authorityBaseRevision: C25_BASE,
    baseRevision: C25_BASE,
    headRevision: C25_MIGRATION_HEAD,
    permissions: [...prepared.requiredPermissions],
    ...overrides,
  };
}
function c25WithWorktree(mutator, body) {
  c25EnsureMigrationObject();
  const root = c25ProjectRoot();
  const worktree = mkdtempSync(join(tmpdir(), "repo-guard-c25-"));
  try {
    c25Git(root, ["worktree", "add", "--quiet", "--detach", worktree, C25_MIGRATION_HEAD]);
    mutator(worktree);
    c25Git(worktree, ["add", "-A"]);
    execFileSync("git", ["-c", "user.name=RepoGuard C2.5 test", "-c", "user.email=c2.5@example.invalid",
      "commit", "--quiet", "--allow-empty", "-m", "C2.5 adversarial snapshot"], { cwd: worktree, encoding: "utf8" });
    const headRevision = c25Git(worktree, ["rev-parse", "HEAD"]);
    return body({ worktree, headRevision });
  } finally {
    try { c25Git(root, ["worktree", "remove", "--force", worktree]); } catch {}
    rmSync(worktree, { recursive: true, force: true });
  }
}

test("C2.5 candidate roots remain RED without independent exact TRUST", () => {
  const result = c25Evaluate();
  assert.equal(result.ok, false);
  assert.equal(result.candidateReady, true, result.reasons.join(" | "));
  assert.equal(result.trust.authorized, false);
  assert.equal(result.authorized.j2.rooted, 0);
  assert.equal(result.authorized.j2.unrooted, 8);
  assert.ok(result.reasons.includes("C2.5:trust_receipt_missing"), result.reasons.join(" | "));
  assert.equal(result.blockingCutoverEligible, false);
  assert.equal(result.migration.length, 8);
  assert.equal(result.equivalence.rootIdentityChanges, 8);
});

test("C2.5 exact 8-root synthetic receipt proves the migration model but never blocking cutover", () => {
  const prepared = c25Evaluate();
  const result = c25Evaluate({ trustedRootReceipt: c25Receipt(prepared) });
  assert.equal(result.ok, true, result.reasons.join(" | "));
  assert.equal(result.trust.authorized, true);
  assert.equal(result.authorized.j2.rooted, 8);
  assert.equal(result.authorized.j2.unrooted, 0);
  assert.equal(result.authorized.j1.tracked, 359);
  assert.equal(result.authorized.j1.justified, 359);
  assert.equal(result.authorized.j1.unjustified, 0);
  assert.deepEqual(result.equivalence.relationCounts, {
    implemented_by: 143,
    verified_by: 169,
    documents: 50,
    total: 362,
  });
  assert.equal(result.equivalence.sharedOwnershipPaths, 11);
  assert.equal(result.equivalence.blanketRequiresProjected, 0);
  assert.equal(result.equivalence.normativeExact, true);
  assert.equal(result.equivalence.normativeDigestExact, true);
  assert.equal(result.equivalence.ownerEquivalentOnRetainedResources, true);
  assert.equal(result.blockingCutoverEligible, false);
  assert.equal(new Set(result.migration.map(x => x.oldTrustedSubject.digest)).size, 8);
  assert.equal(new Set(result.migration.map(x => x.newTrustedSubject.digest)).size, 8);
  console.log("C2.5_EVIDENCE=" + JSON.stringify({
    base: C25_BASE,
    head: C25_MIGRATION_HEAD,
    migration: result.migration,
    requiredPermissions: result.requiredPermissions,
    equivalence: result.equivalence,
    authorized: result.authorized,
  }));
});

test("C2.5 exact TRUST receipt rejects wrong subject/id, stale tuple, partial, wildcard and replay", () => {
  const prepared = c25Evaluate();
  const exact = c25Receipt(prepared);
  const mutatePermission = (index, transform) => {
    const permissions = [...exact.permissions];
    permissions[index] = transform(permissions[index]);
    return permissions;
  };
  const negatives = [
    ["wrong old subject", c25Receipt(prepared, { permissions: mutatePermission(0, p => p.replace(/[0-9a-f]{64}/, "0".repeat(64))) })],
    ["wrong new subject", c25Receipt(prepared, { permissions: mutatePermission(0, p => p.replace(/[0-9a-f]{64}$/, "f".repeat(64))) })],
    ["wrong RequirementId", c25Receipt(prepared, { permissions: mutatePermission(0, p => p.replace("RG-01", "RG-99")) })],
    ["stale authority base", c25Receipt(prepared, { authorityBaseRevision: "1".repeat(40) })],
    ["stale BASE", c25Receipt(prepared, { baseRevision: "2".repeat(40) })],
    ["stale HEAD", c25Receipt(prepared, { headRevision: "3".repeat(40) })],
    ["partial 7/8", c25Receipt(prepared, { permissions: exact.permissions.slice(0, 7) })],
    ["wildcard TRUST", c25Receipt(prepared, { permissions: ["*"] })],
    ["wrong repository", c25Receipt(prepared, { repository: "netkeep80/not-repo-guard" })],
  ];
  for (const [name, trustedRootReceipt] of negatives) {
    const result = c25Evaluate({ trustedRootReceipt });
    assert.equal(result.ok, false, name + " unexpectedly GREEN");
    assert.equal(result.trust.authorized, false, name + " unexpectedly authorized");
    assert.equal(result.authorized.j2.rooted, 0, name + " rooted candidate data");
  }

  c25WithWorktree(() => {}, ({ worktree, headRevision }) => {
    const replay = evaluateRepoGuardTrustedRootMigrationSnapshot({
      repository: C25_REPOSITORY,
      repositoryRoot: worktree,
      trustedAuthorityBaseRevision: C25_BASE,
      baseRevision: C25_BASE,
      headRevision,
      trustedRootReceipt: exact,
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.trust.authorized, false);
    assert.ok(replay.reasons.includes("C2.5:trust_head_mismatch"), replay.reasons.join(" | "));
  });
});

test("C2.5 candidate cannot mint roots, duplicate IDs, mutate normative authority or lose ownership", () => {
  const cases = [
    ["candidate trust field", (root) => {
      const path = join(root, "requirements/repo-guard/RG-01.rg.yaml");
      writeFileSync(path, readFileSync(path, "utf8") + "trusted: true\n");
    }, "C2.5:native_invalid"],
    ["duplicate native root", (root) => {
      const path = join(root, "requirements/repo-guard/RG-02.rg.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace(/^id: RG-02$/m, "id: RG-01"));
    }, "C2.5:native_invalid"],
    ["normative digest mismatch", (root) => {
      const path = join(root, "requirements/repo-guard/RG-01.rg.yaml");
      const lines = readFileSync(path, "utf8").split("\n");
      const index = lines.findIndex(line => line.startsWith("normative: "));
      const normative = JSON.parse(lines[index].slice("normative: ".length));
      lines[index] = "normative: " + JSON.stringify(normative + "\nUNAUTHORIZED");
      writeFileSync(path, lines.join("\n"));
    }, "C2.5:normative_mismatch"],
    ["ownership mismatch", (root) => {
      const path = join(root, "requirements/repo-guard/RG-01.rg.yaml");
      const lines = readFileSync(path, "utf8").split("\n");
      const start = lines.findIndex(line => line === "  - predicates: [implemented_by]");
      assert.ok(start > 0);
      lines.splice(start, 4);
      writeFileSync(path, lines.join("\n"));
    }, "C2.5:"],
  ];
  for (const [name, mutate, reasonPrefix] of cases) {
    c25WithWorktree(mutate, ({ worktree, headRevision }) => {
      const result = evaluateRepoGuardTrustedRootMigrationSnapshot({
        repository: C25_REPOSITORY,
        repositoryRoot: worktree,
        trustedAuthorityBaseRevision: C25_BASE,
        baseRevision: C25_BASE,
        headRevision,
      });
      assert.equal(result.ok, false, name + " unexpectedly GREEN");
      assert.equal(result.trust.authorized, false);
      assert.ok(result.reasons.some(reason => reason.startsWith(reasonPrefix)), name + ": " + result.reasons.join(" | "));
    });
  }
});

test("C2.5 rollback is a real repository transition restoring the exact accepted tree", () => {
  c25WithWorktree(() => {}, ({ worktree }) => {
    execFileSync("git", ["-c", "user.name=RepoGuard C2.5 test", "-c", "user.email=c2.5@example.invalid",
      "revert", "--quiet", "--no-edit", C25_MIGRATION_HEAD], { cwd: worktree, encoding: "utf8" });
    const rollback = c25Git(worktree, ["rev-parse", "HEAD"]);
    const baseTree = c25Git(worktree, ["rev-parse", C25_BASE + "^{tree}"]);
    const rollbackTree = c25Git(worktree, ["rev-parse", rollback + "^{tree}"]);
    assert.equal(rollbackTree, baseTree);
    const shadow = evaluateRepoGuardNativeSelfHostShadowSnapshot({
      repository: C25_REPOSITORY,
      revision: rollback,
      repositoryRoot: worktree,
    });
    assert.equal(shadow.ok, true, shadow.reasons.join(" | "));
    assert.equal(shadow.legacy.tracked, 359);
    assert.equal(shadow.legacy.justified, 359);
    assert.equal(shadow.native.tracked, 359);
    assert.equal(shadow.native.justified, 359);
  });
});
