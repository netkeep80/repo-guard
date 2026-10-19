import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseYaml } from "../dist/document-facts.mjs";
import { classifyRepoGuardSelfHostRepresentation, evaluateRepoGuardNativeBlockingSnapshot, evaluateRepoGuardNativeRollbackSnapshot, evaluateRepoGuardNativeSelfHostShadowSnapshot, evaluateRepoGuardTrustedRootMigrationSnapshot, selectRepoGuardAuthoritativeEvaluator, runPolicyPipeline, runPolicyPipelineShadow } from "../dist/runtime/pipeline.mjs";
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
  const representationPaths = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", "requirements/repo-guard"], {
    cwd: projectRoot, encoding: "utf8",
  }).split("\n").filter(Boolean);
  const legacyCount = representationPaths.filter((path) => /^requirements\/repo-guard\/RG-\d\d\.yaml$/.test(path)).length;
  const nativeCount = representationPaths.filter((path) => /^requirements\/repo-guard\/RG-\d\d\.rg\.yaml$/.test(path)).length;
  assert.ok(
    (legacyCount === 8 && nativeCount === 0) || (legacyCount === 0 && nativeCount === 8),
    `C2.4/C2.5 self-host representation must be exact 8/0 or 0/8; got legacy=${legacyCount}, native=${nativeCount}`,
  );
  if (nativeCount === 8) {
    console.log("C2.4 shadow is historical after exact native root representation becomes active; native semantic inventory is enforced by test-645.");
    return;
  }
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


/* C2.5_GATE_BRIDGE_TEST */
const c25Repository = "netkeep80/repo-guard";
const c25ExpectedIds = Array.from({ length: 8 }, (_value, index) => "RG-" + String(index + 1).padStart(2, "0"));
const c25LegacyToNativePredicate = Object.freeze({
  implements: "implemented_by",
  verifies: "verified_by",
  documents: "documents",
});

