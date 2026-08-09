import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";

const root = resolve(new URL("..", import.meta.url).pathname);
const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf-8"));
const ajv = new Ajv({ allErrors: true });
const policy = ajv.compile(json("schemas/repo-policy.schema.json"));
const intent = ajv.compile(json("schemas/change-contract.schema.json"));
const grant = ajv.compile(json("schemas/governance-grant.schema.json"));
let failures = 0;
function expect(label, actual, expected = true) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failures++;
}

const validPolicy = json("tests/fixtures/valid-policy.json");
expect("valid policy fixture", policy(validPolicy));
expect("invalid policy fixture", policy(json("tests/fixtures/invalid-policy.json")), false);
expect("repo-policy self", policy(json("repo-policy.json")));
expect("downstream integration example", policy(json("examples/downstream-integration-policy.json")));
expect("size rules example", policy(json("examples/size-rules-policy.json")));
expect("requirements-strict profile", policy({ ...validPolicy, profile: "requirements-strict", profile_overrides: { evidence_surfaces: ["src/**"] } }));
expect("profile overrides require profile", policy({ ...validPolicy, profile_overrides: { evidence_surfaces: ["src/**"] } }), false);
expect("anchors + trace", policy({ ...validPolicy, anchors: { types: { id: { sources: [{ kind: "json_field", glob: "requirements/**", field: "id" }] } } }, trace_rules: [{ id: "resolve", kind: "must_resolve", from_anchor_type: "id", to_anchor_type: "id" }] }));
expect("invalid anchor source", policy({ ...validPolicy, anchors: { types: { id: { sources: [{ kind: "json_field", glob: "requirements/**", pattern: "id" }] } } } }), false);
expect("evidence trace", policy({ ...validPolicy, trace_rules: [{ id: "evidence", kind: "changed_files_require_evidence", if_changed: ["requirements/**"], must_touch_any: ["tests/**"] }] }));

const integration = {
  workflows: [{ id: "gate", kind: "github_actions", path: ".github/workflows/ci.yml", role: "repo_guard_pr_gate", expect: { events: ["pull_request"], action: { uses: "netkeep80/repo-guard", ref_pinning: "semver" }, mode: "check-pr", enforcement: "blocking", permissions: { contents: "read" }, token_env: ["GH_TOKEN"], summary: true, disallow: ["continue_on_error"] } }],
  templates: [{ id: "pr", kind: "markdown", path: ".github/PULL_REQUEST_TEMPLATE.md", requires_contract_block: true, required_block_kind: "repo-guard-yaml", required_contract_fields: ["change_type"] }],
  docs: [{ id: "readme", kind: "markdown", path: "README.md", must_mention: ["repo-guard"] }],
  profiles: [{ id: "self", doc_path: "README.md" }],
};
expect("integration shape", policy({ ...validPolicy, integration }));
expect("invalid integration role", policy({ ...validPolicy, integration: { workflows: [{ id: "x", kind: "github_actions", path: "x.yml", role: "custom" }] } }), false);
expect("invalid integration expectation", policy({ ...validPolicy, integration: { workflows: [{ id: "x", kind: "github_actions", path: "x.yml", role: "repo_guard_pr_gate", expect: { mode: "deploy" } }] } }), false);
expect("valid size rule", policy({ ...validPolicy, size_rules: [{ id: "src", scope: "directory", metric: "lines", glob: "src/**", max: 100, max_growth: 0 }] }));
expect("invalid size metric", policy({ ...validPolicy, size_rules: [{ id: "src", scope: "file", metric: "tokens", glob: "src/**", max: 1 }] }), false);
expect("old content-rule shape rejected", policy(json("tests/fixtures/invalid-content-rule-old-form.json")), false);
expect("invalid operational paths rejected", policy(json("tests/fixtures/invalid-operational-paths.json")), false);
expect("new_files requires allow_classes", policy({ ...validPolicy, change_profiles: { feature: { new_files: { max_per_class: { test: 1 } } } } }), false);
for (const field of ["change_classes", "surface_matrix", "new_file_rules", "change_type_rules", "allow_unclassified_files"]) {
  expect(`removed policy field ${field}`, policy({ ...validPolicy, [field]: field === "allow_unclassified_files" ? true : {} }), false);
}

const validIntent = json("tests/fixtures/valid-contract.json");
expect("valid ChangeIntent", intent(validIntent));
expect("repository-specific change_type", intent({ ...validIntent, change_type: "governance" }));
expect("anchor intent", intent({ ...validIntent, anchors: { affects: ["FR-014"], implements: ["FR-014"], verifies: ["FR-014"] } }));
expect("invalid ChangeIntent fixture", intent(json("tests/fixtures/invalid-contract.json")), false);
expect("duplicate anchor intent", intent({ ...validIntent, anchors: { affects: ["FR-014", "FR-014"] } }), false);
expect("unknown anchor field", intent({ ...validIntent, anchors: { affects: ["FR-014"], notes: [] } }), false);
for (const field of ["change_class", "authorized_governance_paths", "overrides", "allow_policy_relaxation"]) {
  expect(`privileged/removed ChangeIntent field ${field}`, intent({ ...validIntent, [field]: [] }), false);
}

expect("valid GovernanceGrant", grant({ authorized_governance_paths: ["schemas/**"], allow_policy_relaxation: ["/size_rules/source/max"] }));
expect("path-only GovernanceGrant", grant({ authorized_governance_paths: ["repo-policy.json"] }));
expect("empty GovernanceGrant rejected", grant({}), false);
expect("unknown GovernanceGrant field rejected", grant({ authorized_governance_paths: ["x"], reason: "no" }), false);
expect("relaxation pointer must be absolute", grant({ allow_policy_relaxation: ["size_rules/x"] }), false);

console.log(`\n${failures ? `${failures} test(s) failed` : "All schema tests passed"}`);
if (failures) process.exitCode = 1;
