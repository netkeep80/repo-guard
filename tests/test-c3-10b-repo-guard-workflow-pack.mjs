import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { compileConstraintProgram } from "../dist/checks/constraint-program.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";
import { createDocumentReader } from "../dist/document-facts.mjs";
import { resolvePolicyProfile } from "../dist/policy-profiles.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/repo-policy.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const expectedSha = "0123456789abcdef0123456789abcdef01234567";
const workflowPath = ".github/workflows/repo-guard.yml";
const policy = {
  policy_format_version: "0.3.0",
  repository_kind: "application",
  enforcement: { mode: "blocking" },
  paths: { forbidden: [], canonical_docs: [], governance_paths: ["repo-policy.json", workflowPath] },
  diff_rules: { max_new_docs: 1, max_new_files: 2, max_net_added_lines: 20 },
  content_rules: [],
  cochange_rules: [],
  packs: {
    "repo-guard-workflow": {
      path: workflowPath,
      sha: expectedSha,
    },
  },
};

assert.equal(
  validate(policy),
  true,
  `repo-guard-workflow must be accepted as a closed built-in pack; schema errors: ${JSON.stringify(validate.errors)}`,
);

const resolved = resolvePolicyProfile(policy);
assert.equal(resolved.ok, true, `repo-guard-workflow must lower successfully; errors: ${JSON.stringify(resolved.errors)}`);
assert.equal(Object.hasOwn(resolved.policy, "packs"), false, "repo-guard-workflow must disappear after lowering");

const documents = resolved.policy.document_relations?.documents || {};
assert.deepEqual(documents["pack:repo-guard-workflow:workflow"], { path: workflowPath, format: "yaml" });

const rules = new Map((resolved.policy.document_relations?.rules || []).map((rule) => [rule.id, rule]));
const expectedRules = new Map([
  ["pack:repo-guard-workflow:action-pin", ["/jobs/policy-check/steps/1/uses", `netkeep80/repo-guard@${expectedSha}`]],
  ["pack:repo-guard-workflow:mode", ["/jobs/policy-check/steps/1/with/mode", "check-pr"]],
  ["pack:repo-guard-workflow:enforcement", ["/jobs/policy-check/steps/1/with/enforcement", "blocking"]],
  ["pack:repo-guard-workflow:permission:contents", ["/permissions/contents", "read"]],
  ["pack:repo-guard-workflow:permission:issues", ["/permissions/issues", "read"]],
  ["pack:repo-guard-workflow:permission:pull-requests", ["/permissions/pull-requests", "read"]],
]);

for (const [id, [pointer, value]] of expectedRules) {
  assert.deepEqual(rules.get(id), {
    id,
    kind: "scalar_equals_literal",
    source: { document: "pack:repo-guard-workflow:workflow", pointer, type: "string" },
    value,
  }, `${id} must lower to the canonical scalar literal relation`);
}

const runtime = compileConstraintProgram(resolved.policy)
  .filter((entry) => entry.runtime?.relation_id?.startsWith("pack:repo-guard-workflow:"));
assert.equal(runtime.length, expectedRules.size, "repo-guard-workflow must lower to exactly six runtime relations");
assert.ok(runtime.every((entry) => entry.runtime?.kind === "primitive_relation"), "repo-guard-workflow must not create a pack-specific runtime kind");
assert.ok(runtime.every((entry) => entry.runtime?.primitive === "scalar_equals_literal"), "repo-guard-workflow must reuse scalar_equals_literal only");

function workflowYaml({ sha = expectedSha, mode = "check-pr", enforcement = "blocking", contents = "read", issues = "read", pullRequests = "read" } = {}) {
  return `permissions:\n  contents: ${contents}\n  issues: ${issues}\n  pull-requests: ${pullRequests}\njobs:\n  policy-check:\n    steps:\n      - uses: actions/checkout@v6\n      - uses: netkeep80/repo-guard@${sha}\n        with:\n          mode: ${mode}\n          enforcement: ${enforcement}\n`;
}

function evaluateWorkflow(content) {
  const readFile = (path) => {
    if (path === workflowPath) return content;
    throw new Error(`unexpected workflow path: ${path}`);
  };
  const entries = evaluateConstraintIR({
    repositoryRoot: process.cwd(),
    documents: createDocumentReader({ readFile }),
    policy: resolved.policy,
    changeIntent: null,
    diff: { files: { checked: [{ path: "src/change.mjs", status: "modified", addedLines: ["x"], deletedLines: [] }] } },
  }, { executionPhase: "both" });
  return new Map(entries
    .filter((entry) => entry.name.startsWith("document-relation:pack:repo-guard-workflow:"))
    .map((entry) => [entry.name, entry.check]));
}

const good = evaluateWorkflow(workflowYaml());
for (const id of expectedRules.keys()) assert.equal(good.get(`document-relation:${id}`)?.ok, true, `${id} must pass for the canonical workflow`);

const wrongPin = evaluateWorkflow(workflowYaml({ sha: "main" }));
assert.equal(wrongPin.get("document-relation:pack:repo-guard-workflow:action-pin")?.ok, false, "mutable/non-accepted action ref must fail");

const advisory = evaluateWorkflow(workflowYaml({ enforcement: "advisory" }));
assert.equal(advisory.get("document-relation:pack:repo-guard-workflow:enforcement")?.ok, false, "advisory enforcement must fail the blocking workflow pack");

const writable = evaluateWorkflow(workflowYaml({ contents: "write" }));
assert.equal(writable.get("document-relation:pack:repo-guard-workflow:permission:contents")?.ok, false, "write permission must fail the required read-only permission relation");

const invalidShaPolicy = structuredClone(policy);
invalidShaPolicy.packs["repo-guard-workflow"].sha = "main";
assert.equal(validate(invalidShaPolicy), false, "repo-guard-workflow sha must be exactly 40 lowercase hex characters");

console.log("C3.10b repo-guard-workflow pure-lowering contract passed");
