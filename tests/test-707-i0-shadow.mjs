import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseYaml } from "../dist/document-facts.mjs";
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

function c25Fixture(body) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const clone = mkdtempSync(join(tmpdir(), "repo-guard-c25-gate-"));
  try {
    execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", projectRoot, clone], { encoding: "utf8" });
    symlinkSync(join(projectRoot, "node_modules"), join(clone, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    c25Git(clone, ["config", "user.email", "c2.5-gate@example.invalid"]);
    c25Git(clone, ["config", "user.name", "C2.5 Gate Bridge"]);
    const base = c25Git(projectRoot, ["rev-parse", "HEAD"]);
    c25Git(clone, ["checkout", "-q", base]);
    c25WriteNativeMigration(clone);
    c25Git(clone, ["add", "-A"]);
    c25Git(clone, ["commit", "-q", "-m", "C2.5 native migration fixture"]);
    const head = c25Git(clone, ["rev-parse", "HEAD"]);
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
