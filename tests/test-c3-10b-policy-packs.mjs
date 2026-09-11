import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { compileConstraintProgram } from "../dist/checks/constraint-program.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";
import { resolvePolicyProfile } from "../dist/policy-profiles.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/repo-policy.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const basePolicy = {
  policy_format_version: "0.3.0",
  repository_kind: "application",
  enforcement: { mode: "blocking" },
  paths: { forbidden: [], canonical_docs: [], governance_paths: ["repo-policy.json"] },
  diff_rules: { max_new_docs: 1, max_new_files: 2, max_net_added_lines: 20 },
  content_rules: [],
  cochange_rules: [],
};

for (const format of ["json", "yaml", "plain_text"]) {
  const path = format === "json" ? "package.json" : format === "yaml" ? "config.yml" : "VERSION";
  const pointer = format === "plain_text" ? "" : "/version";
  const policy = {
    ...basePolicy,
    document_relations: {
      documents: {
        source: { path, format },
      },
      rules: [{
        id: `version-monotonic-${format}`,
        kind: "scalar_strictly_greater",
        comparator: "semver",
        left: { document: "source", snapshot: "head", pointer, type: "string" },
        right: { document: "source", snapshot: "base", pointer, type: "string" },
      }],
    },
  };

  assert.equal(
    validate(policy),
    true,
    `${format} document selectors must expose canonical base/head snapshots; schema errors: ${JSON.stringify(validate.errors)}`,
  );

  const relation = compileConstraintProgram(policy).find((entry) => entry.runtime?.relation_id === `version-monotonic-${format}`)?.runtime;
  assert.ok(relation, `${format} version relation must lower into the canonical Constraint Program`);
  assert.equal(relation.operands.left.selector.snapshot, "head", `${format} left operand must lower to HEAD FactRef`);
  assert.equal(relation.operands.right.selector.snapshot, "base", `${format} right operand must lower to BASE FactRef`);
  assert.equal(relation.kind, "primitive_relation", `${format} lowering must keep the single canonical runtime kind`);
}

const invalidSnapshotPolicy = {
  ...basePolicy,
  document_relations: {
    documents: { package: { path: "package.json", format: "json" } },
    rules: [{
      id: "invalid-snapshot",
      kind: "scalar_equal",
      left: { document: "package", snapshot: "working-tree", pointer: "/version", type: "string" },
      right: { document: "package", pointer: "/version", type: "string" },
    }],
  },
};
assert.equal(validate(invalidSnapshotPolicy), false, "unknown document snapshots must fail schema validation");

console.log("C3.10b snapshot parity contract passed");

const requirementsPackPolicy = {
  ...basePolicy,
  packs: {
    "requirements-strict": {
      strict_heading_docs: ["docs/architecture.md"],
      evidence_surfaces: ["src/**", "tests/**", "docs/**"],
    },
  },
};

assert.equal(
  validate(requirementsPackPolicy),
  true,
  `known built-in packs must be a public closed policy surface; schema errors: ${JSON.stringify(validate.errors)}`,
);

const resolvedPack = resolvePolicyProfile(requirementsPackPolicy);
assert.equal(resolvedPack.ok, true, "known built-in pack must lower successfully");
assert.equal(Object.hasOwn(resolvedPack.policy, "packs"), false, "packs must disappear after frontend lowering");
assert.ok(resolvedPack.policy.anchors?.types?.requirement_id, "requirements-strict must lower to its existing canonical anchor policy");
assert.ok(
  resolvedPack.policy.trace_rules?.some((rule) => rule.id === "changed-requirements-need-evidence"),
  "requirements-strict must lower to its existing canonical trace policy",
);

const unknownPackPolicy = {
  ...basePolicy,
  packs: {
    "consumer-custom-macro": {},
  },
};
assert.equal(validate(unknownPackPolicy), false, "unknown or user-defined packs must fail closed at the public schema");

console.log("C3.10b closed built-in packs surface contract passed");

const versionPackPolicy = {
  ...basePolicy,
  packs: {
    "version-governance": {
      authority: { path: "package.json", pointer: "/version" },
      advance: "semver",
      mirrors: [{ path: "package-lock.json", pointer: "/version" }],
    },
  },
};

