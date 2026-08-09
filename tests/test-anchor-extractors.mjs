import { strict as assert } from "node:assert";
import { buildPolicyFacts } from "../src/facts/input.mjs";
import { extractAnchors } from "../src/extractors/anchors.mjs";
import { runPolicyPipeline } from "../src/runtime/pipeline.mjs";

let failures = 0;

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS: ${label}`);
  } catch (e) {
    failures++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function expectIncludes(label, value, substring) {
  const actual = String(value || "");
  const passed = actual.includes(substring);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected ${JSON.stringify(actual)} to include ${JSON.stringify(substring)}`);
  }
}

function makeReadFile(files) {
  return (file) => {
    if (!Object.hasOwn(files, file)) throw new Error(`missing fixture ${file}`);
    return files[file];
  };
}

function makePolicy(anchorTypes, traceRules = []) {
  const policy = {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: { forbidden: [], canonical_docs: [], operational_paths: [], governance_paths: [] },
    diff_rules: { max_new_docs: 10, max_new_files: 10, max_net_added_lines: 1000 },
    anchors: { types: anchorTypes },
    content_rules: [],
    cochange_rules: [],
  };
  if (traceRules.length > 0) policy.trace_rules = traceRules;
  return policy;
}

console.log("\n--- anchor extractors return normalized instances ---");
{
  const policy = makePolicy({
    requirement_id: { sources: [{ kind: "json_field", glob: "requirements/**/*.json", field: "id" }] },
    code_req_ref: { sources: [{ kind: "regex", glob: "src/**", pattern: "@req\\s+((FR|SR)-[0-9]{3})" }] },
  });
  const files = {
    "requirements/fr-001.json": JSON.stringify({ id: "FR-001", title: "Login" }),
    "src/feature.mjs": "export function feature() {} // @req FR-001\n// @req SR-002\n",
  };
  const extraction = extractAnchors(policy, { repoRoot: "/tmp/repo", trackedFiles: Object.keys(files), readFile: makeReadFile(files) });
  expect("extractors produce no errors", extraction.errors, []);
  expect("extractors group instances by anchor type", Object.keys(extraction.byType).sort(), ["code_req_ref", "requirement_id"]);
  const requirement = extraction.instances.find((instance) => instance.anchorType === "requirement_id");
  expect("json_field instance is normalized", requirement, {
    anchorType: "requirement_id", value: "FR-001", file: "requirements/fr-001.json", sourceKind: "json_field", raw: "FR-001",
  });
  const codeRef = extraction.instances.find((instance) => instance.anchorType === "code_req_ref" && instance.value === "FR-001");
  expect("regex instance uses first capture group as value", {
    anchorType: codeRef?.anchorType, value: codeRef?.value, file: codeRef?.file,
    sourceKind: codeRef?.sourceKind, captureGroup: codeRef?.captureGroup, raw: codeRef?.raw, line: codeRef?.line,
  }, {
    anchorType: "code_req_ref", value: "FR-001", file: "src/feature.mjs", sourceKind: "regex",
    captureGroup: 1, raw: "@req FR-001", line: 1,
  });
  expect("regex extractor reports one-based column for captured value", codeRef?.column > 1, true);
}

console.log("\n--- normalized facts include repository and changed anchor files ---");
{
  const policy = makePolicy({
    requirement_id: { sources: [{ kind: "json_field", glob: "requirements/**/*.json", field: "id" }] },
    test_req_ref: { sources: [{ kind: "regex", glob: "tests/**", pattern: "\\[REQ-([0-9]+)\\]" }] },
    second_test_ref: { sources: [{ kind: "regex", glob: "tests/**", pattern: "\\[REQ-([0-9]+)\\]" }] },
  });
  const files = {
    "requirements/req-42.json": JSON.stringify({ id: "REQ-42" }),
    "tests/new.test.mjs": "test('new behavior [REQ-42]', () => {});\n",
  };
  const reads = {};
  const readFile = (file) => {
    reads[file] = (reads[file] || 0) + 1;
    return makeReadFile(files)(file);
  };
  const diffText = [
    "diff --git a/tests/new.test.mjs b/tests/new.test.mjs", "new file mode 100644", "--- /dev/null",
    "+++ b/tests/new.test.mjs", "+test('new behavior [REQ-42]', () => {});",
  ].join("\n");
  const facts = buildPolicyFacts({
    mode: "check-diff", repositoryRoot: "/tmp/repo", policy, contract: null, contractSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" }, diffText,
    trackedFiles: ["requirements/req-42.json"], readFile,
  });
  expect("facts expose anchor instances from tracked and changed files",
    facts.anchors.instances.map((instance) => `${instance.anchorType}:${instance.file}:${instance.value}`),
    [
      "requirement_id:requirements/req-42.json:REQ-42",
      "second_test_ref:tests/new.test.mjs:42",
      "test_req_ref:tests/new.test.mjs:42",
    ]);
  expect("facts expose anchor extraction errors", facts.anchors.errors, []);
  expect("facts cache content shared by multiple extractors", reads["tests/new.test.mjs"], 1);
}

