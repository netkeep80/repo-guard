import test from "node:test";
import assert from "node:assert/strict";
import { resolvePolicyPacks } from "../dist/policy-packs.mjs";
import { runPolicyPipeline } from "../dist/runtime/pipeline.mjs";
import {
  checkRequirementTransition,
  compareRequirementRelationGraphs,
  normalizeRequirementAuthority,
} from "../dist/requirement-relations.mjs";

function requirementsPolicy(overrides = {}) {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: [],
      operational_paths: [],
    },
    diff_rules: {
      max_new_docs: 10,
      max_new_files: 10,
      max_net_added_lines: 1000,
    },
    content_rules: [],
    cochange_rules: [],
    packs: {
      "requirements-strict": {
        requirement_yaml_globs: ["requirements/*.yaml"],
        requirement_id_pattern: "RG-[A-Z0-9-]+",
        strict_heading_docs: ["docs/**/*.md"],
        ...overrides,
      },
    },
  };
}

function resolvePolicy(overrides = {}) {
  const resolved = resolvePolicyPacks(requirementsPolicy(overrides));
  assert.equal(resolved.ok, true, "falsifier fixture policy must resolve");
  return resolved.policy;
}

function run(policy, files, diffText, { initialChecks = [], options = {} } = {}) {
  return runPolicyPipeline({
    mode: "check-diff",
    repositoryRoot: "/tmp/repo-guard-644-falsifier",
    policy,
    changeIntent: null,
    changeIntentSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText,
    trackedFiles: Object.keys(files),
    readFile: (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`missing fixture ${path}`);
      return files[path];
    },
    initialChecks,
  }, { quiet: true, ...options });
}

test("#644 RED: self-authored HEAD closure must not authorize its own new artifact relation", () => {
  const policy = resolvePolicy({
    closed_repository: true,
    evidence_surfaces: ["garbage.tmp"],
    changed_requirement_evidence_surfaces: ["garbage.tmp"],
  });
  const files = {
    "requirements/garbage.yaml": [
      "id: RG-GARBAGE-01",
      "artifacts:",
      "  - path: requirements/garbage.yaml",
      "    role: requirement",
      "  - path: garbage.tmp",
      "    role: implementation",
      "",
    ].join("\n"),
    "garbage.tmp": "candidate-owned garbage\n",
  };
  const diffText = [
    "diff --git a/requirements/garbage.yaml b/requirements/garbage.yaml",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/requirements/garbage.yaml",
    "+id: RG-GARBAGE-01",
    "+artifacts:",
    "+  - path: requirements/garbage.yaml",
    "+    role: requirement",
    "+  - path: garbage.tmp",
    "+    role: implementation",
    "diff --git a/garbage.tmp b/garbage.tmp",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/garbage.tmp",
    "+candidate-owned garbage",
  ].join("\n");

  const closureOnly = run(policy, files, diffText);
  assert.deepEqual(
    closureOnly.violations,
    [],
    "HEAD-only closure remains a state invariant and is internally self-consistent",
  );

  const base = normalizeRequirementAuthority({
    snapshot: "base",
    revision: "a".repeat(40),
    sources: [],
  });
  const head = normalizeRequirementAuthority({
    snapshot: "head",
    revision: "b".repeat(40),
    sources: [{ path: "requirements/garbage.yaml", format: "yaml", content: files["requirements/garbage.yaml"] }],
  });
  const transition = checkRequirementTransition({
    base,
    head,
    trustedAuthorizer: { trusted: true, source: "repository_permission" },
  });
  assert.equal(transition.ok, false);
  assert.ok(transition.reasons.includes("requirement_transition_grant_missing"));

  const guarded = run(policy, files, diffText, {
    initialChecks: [{
      name: "requirement-transition",
      check: { ok: transition.ok, details: transition.reasons },
    }],
  });
  assert.equal(guarded.ok, false, "trusted transition boundary must turn the structurally self-consistent candidate RED");
  assert.ok(guarded.violations.some((item) => item.rule === "requirement-transition"));
});

test("#644 witness: relation-only requirement administration currently demands dummy evidence touch", () => {
  const policy = resolvePolicy({
    evidence_surfaces: ["src/**"],
    changed_requirement_evidence_surfaces: ["src/**"],
  });
  const files = {
    "requirements/ownership.yaml": [
      "id: RG-OWNERSHIP-01",
      "artifacts:",
      "  - path: src/runtime.mts",
      "    role: implementation",
      "",
    ].join("\n"),
    "src/runtime.mts": "export const runtime = true;\n",
  };
  const diffText = [
    "diff --git a/requirements/ownership.yaml b/requirements/ownership.yaml",
    "--- a/requirements/ownership.yaml",
    "+++ b/requirements/ownership.yaml",
    "-id: RG-OLD-OWNERSHIP",
    "+id: RG-OWNERSHIP-01",
  ].join("\n");

  const result = run(policy, files, diffText);
  const violation = result.violations.find(
    (item) => item.rule === "trace-rule: changed-requirements-need-evidence",
  );

  assert.ok(
    violation,
    "current accepted rule must expose the administrative-transition dummy-touch deadlock",
  );
  assert.deepEqual(
    violation.data?.operands?.right?.selector?.patterns,
    ["src/**"],
    "the rejection must be caused by missing changed evidence surface, not another fixture defect",
  );
  assert.equal(result.ok, false);

  const baseR1 = [
    "id: RG-OLD-OWNERSHIP",
    "artifacts:",
    "  - path: src/runtime.mts",
    "    role: implementation",
    "",
  ].join("\n");
  const base = normalizeRequirementAuthority({
    snapshot: "base",
    revision: "a".repeat(40),
    sources: [{ path: "requirements/ownership.yaml", format: "yaml", content: baseR1 }],
  });
  const head = normalizeRequirementAuthority({
    snapshot: "head",
    revision: "b".repeat(40),
    sources: [{ path: "requirements/ownership.yaml", format: "yaml", content: files["requirements/ownership.yaml"] }],
  });
  const delta = compareRequirementRelationGraphs(base, head);
  const transition = checkRequirementTransition({
    base,
    head,
    grant: {
      base_authority_sha256: base.authority_sha256,
      expected_head_authority_sha256: head.authority_sha256,
      add: delta.add,
      remove: delta.remove,
    },
    trustedAuthorizer: { trusted: true, source: "repository_permission" },
  });
  assert.equal(transition.ok, true);

  const authorized = run(policy, files, diffText, {
    initialChecks: [{ name: "requirement-transition", check: { ok: true } }],
    options: { satisfiedTransactionConstraintKeys: ["trace:changed-requirements-need-evidence"] },
  });
  assert.equal(authorized.ok, true, "exact trusted authority transition must satisfy the administrative evidence obligation");
  assert.deepEqual(authorized.satisfiedTransactionConstraintKeys, ["trace:changed-requirements-need-evidence"]);
});