function c25Git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function c25NativeTextById(root) {
  const docs = readFileSync(join(root, "docs/product-requirements.md"), "utf8");
  const sections = new Map();
  let current = null;
  for (const line of docs.split(/\r?\n/)) {
    const match = line.match(/^###\s+(RG-[0-9]{2})\s+—/);
    if (match) {
      current = match[1];
      if (sections.has(current)) throw new Error("duplicate normative heading " + current);
      sections.set(current, [line]);
      continue;
    }
    if (current && /^#{1,3}\s+/.test(line)) current = null;
    if (current) sections.get(current).push(line);
  }
  return Object.fromEntries(c25ExpectedIds.map((id) => {
    const lines = sections.get(id);
    assert.ok(lines, "missing normative section " + id);
    return [id, lines.join("\n")];
  }));
}

function c25WriteNativeMigration(root) {
  const normative = c25NativeTextById(root);
  for (const id of c25ExpectedIds) {
    const oldPath = join(root, "requirements/repo-guard", id + ".yaml");
    const newPath = join(root, "requirements/repo-guard", id + ".rg.yaml");
    const legacy = parseYaml(readFileSync(oldPath, "utf8"));
    assert.equal(legacy.id, id);
    assert.ok(Array.isArray(legacy.artifacts));
    const grouped = new Map();
    for (const artifact of legacy.artifacts) {
      assert.equal(typeof artifact.path, "string");
      assert.ok(Array.isArray(artifact.relations));
      const predicates = artifact.relations
        .filter((predicate) => predicate !== "requires")
        .map((predicate) => {
          const mapped = c25LegacyToNativePredicate[predicate];
          assert.ok(mapped, id + ": unsupported legacy predicate " + predicate);
          return mapped;
        });
      if (!predicates.length) {
        assert.equal(
          artifact.path,
          "requirements/repo-guard/" + id + ".yaml",
          id + ": non-self requires-only artifact cannot disappear",
        );
        continue;
      }
      const set = grouped.get(artifact.path) || new Set();
      predicates.forEach((predicate) => set.add(predicate));
      grouped.set(artifact.path, set);
    }
    const lines = [
      "format: repo-guard/requirement-v1",
      "id: " + id,
      "normative: " + JSON.stringify(normative[id]),
    ];
    if (grouped.size) lines.push("relations:");
    for (const path of [...grouped.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
      const predicates = [...grouped.get(path)].sort((a, b) => a.localeCompare(b, "en"));
      lines.push(
        "  - predicates: [" + predicates.join(", ") + "]",
        "    target:",
        "      kind: artifact",
        "      path: " + JSON.stringify(path),
      );
    }
    lines.push("");
    writeFileSync(newPath, lines.join("\n"));
    unlinkSync(oldPath);
  }
}

function c25RepresentationCounts(cwd, revision) {
  const paths = c25Git(cwd, ["ls-tree", "-r", "--name-only", revision, "--", "requirements/repo-guard"])
    .split("\n").filter(Boolean);
  return {
    legacy: paths.filter((path) => /^requirements\/repo-guard\/RG-\d\d\.yaml$/.test(path)).length,
    native: paths.filter((path) => /^requirements\/repo-guard\/RG-\d\d\.rg\.yaml$/.test(path)).length,
  };
}

function c25LatestLegacyBase(projectRoot) {
  const head = c25Git(projectRoot, ["rev-parse", "HEAD"]);
  for (const revision of c25Git(projectRoot, ["rev-list", "--first-parent", head]).split("\n").filter(Boolean)) {
    const counts = c25RepresentationCounts(projectRoot, revision);
    if (counts.legacy === 8 && counts.native === 0) return revision;
    if (!((counts.legacy === 0 && counts.native === 8) || (counts.legacy === 8 && counts.native === 0))) {
      throw new Error(`C2.5 invalid historical representation at ${revision}: legacy=${counts.legacy}, native=${counts.native}`);
    }
  }
  throw new Error("C2.5 legacy migration base not found in first-parent history");
}

function c25Fixture(body) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const clone = mkdtempSync(join(tmpdir(), "repo-guard-c25-gate-"));
  try {
    execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", projectRoot, clone], { encoding: "utf8" });
    c25Git(clone, ["config", "user.email", "c2.5-gate@example.invalid"]);
    c25Git(clone, ["config", "user.name", "C2.5 Gate Bridge"]);
    const base = c25LatestLegacyBase(projectRoot);
    c25Git(clone, ["checkout", "-q", base]);
    c25WriteNativeMigration(clone);
    c25Git(clone, ["add", "-A"]);
    c25Git(clone, ["commit", "-q", "-m", "C2.5 native migration fixture"]);
    const head = c25Git(clone, ["rev-parse", "HEAD"]);
    symlinkSync(join(projectRoot, "node_modules"), join(clone, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    return body({ root: clone, base, head });
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

function c25Prepared(root, base, head, trustedRootReceipt = null) {
  return evaluateRepoGuardTrustedRootMigrationSnapshot({
    repository: c25Repository,
    repositoryRoot: root,
    trustedAuthorityBaseRevision: base,
    baseRevision: base,
    headRevision: head,
    trustedRootReceipt,
  });
}

function c25ExactGrant(prepared, base, head, overrides = {}) {
  return {
    repository: c25Repository,
    authority_base_sha: base,
    base_sha: base,
    head_sha: head,
    permissions: [...prepared.requiredPermissions],
    ...overrides,
  };
}

function c25ReceiptFromGrant(grant) {
  return {
    repository: grant.repository,
    authorityBaseRevision: grant.authority_base_sha,
    baseRevision: grant.base_sha,
    headRevision: grant.head_sha,
    permissions: grant.permissions,
  };
}

test("C2.5 gate bridge: native self-host inventory is semantic and legacy-free", () => {
  c25Fixture(({ root, base, head }) => {
    const inventory = spawnSync(process.execPath, [join(root, "tests/test-645-self-host-relation-inventory.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.equal(inventory.status, 0, inventory.stdout + "\n" + inventory.stderr);

    const prepared = c25Prepared(root, base, head);
    assert.equal(prepared.candidateReady, true, prepared.reasons.join(" | "));
    assert.equal(prepared.ok, false);
    assert.equal(prepared.trust.authorized, false);
    assert.equal(prepared.candidate.j2.rooted, 8);
    assert.equal(prepared.candidate.j2.unrooted, 0);
    assert.equal(prepared.candidate.j1.tracked, 359);
    assert.equal(prepared.candidate.j1.justified, 359);
    assert.equal(prepared.candidate.j1.unjustified, 0);
    assert.deepEqual(prepared.equivalence.relationCounts, {
      implemented_by: 143,
      verified_by: 169,
      documents: 50,
      total: 362,
    });
    assert.equal(prepared.equivalence.sharedOwnershipPaths, 11);
    assert.equal(prepared.equivalence.blanketRequiresProjected, 0);
    assert.equal(prepared.equivalence.normativeExact, true);
    assert.equal(prepared.equivalence.normativeDigestExact, true);
    assert.equal(prepared.equivalence.ownerEquivalentOnRetainedResources, true);
  });
});

test("C2.5 gate bridge: exact independent native root receipt GREEN; stale/partial/wildcard/duplicate/replay RED", async () => {
  const { evaluateTrustedRootTransitionBoundary } = await import("../dist/github-pr.mjs");
  c25Fixture(({ root, base, head }) => {
    const prepared = c25Prepared(root, base, head);
    const exact = c25ExactGrant(prepared, base, head);
    const trustedAuthorizer = { trusted: true, source: "repository_permission" };

    const positive = evaluateTrustedRootTransitionBoundary({
      governanceGrant: { trusted_root_transition: exact },
      trustedAuthorizer,
      repository: c25Repository,
      repositoryRoot: root,
      baseRevision: base,
      headRevision: head,
    });
    assert.ok(positive);
    assert.equal(positive.ok, true, positive.reasons.join(" | "));
    assert.equal(positive.evaluation.authorized.j2.rooted, 8);
    assert.equal(positive.evaluation.authorized.j2.unrooted, 0);
    assert.equal(positive.evaluation.authorized.j1.justified, 359);

    const permissionMutation = (index, transform) => {
      const permissions = [...exact.permissions];
      permissions[index] = transform(permissions[index]);
      return permissions;
    };
    const negatives = [
      ["untrusted source", exact, { trusted: false, source: "repository_permission" }],
      ["wrong repository", { ...exact, repository: "netkeep80/not-repo-guard" }, trustedAuthorizer],
      ["wrong authority base", { ...exact, authority_base_sha: "1".repeat(40) }, trustedAuthorizer],
      ["wrong BASE", { ...exact, base_sha: "2".repeat(40) }, trustedAuthorizer],
      ["wrong HEAD", { ...exact, head_sha: "3".repeat(40) }, trustedAuthorizer],
      ["wrong RequirementId", { ...exact, permissions: permissionMutation(0, (p) => p.replace("RG-01", "RG-99")) }, trustedAuthorizer],
      ["wrong old digest", { ...exact, permissions: permissionMutation(0, (p) => p.replace(/[0-9a-f]{64}/, "0".repeat(64))) }, trustedAuthorizer],
      ["wrong new digest", { ...exact, permissions: permissionMutation(0, (p) => p.replace(/[0-9a-f]{64}$/, "f".repeat(64))) }, trustedAuthorizer],
      ["partial 7/8", { ...exact, permissions: exact.permissions.slice(0, 7) }, trustedAuthorizer],
      ["wildcard", { ...exact, permissions: ["*"] }, trustedAuthorizer],
      ["duplicate", { ...exact, permissions: [...exact.permissions.slice(0, 7), exact.permissions[0]] }, trustedAuthorizer],
      ["extra unrelated root", { ...exact, permissions: [...exact.permissions, "trusted_root:RG-99:" + "a".repeat(64) + ":" + "b".repeat(64)] }, trustedAuthorizer],
    ];
    for (const [name, grant, authorizer] of negatives) {
      const verdict = evaluateTrustedRootTransitionBoundary({
        governanceGrant: { trusted_root_transition: grant },
        trustedAuthorizer: authorizer,
        repository: c25Repository,
        repositoryRoot: root,
        baseRevision: base,
        headRevision: head,
      });
      assert.ok(verdict);
      assert.equal(verdict.ok, false, name + " unexpectedly GREEN");
    }

    c25Git(root, ["commit", "--allow-empty", "-q", "-m", "replay head"]);
    const replayHead = c25Git(root, ["rev-parse", "HEAD"]);
    const replay = evaluateTrustedRootTransitionBoundary({
      governanceGrant: { trusted_root_transition: exact },
      trustedAuthorizer,
      repository: c25Repository,
      repositoryRoot: root,
      baseRevision: base,
      headRevision: replayHead,
    });
    assert.ok(replay);
    assert.equal(replay.ok, false);
    assert.ok(replay.reasons.includes("C2.5:trust_head_mismatch"), replay.reasons.join(" | "));
  });
});

test("C2.5 gate bridge: representation/J1/J2/relation/ownership/self-trust falsifiers stay RED", () => {
  c25Fixture(({ root, base, head }) => {
    const reset = () => {
      c25Git(root, ["reset", "--hard", "-q", head]);
      c25Git(root, ["clean", "-fdq"]);
    };
    const commitMutation = (name, mutate) => {
      reset();
      mutate();
      c25Git(root, ["add", "-A"]);
      c25Git(root, ["commit", "-q", "-m", name]);
      return c25Git(root, ["rev-parse", "HEAD"]);
    };
    const evaluateMutation = (name, mutate, reason) => {
      const mutatedHead = commitMutation(name, mutate);
      const verdict = c25Prepared(root, base, mutatedHead);
      assert.equal(verdict.ok, false, name + " unexpectedly GREEN");
      assert.equal(verdict.candidateReady, false, name + " candidate unexpectedly ready");
      assert.ok(verdict.reasons.some((item) => item.startsWith(reason)), name + ": " + verdict.reasons.join(" | "));
    };

    evaluateMutation("missing native representation", () => {
      unlinkSync(join(root, "requirements/repo-guard/RG-08.rg.yaml"));
    }, "C2.5:native_source_set_mismatch");

    evaluateMutation("mixed incomplete representation", () => {
      const old = execFileSync("git", ["show", base + ":requirements/repo-guard/RG-08.yaml"], { cwd: root, encoding: "utf8" });
      writeFileSync(join(root, "requirements/repo-guard/RG-08.yaml"), old);
    }, "C2.5:legacy_source_still_active");

    evaluateMutation("candidate authored trust field", () => {
      const path = join(root, "requirements/repo-guard/RG-01.rg.yaml");
      writeFileSync(path, readFileSync(path, "utf8") + "trusted: true\n");
    }, "C2.5:native_invalid");

    evaluateMutation("native J2 duplicate identity mismatch", () => {
      const path = join(root, "requirements/repo-guard/RG-08.rg.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace(/^id: RG-08$/m, "id: RG-07"));
    }, "C2.5:candidate_j2_not_rooted");

    evaluateMutation("native J1 mismatch", () => {
      writeFileSync(join(root, "unowned-c25.txt"), "unowned\n");
    }, "C2.5:tracked_count_mismatch");

    evaluateMutation("relation and ownership drift", () => {
      const path = join(root, "requirements/repo-guard/RG-01.rg.yaml");
      const lines = readFileSync(path, "utf8").split("\n");
      const start = lines.findIndex((line) => line === "  - predicates: [implemented_by]");
      assert.ok(start > 0);
      lines.splice(start, 4);
      writeFileSync(path, lines.join("\n"));
    }, "C2.5:relation_count_mismatch");

    evaluateMutation("blanket requires reintroduced", () => {
      const path = join(root, "requirements/repo-guard/RG-01.rg.yaml");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace("predicates: [implemented_by]", "predicates: [implemented_by, requires]"),
      );
    }, "C2.5:blanket_requires_projected");

    reset();
  });
});


/* A1_ATOMIC_NATIVE_SELECTOR_TEST */
test("A1 selector is trusted-BASE controlled, fail-closed and never either-GREEN", () => {
  const pick = (baseRepresentation, headRepresentation, forwardAuthorized = false, rollbackAuthorized = false) =>
    selectRepoGuardAuthoritativeEvaluator({ baseRepresentation, headRepresentation, forwardAuthorized, rollbackAuthorized });

  assert.deepEqual(pick("legacy", "legacy"), { ok: true, evaluator: "legacy", transition: "steady" });
  assert.equal(pick("legacy", "native").ok, false);
  assert.equal(pick("legacy", "native", true).evaluator, "native");
  assert.equal(pick("legacy", "native", true).transition, "forward_cutover");
  assert.deepEqual(pick("native", "native"), { ok: true, evaluator: "native", transition: "steady" });
  assert.equal(pick("native", "legacy").ok, false);
  assert.equal(pick("native", "legacy", false, true).evaluator, "legacy");
  assert.equal(pick("native", "legacy", false, true).transition, "rollback");
  for (const pair of [["mixed", "native"], ["legacy", "mixed"], ["unknown", "native"], ["native", "unknown"]])
    assert.equal(pick(pair[0], pair[1], true, true).ok, false, pair.join(" -> ") + " must be RED");

  // There is deliberately no candidate-controlled selector parameter.
  assert.equal(pick("legacy", "native", false, false).evaluator, undefined);
});

test("A1 real-Git forward cutover boundary requires exact roots AND atomic permission", async () => {
  const { evaluateAtomicNativeCutoverBoundary } = await import("../dist/github-pr.mjs");
  c25Fixture(({ root, base, head }) => {
    assert.equal(classifyRepoGuardSelfHostRepresentation(root, base).kind, "legacy");
    assert.equal(classifyRepoGuardSelfHostRepresentation(root, head).kind, "native");

    const prepared = c25Prepared(root, base, head);
    assert.equal(prepared.candidateReady, true, prepared.reasons.join(" | "));
    const exact = c25ExactGrant(prepared, base, head);
    const trustedAuthorizer = { trusted: true, source: "repository_permission" };

    const noGrant = evaluateAtomicNativeCutoverBoundary({
      governanceGrant: null, trustedAuthorizer, repository: c25Repository,
      repositoryRoot: root, baseRevision: base, headRevision: head,
    });
    assert.equal(noGrant.ok, false);

    const rootsOnly = evaluateAtomicNativeCutoverBoundary({
      governanceGrant: { trusted_root_transition: exact }, trustedAuthorizer, repository: c25Repository,
      repositoryRoot: root, baseRevision: base, headRevision: head,
    });
    assert.equal(rootsOnly.ok, false);
    assert.equal(rootsOnly.rootAuthorized, true);
    assert.equal(rootsOnly.atomicAuthorized, false);

    const atomicOnly = evaluateAtomicNativeCutoverBoundary({
      governanceGrant: { allow_atomic_governance_cutover: true }, trustedAuthorizer, repository: c25Repository,
      repositoryRoot: root, baseRevision: base, headRevision: head,
    });
    assert.equal(atomicOnly.ok, false);

    const exactAtomic = evaluateAtomicNativeCutoverBoundary({
      governanceGrant: { trusted_root_transition: exact, allow_atomic_governance_cutover: true },
      trustedAuthorizer, repository: c25Repository, repositoryRoot: root, baseRevision: base, headRevision: head,
    });
    assert.equal(exactAtomic.ok, true, exactAtomic.reasons.join(" | "));

    const selected = selectRepoGuardAuthoritativeEvaluator({
      baseRepresentation: "legacy", headRepresentation: "native",
      forwardAuthorized: exactAtomic.ok, rollbackAuthorized: false,
    });
    assert.deepEqual(selected, { ok: true, evaluator: "native", transition: "forward_cutover" });

    // Post-transition native state is independently executable through the production J2/J1/J3 composition.
    const native = evaluateRepoGuardNativeBlockingSnapshot({
      repository: c25Repository, repositoryRoot: root,
      trustedAuthorityBaseRevision: head, baseRevision: head, headRevision: head,
      workIntent: null,
      trustedReceipts: [],
      protectedResources: [],
      evidenceFacts: [],
      observationFacts: [],
      authenticatedProviderGrants: [],
    });
    assert.equal(native.ok, true, native.reasons.join(" | "));
    assert.equal(native.providerCapabilityMode, true);
    assert.equal(native.j2.rooted, 8);
    assert.equal(native.j2.unrooted, 0);
    assert.equal(native.j1.tracked, 359);
    assert.equal(native.j1.unjustified, 0);
    assert.equal(native.j3.ok, true);
  });
});

test("A1 native steady-state executes J3 and cannot fall back to legacy GREEN", () => {
  c25Fixture(({ root, head }) => {
    const base = head;
    const nativeDoc = parseYaml(readFileSync(join(root, "requirements/repo-guard/RG-01.rg.yaml"), "utf8"));
    const target = nativeDoc.relations.find((relation) =>
      relation.predicates.includes("implemented_by") && relation.target.path.startsWith("src/")).target.path;
    writeFileSync(join(root, target), readFileSync(join(root, target), "utf8") + "\nA1 steady-state fixture\n");
    c25Git(root, ["add", "--", target]);
    c25Git(root, ["commit", "-q", "-m", "A1 native steady-state resource change"]);
    const next = c25Git(root, ["rev-parse", "HEAD"]);

    const green = evaluateRepoGuardNativeBlockingSnapshot({
      repository: c25Repository, repositoryRoot: root,
      trustedAuthorityBaseRevision: base, baseRevision: base, headRevision: next,
      workIntent: { id: "a1-steady", addresses: ["RG-01"] },
      trustedReceipts: [], protectedResources: [], evidenceFacts: [], observationFacts: [],
      authenticatedProviderGrants: [],
    });
    assert.equal(green.ok, true, green.reasons.join(" | "));
    assert.equal(green.j3.ok, true);

    const red = evaluateRepoGuardNativeBlockingSnapshot({
      repository: c25Repository, repositoryRoot: root,
      trustedAuthorityBaseRevision: base, baseRevision: base, headRevision: next,
      workIntent: { id: "a1-steady", addresses: [] },
      trustedReceipts: [], protectedResources: [], evidenceFacts: [], observationFacts: [],
      authenticatedProviderGrants: [],
    });
    assert.equal(red.ok, false);
    assert.ok(red.reasons.some((reason) => reason.includes("J3:no_cause")), red.reasons.join(" | "));

    const selected = selectRepoGuardAuthoritativeEvaluator({
      baseRepresentation: "native", headRepresentation: "native",
      forwardAuthorized: false, rollbackAuthorized: false,
    });
    assert.deepEqual(selected, { ok: true, evaluator: "native", transition: "steady" });
    // A hypothetical legacy GREEN is not an input to selector and cannot alter native RED.
    assert.equal(red.ok, false);
  });
});

test("A1 native provider capability mode is structurally forced and exact", () => {
  c25Fixture(({ root, head }) => {
    const nativePath = join(root, "requirements/repo-guard/RG-01.rg.yaml");
    const nativeDoc = parseYaml(readFileSync(nativePath, "utf8"));
    const target = nativeDoc.relations.find((relation) =>
      relation.predicates.includes("implemented_by") && relation.target.path.startsWith("src/")).target.path;
    const verifier = nativeDoc.relations.find((relation) => relation.predicates.includes("verified_by")).target.path;
    writeFileSync(nativePath, readFileSync(nativePath, "utf8") + [
      "constraints:",
      "  - id: a1-lines",
      "    scope:",
      "      relations: [implemented_by]",
      "    metric:",
      "      key: git.changed_lines",
      "      max: 1000",
      "  - id: a1-execution",
      "    scope:",
      "      relations: [implemented_by]",
      "    evidence:",
      "      class: execution",
      "      key: tests:a1",
      "      verifier:",
      "        kind: artifact",
      "        path: " + JSON.stringify(verifier),
      "",
    ].join("\n"));
    c25Git(root, ["add", "--", "requirements/repo-guard/RG-01.rg.yaml"]);
    c25Git(root, ["commit", "-q", "-m", "A1 accepted provider-constraint fixture"]);
    const base = c25Git(root, ["rev-parse", "HEAD"]);

    writeFileSync(join(root, target), readFileSync(join(root, target), "utf8") + "\nA1 provider fixture\n");
    c25Git(root, ["add", "--", target]);
    c25Git(root, ["commit", "-q", "-m", "A1 provider-observed change"]);
    const next = c25Git(root, ["rev-parse", "HEAD"]);
    const workIntent = { id: "a1-provider", addresses: ["RG-01"] };

    const missing = evaluateRepoGuardNativeBlockingSnapshot({
      repository: c25Repository, repositoryRoot: root,
      trustedAuthorityBaseRevision: base, baseRevision: base, headRevision: next,
      workIntent, trustedReceipts: [], protectedResources: [],
      evidenceFacts: [], observationFacts: [],
      authenticatedProviderGrants: [],
    });
    assert.equal(missing.providerCapabilityMode, true);
    assert.equal(missing.ok, false);
    assert.ok(missing.reasons.some((reason) => reason.includes("missing_observation")), missing.reasons.join(" | "));
    assert.ok(missing.reasons.some((reason) => reason.includes("missing_evidence")), missing.reasons.join(" | "));

    const observationFact = {
      authorityBaseRevision: base, baseRevision: base, headRevision: next,
      path: target, metric: "changed_lines", value: 1, providerId: "obs-a1",
    };
    const evidenceFact = {
      authorityBaseRevision: base, baseRevision: base, headRevision: next,
      key: "tests:a1", status: "pass", providerId: "domain-a1", requirementId: "RG-01",
      subjectPaths: [target], verifierPath: verifier, verifierRevision: next,
    };
    const observationGrant = {
      repository: c25Repository, authorityBaseRevision: base, baseRevision: base, headRevision: next,
      providerId: "obs-a1", principal: "app:observation", producerSource: base, boundary: "observation",
      capability: { kind: "metric", key: "git.changed_lines", subjectPaths: [target] },
    };
    const domainGrant = {
      repository: c25Repository, authorityBaseRevision: base, baseRevision: base, headRevision: next,
      providerId: "domain-a1", principal: "app:domain", producerSource: base, boundary: "domain",
      capability: {
        kind: "evidence", class: "execution", key: "tests:a1", requirementId: "RG-01",
        subjectPaths: [target], verifierPath: verifier, verifierRevision: next,
      },
    };
    const exact = (grants = [observationGrant, domainGrant]) => evaluateRepoGuardNativeBlockingSnapshot({
      repository: c25Repository, repositoryRoot: root,
      trustedAuthorityBaseRevision: base, baseRevision: base, headRevision: next,
      workIntent, trustedReceipts: [], protectedResources: [],
      evidenceFacts: [evidenceFact], observationFacts: [observationFact],
      authenticatedProviderGrants: grants,
    });
    const green = exact();
    assert.equal(green.ok, true, green.reasons.join(" | "));
    assert.equal(green.providerCapabilityMode, true);

    const mutations = [
      ["wrong metric", { ...observationGrant, capability: { ...observationGrant.capability, key: "git.wrong" } }, domainGrant],
      ["wrong subject", { ...observationGrant, capability: { ...observationGrant.capability, subjectPaths: ["README.md"] } }, domainGrant],
      ["wrong repository", { ...observationGrant, repository: "netkeep80/wrong" }, domainGrant],
      ["wrong transition", { ...observationGrant, headRevision: "f".repeat(40) }, domainGrant],
      ["wrong Requirement", observationGrant, { ...domainGrant, capability: { ...domainGrant.capability, requirementId: "RG-02" } }],
      ["wrong verifier", observationGrant, { ...domainGrant, capability: { ...domainGrant.capability, verifierPath: "README.md" } }],
    ];
    for (const [name, first, second] of mutations)
      assert.equal(exact([first, second]).ok, false, name + " unexpectedly GREEN");
  });
});

test("A1 WorkIntent adapter reuses only non-authoritative affects addresses", async () => {
  const { workIntentFromChangeIntent } = await import("../dist/github-pr.mjs");
  assert.deepEqual(
    workIntentFromChangeIntent({
      change_type: "feature",
      scope: ["**"], budgets: {}, must_touch: [], must_not_touch: [],
      anchors: { affects: ["RG-02", "RG-01"], implements: ["RG-08"], verifies: ["RG-07"] },
      expected_effects: [],
      evaluator: "native",
    }, 743),
    { id: "pr:743", addresses: ["RG-01", "RG-02"] },
  );
  assert.deepEqual(workIntentFromChangeIntent(null, 1), { id: "pr:1", addresses: [] });
});

test("A1 reverse selector requires exact rollback receipt and exact accepted legacy tree", () => {
  c25Fixture(({ root, base, head }) => {
    const nativeBase = head;
    c25Git(root, ["read-tree", "--reset", "-u", base]);
    c25Git(root, ["commit", "-q", "-m", "A1 exact rollback fixture"]);
    const rollbackHead = c25Git(root, ["rev-parse", "HEAD"]);

    const prepared = evaluateRepoGuardNativeRollbackSnapshot({
      repository: c25Repository, repositoryRoot: root,
      trustedAuthorityBaseRevision: nativeBase, baseRevision: nativeBase, headRevision: rollbackHead,
      trustedRootReceipt: null,
    });
    assert.equal(prepared.candidateReady, true, prepared.reasons.join(" | "));
    assert.equal(prepared.ok, false);
    assert.equal(prepared.trust.authorized, false);
    assert.equal(prepared.requiredPermissions.length, 8);

    const receipt = {
      repository: c25Repository,
      authorityBaseRevision: nativeBase,
      baseRevision: nativeBase,
      headRevision: rollbackHead,
      permissions: prepared.requiredPermissions,
    };
    const exact = evaluateRepoGuardNativeRollbackSnapshot({
      repository: c25Repository, repositoryRoot: root,
      trustedAuthorityBaseRevision: nativeBase, baseRevision: nativeBase, headRevision: rollbackHead,
      trustedRootReceipt: receipt,
    });
    assert.equal(exact.ok, true, exact.reasons.join(" | "));
    assert.equal(exact.exactLegacyTreeRestored, true);
    assert.deepEqual(selectRepoGuardAuthoritativeEvaluator({
      baseRepresentation: "native", headRepresentation: "legacy",
      forwardAuthorized: false, rollbackAuthorized: exact.ok,
    }), { ok: true, evaluator: "legacy", transition: "rollback" });

    writeFileSync(join(root, "README.md"), readFileSync(join(root, "README.md"), "utf8") + "\nnon-exact rollback\n");
    c25Git(root, ["add", "-A"]);
    c25Git(root, ["commit", "-q", "-m", "A1 non-exact rollback"]);
    const wrongHead = c25Git(root, ["rev-parse", "HEAD"]);
    const wrong = evaluateRepoGuardNativeRollbackSnapshot({
      repository: c25Repository, repositoryRoot: root,
      trustedAuthorityBaseRevision: nativeBase, baseRevision: nativeBase, headRevision: wrongHead,
      trustedRootReceipt: { ...receipt, headRevision: wrongHead },
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.candidateReady, false);
  });
});


test("A1 atomic cutover rejects unapproved native Constraint/lifecycle/strong semantics", () => {
  c25Fixture(({ root, base, head }) => {
    const reset = () => c25Git(root, ["reset", "--hard", "-q", head]);
    const path = join(root, "requirements/repo-guard/RG-01.rg.yaml");

    writeFileSync(path, readFileSync(path, "utf8") + [
      "constraints:",
      "  - id: not-approved-at-cutover",
      "    scope:",
      "      relations: [implemented_by]",
      "    metric:",
      "      key: git.changed_resources",
      "      max: 1000",
      "",
    ].join("\n"));
    c25Git(root, ["add", "--", "requirements/repo-guard/RG-01.rg.yaml"]);
    c25Git(root, ["commit", "-q", "-m", "unexpected cutover constraint"]);
    let verdict = c25Prepared(root, base, c25Git(root, ["rev-parse", "HEAD"]));
    assert.equal(verdict.candidateReady, false);
    assert.ok(verdict.reasons.includes("C2.5:unexpected_native_cutover_semantics"), verdict.reasons.join(" | "));

    reset();
    writeFileSync(path, readFileSync(path, "utf8") + "lifecycle:\n  accepted: true\n");
    c25Git(root, ["add", "--", "requirements/repo-guard/RG-01.rg.yaml"]);
    c25Git(root, ["commit", "-q", "-m", "unexpected cutover lifecycle"]);
    verdict = c25Prepared(root, base, c25Git(root, ["rev-parse", "HEAD"]));
    assert.equal(verdict.candidateReady, false);
    assert.ok(verdict.reasons.includes("C2.5:unexpected_native_cutover_semantics"), verdict.reasons.join(" | "));
  });
});

test("A1 exact TransitionReceipt transport uses existing trusted issue authority and exact tuple", async () => {
  const { evaluateTransitionReceiptBoundary } = await import("../dist/github-pr.mjs");
  const sha = (x) => x.repeat(40);
  const grant = {
    transition_receipt: {
      repository: c25Repository,
      authority_base_sha: sha("a"),
      base_sha: sha("a"),
      head_sha: sha("b"),
      permissions: ["resource:.github/workflows/trusted-enforcement.yml"],
    },
  };
  const trustedAuthorizer = { trusted: true, source: "repository_permission" };
  const exact = evaluateTransitionReceiptBoundary({
    governanceGrant: grant, trustedAuthorizer, repository: c25Repository,
    authorityBaseRevision: sha("a"), baseRevision: sha("a"), headRevision: sha("b"),
  });
  assert.equal(exact.present, true);
  assert.equal(exact.ok, true, exact.reasons.join(" | "));
  assert.deepEqual(exact.receipt.permissions, grant.transition_receipt.permissions);

  for (const [name, input] of [
    ["untrusted", { trustedAuthorizer: { trusted: false, source: "repository_permission" } }],
    ["wrong repo", { repository: "netkeep80/wrong" }],
    ["wrong authority", { authorityBaseRevision: sha("c") }],
    ["wrong base", { baseRevision: sha("c") }],
    ["wrong head", { headRevision: sha("c") }],
  ]) {
    const verdict = evaluateTransitionReceiptBoundary({
      governanceGrant: grant, trustedAuthorizer, repository: c25Repository,
      authorityBaseRevision: sha("a"), baseRevision: sha("a"), headRevision: sha("b"),
      ...input,
    });
    assert.equal(verdict.ok, false, name + " unexpectedly GREEN");
    assert.equal(verdict.receipt, null);
  }
});

// Native authority post-cutover production probe; do not merge.