console.log("\n--- anchor extraction errors are predictable and reported by pipeline ---");
{
  const policy = makePolicy({
    requirement_id: { sources: [{ kind: "json_field", glob: "requirements/**/*.json", field: "id" }] },
  });
  const files = {
    "requirements/bad.json": "{ not json",
    "requirements/missing.json": JSON.stringify({ title: "Missing id" }),
  };
  const extraction = extractAnchors(policy, { repoRoot: "/tmp/repo", trackedFiles: Object.keys(files), readFile: makeReadFile(files) });
  expect("json_field extractor records both errors", extraction.errors.length, 2);
  expectIncludes("json parse error is stable", extraction.errors[0]?.message, "invalid JSON");
  expectIncludes("missing field error identifies the field", extraction.errors[1]?.message, 'field "id" not found');

  const report = runPolicyPipeline({
    mode: "check-diff", repositoryRoot: "/tmp/repo", policy, contract: null, contractSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" }, diffText: "",
    trackedFiles: Object.keys(files), readFile: makeReadFile(files), initialChecks: [],
  }, { quiet: true });
  expect("pipeline reports anchor extraction as a policy violation", report.violations.some((v) => v.rule === "anchor-extraction"), true);
  expect("pipeline exposes formatted extraction errors", report.violations.find((v) => v.rule === "anchor-extraction")?.details.length, 2);
}

console.log("\n--- must_resolve trace rules enforce code and doc anchors ---");
{
  const policy = makePolicy({
    requirement_id: { sources: [{ kind: "json_field", glob: "requirements/**/*.json", field: "id" }] },
    code_req_ref: { sources: [{ kind: "regex", glob: "src/**", pattern: "@req\\s+(FR-[0-9]{3})" }] },
    doc_req_ref: { sources: [{ kind: "regex", glob: "docs/**", pattern: "\\[(FR-[0-9]{3})\\]" }] },
  }, [
    { id: "code-refs-resolve", kind: "must_resolve", from_anchor_type: "code_req_ref", to_anchor_type: "requirement_id" },
    { id: "doc-refs-resolve", kind: "must_resolve", from_anchor_type: "doc_req_ref", to_anchor_type: "requirement_id" },
  ]);
  const files = {
    "requirements/fr-001.json": JSON.stringify({ id: "FR-001" }),
    "src/feature.mjs": "// @req FR-001\n// @req FR-999\n",
    "docs/feature.md": "# Feature [FR-001]\nBroken [FR-777]\n",
  };
  const input = {
    mode: "check-diff", repositoryRoot: "/tmp/repo", policy,
    contract: null, contractSource: "none", diffText: "",
    trackedFiles: Object.keys(files), readFile: makeReadFile(files), initialChecks: [],
  };
  const blocking = runPolicyPipeline({ ...input, enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" } }, { quiet: true });
  expect("unresolved trace anchors fail blocking mode", blocking.ok, false);
  expect("unresolved trace anchors set blocking exit code", blocking.exitCode, 1);
  expect("multiple trace rule violations coexist", blocking.traceRuleResults.filter((r) => !r.ok).length, 2);
  const codeViolation = blocking.traceRuleResults.find((r) => r.ruleId === "code-refs-resolve");
  const docViolation = blocking.traceRuleResults.find((r) => r.ruleId === "doc-refs-resolve");
  expect("code violation lists unresolved anchor value", codeViolation.unresolved[0].value, "FR-999");
  expect("code violation lists offending source file", codeViolation.unresolved[0].file, "src/feature.mjs");
  expect("doc violation lists unresolved anchor value", docViolation.unresolved[0].value, "FR-777");
  expect("doc violation lists offending source file", docViolation.unresolved[0].file, "docs/feature.md");
  expect("resolved trace values remain visible in diagnostics", codeViolation.resolved.some((r) => r.value === "FR-001"), true);
  const advisory = runPolicyPipeline({ ...input, enforcement: { ok: true, mode: "advisory", source: "test", requested: "advisory" } }, { quiet: true });
  expect("unresolved trace anchors still mark advisory result failed", advisory.ok, false);
  expect("unresolved trace anchors keep advisory exit code zero", advisory.exitCode, 0);
  expect("unresolved trace anchors keep advisory enforced failures zero", advisory.failedChecks, 0);
  expect("unresolved trace anchors remain counted as advisory violations", advisory.advisoryViolationCount > 0, true);
}

console.log("\n--- resolved must_resolve refs pass cleanly ---");
{
  const policy = makePolicy({
    requirement_id: { sources: [{ kind: "json_field", glob: "requirements/**/*.json", field: "id" }] },
    code_req_ref: { sources: [{ kind: "regex", glob: "src/**", pattern: "@req\\s+(FR-[0-9]{3})" }] },
  }, [{ id: "code-refs-resolve", kind: "must_resolve", from_anchor_type: "code_req_ref", to_anchor_type: "requirement_id" }]);
  const files = {
    "requirements/fr-001.json": JSON.stringify({ id: "FR-001" }),
    "src/feature.mjs": "// @req FR-001\n",
  };
  const report = runPolicyPipeline({
    mode: "check-diff", repositoryRoot: "/tmp/repo", policy, contract: null, contractSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" }, diffText: "",
    trackedFiles: Object.keys(files), readFile: makeReadFile(files), initialChecks: [],
  }, { quiet: true });
  expect("resolved trace anchors keep the run passing", report.ok, true);
  expect("resolved trace anchors keep exit code zero", report.exitCode, 0);
  expect("resolved trace anchors produce no trace violations", report.traceRuleResults.every((r) => r.ok), true);
}

if (failures > 0) process.exit(1);
console.log("\nAll anchor extractor tests passed");
