import test from "node:test";
import assert from "node:assert/strict";
import { resolvePolicyPacks } from "../dist/policy-packs.mjs";
import { runPolicyPipeline } from "../dist/runtime/pipeline.mjs";

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

function run(policy, files, diffText) {
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
    initialChecks: [],
  }, { quiet: true });
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

  const result = run(policy, files, diffText);

  assert.deepEqual(
    result.violations,
    [],
    "fixture must first prove that current HEAD-only closure is internally self-consistent",
  );

  // PRE-IMPLEMENTATION FALSIFIER:
  // accepted main has no trusted BASE->HEAD requirement-transition authority,
  // so current repo-guard returns GREEN here. The target safety invariant is RED
  // until an exact externally authorized relation delta is present.
  assert.equal(
    result.ok,
    false,
    "candidate HEAD authority must not justify its own newly-added tracked artifact",
  );
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
});