assert.equal(
  validate(versionPackPolicy),
  true,
  `version-governance must be accepted as a closed built-in pack; schema errors: ${JSON.stringify(validate.errors)}`,
);
const resolvedVersion = resolvePolicyProfile(versionPackPolicy);
assert.equal(resolvedVersion.ok, true, "version-governance must lower successfully");
assert.equal(Object.hasOwn(resolvedVersion.policy, "packs"), false, "version-governance must disappear after lowering");

const versionDocuments = resolvedVersion.policy.document_relations?.documents || {};
assert.deepEqual(versionDocuments["pack:version-governance:authority"], { path: "package.json", format: "json" });
assert.deepEqual(versionDocuments["pack:version-governance:mirror:0"], { path: "package-lock.json", format: "json" });

const versionRules = new Map((resolvedVersion.policy.document_relations?.rules || []).map((rule) => [rule.id, rule]));
assert.deepEqual(versionRules.get("pack:version-governance:advance"), {
  id: "pack:version-governance:advance",
  kind: "scalar_strictly_greater",
  comparator: "semver",
  left: { document: "pack:version-governance:authority", snapshot: "head", pointer: "/version", type: "string" },
  right: { document: "pack:version-governance:authority", snapshot: "base", pointer: "/version", type: "string" },
});
assert.deepEqual(versionRules.get("pack:version-governance:mirror:0"), {
  id: "pack:version-governance:mirror:0",
  kind: "scalar_equal",
  left: { document: "pack:version-governance:authority", snapshot: "head", pointer: "/version", type: "string" },
  right: { document: "pack:version-governance:mirror:0", snapshot: "head", pointer: "/version", type: "string" },
});

const versionProgram = compileConstraintProgram(resolvedVersion.policy).filter((entry) => entry.key.startsWith("document-relation:pack:version-governance:"));
const versionRuntime = versionProgram.filter((entry) => entry.runtime);
assert.equal(versionRuntime.length, 2, "version-governance must lower to exactly two ordinary runtime relations for one mirror");
assert.ok(versionRuntime.every((entry) => entry.runtime?.kind === "primitive_relation"), "version-governance must not create a pack-specific runtime kind");

function evaluateVersionPack(baseVersion, headVersion, mirrorVersion = headVersion) {
  const entries = evaluateConstraintIR({
    repositoryRoot: process.cwd(),
    baseRef: "BASE",
    headRef: "HEAD",
    readFileAtRef: (ref, path) => {
      if (path === "package.json") return JSON.stringify({ version: ref === "BASE" ? baseVersion : headVersion });
      if (path === "package-lock.json") return JSON.stringify({ version: mirrorVersion });
      throw new Error(`unexpected version-governance path: ${path}`);
    },
    policy: resolvedVersion.policy,
    changeIntent: null,
    diff: { files: { checked: [{ path: "src/change.mjs", status: "modified", addedLines: ["x"], deletedLines: [] }] } },
  }, { executionPhase: "transaction" });
  return new Map(entries
    .filter((entry) => entry.name.startsWith("document-relation:pack:version-governance:"))
    .map((entry) => [entry.name, entry.check]));
}

const noBump = evaluateVersionPack("0.5.0", "0.5.0");
assert.equal(noBump.get("document-relation:pack:version-governance:advance")?.ok, false, "equal BASE/HEAD versions must fail");
assert.equal(noBump.get("document-relation:pack:version-governance:mirror:0")?.ok, true, "matching HEAD mirror must remain valid on the no-bump falsifier");

const bumped = evaluateVersionPack("0.5.0", "0.5.1");
assert.equal(bumped.get("document-relation:pack:version-governance:advance")?.ok, true, "strict semver increase must pass");
assert.equal(bumped.get("document-relation:pack:version-governance:mirror:0")?.ok, true, "matching mirror must pass");

const staleMirror = evaluateVersionPack("0.5.0", "0.5.1", "0.5.0");
assert.equal(staleMirror.get("document-relation:pack:version-governance:advance")?.ok, true, "version advance must remain independently valid");
assert.equal(staleMirror.get("document-relation:pack:version-governance:mirror:0")?.ok, false, "stale mirror must fail independently");

console.log("C3.10b version-governance pure-lowering contract passed");
