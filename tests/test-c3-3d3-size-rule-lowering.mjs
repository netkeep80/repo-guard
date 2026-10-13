import { existsSync } from "node:fs";
import { compileConstraintIR, evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

let failures = 0;

function expect(label, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function baseFacts(size_rules, extra = {}) {
  return {
    repositoryRoot: process.cwd(),
    trackedFiles: ["src/a.mts", "src/b.mts", "docs/a.md"],
    policy: {
      paths: { forbidden: [], canonical_docs: [], operational_paths: [] },
      diff_rules: {},
      size_rules,
    },
    changeIntent: { change_type: "refactor" },
    diff: {
      files: {
        checked: [
          { path: "src/a.mts", status: "modified", addedLines: ["new-1", "new-2"], deletedLines: ["old"] },
          { path: "src/b.mts", status: "added", addedLines: ["b"] , deletedLines: [] },
          { path: "docs/a.md", status: "deleted", addedLines: [], deletedLines: ["gone"] },
        ],
      },
    },
    readFile: (path) => ({
      "src/a.mts": "a\nb\nc\n",
      "src/b.mts": "x\ny\n",
      "docs/a.md": "doc\n",
    })[path],
    ...extra,
  };
}

function primitiveConstraints(facts) {
  return compileConstraintIR(facts).constraints.filter((constraint) => constraint.kind === "primitive_relation");
}

function sourceSelector(constraint) {
  return constraint?.operands?.source?.selector;
}

console.log("\n--- C3.3d3 canonical lowering ---");
{
  const facts = baseFacts([
    { id: "changed-file-lines", scope: "file", metric: "lines", glob: "src/*.mts", max: 4, count: "changed_only" },
    { id: "tracked-directory-lines", scope: "directory", metric: "lines", glob: "src/**", max: 10, count: "all_tracked" },
    { id: "mixed-directory-lines", scope: "directory", metric: "lines", glob: "src/**", max: 20, max_growth: 0, count: "all_tracked", ignore: ["src/generated/**"] },
  ]);
  const ir = compileConstraintIR(facts);
  const primitives = primitiveConstraints(facts);

  expect("size_rules is not a runtime kind", ir.constraints.some((constraint) => constraint.kind === "size_rules"), false);
  expect("source size-rules evaluator is physically deleted", existsSync(new URL("../src/checks/rules/size-rules.mts", import.meta.url)), false);
  expect("dist size-rules evaluator is physically deleted", existsSync(new URL("../dist/checks/rules/size-rules.mjs", import.meta.url)), false);

  const changedFile = primitives.find((constraint) => {
    const selector = sourceSelector(constraint);
    return constraint.primitive === "numeric_bound"
      && constraint.parameters?.max === 4
      && selector?.kind === "path_metric"
      && selector.population === "changed"
      && selector.metric === "lines"
      && selector.aggregate === "max";
  });
  expect("changed file absolute bound lowers to repository.path_metric + numeric_bound", Boolean(changedFile), true);
  expect("changed file absolute bound is transaction phase", changedFile?.phase, "transaction");

  const trackedDirectory = primitives.find((constraint) => {
    const selector = sourceSelector(constraint);
    return constraint.primitive === "numeric_bound"
      && constraint.parameters?.max === 10
      && selector?.kind === "path_metric"
      && selector.population === "tracked"
      && selector.metric === "lines"
      && selector.aggregate === "sum";
  });
  expect("directory absolute bound lowers to tracked repository scalar", Boolean(trackedDirectory), true);
  expect("directory absolute bound is state phase", trackedDirectory?.phase, "state");

  const mixedAbsolute = primitives.find((constraint) => {
    const selector = sourceSelector(constraint);
    return constraint.parameters?.max === 20
      && selector?.kind === "path_metric"
      && selector.aggregate === "sum";
  });
  const mixedGrowth = primitives.find((constraint) => {
    const selector = sourceSelector(constraint);
    return constraint.parameters?.max === 0
      && selector?.kind === "metric"
      && selector.metric === "net_added_lines"
      && JSON.stringify(selector.patterns) === JSON.stringify(["src/**"])
      && JSON.stringify(selector.exclude_paths) === JSON.stringify(["src/generated/**"]);
  });
  expect("mixed directory absolute facet is an independent state primitive", mixedAbsolute?.phase, "state");
  expect("mixed directory growth facet is an independent transaction primitive", mixedGrowth?.phase, "transaction");
}

console.log("\n--- C3.3d3 scoped file-count growth ---");
{
  const facts = baseFacts([
    { id: "directory-files", scope: "directory", metric: "files", glob: "src/**", max: 10, max_growth: 0, count: "all_tracked" },
  ]);
  const growth = primitiveConstraints(facts).find((constraint) => {
    const selector = sourceSelector(constraint);
    return constraint.parameters?.max === 0
      && selector?.kind === "metric"
      && selector.metric === "net_files";
  });
  expect("directory file growth uses scoped diff.metric net_files", Boolean(growth), true);
  expect("directory file growth preserves path scope", growth ? sourceSelector(growth).patterns : undefined, ["src/**"]);
}

console.log("\n--- C3.3d3 generic advisory result ---");
{
  const facts = baseFacts([
    { id: "advisory-file", scope: "file", metric: "lines", glob: "src/a.mts", max: 0, count: "changed_only", level: "advisory" },
  ]);
  const results = evaluateConstraintIR(facts);
  expect("dedicated size-rules result is gone", results.some((result) => result.name === "size-rules"), false);
  expect("dedicated size-rules-advisory result is gone", results.some((result) => result.name === "size-rules-advisory"), false);
  expect("primitive violation carries generic advisory metadata", results.some((result) => result.check?.ok === false && result.check?.advisory === true), true);
}

console.log("\n--- C3.3d3 unreadable repository state fails closed ---");
{
  const facts = baseFacts([
    { id: "unreadable-file", scope: "file", metric: "lines", glob: "src/a.mts", max: 100, count: "all_tracked" },
  ], { readFile: () => undefined });
  const results = evaluateConstraintIR(facts);
  const failed = results.find((result) => result.check?.ok === false && result.check?.data?.source?.ok === false);
  expect("unreadable selected file reaches numeric_bound as fact failure", failed?.check?.data?.source?.error?.code, "document_read_error");
}

console.log("\n--- C3.3d3 canonical relation algebra remains finite ---");
expect("relation descriptor count remains ten", relationDescriptors().length, 10);

console.log("\\n--- #685 exact linked-issue size growth authority ---");
{
  const BASE = "a".repeat(40), HEAD = "b".repeat(40);
  const id = "typescript-tests-controlled-growth";
  const old = { id, scope: "directory", metric: "files", glob: "ts/test/**", max: 1000, max_growth: 1, count: "all_tracked", level: "blocking" };
  const grant = (limit = 28, overrides = {}) => ({ size_rule_growth: {
    base_sha: BASE, head_sha: HEAD, limits: [{ rule_id: id, max_growth: limit }], ...overrides,
  } });
  function facts(count = 28, options = {}) {
    const paths = Array.from({ length: count }, (_, i) => `ts/test/research-${i}.test.ts`);
    const { policyRule = old, grantValue = null, extra = {}, ...rest } = options;
    return baseFacts([policyRule], {
      mode: "check-pr", baseRef: BASE, headRef: HEAD,
      changeIntent: { change_type: "science" },
      governanceGrant: grantValue,
      trustedAuthorizer: { trusted: true, source: "repository_permission" },
      trackedFiles: paths,
      diff: { files: { checked: paths.map(path => ({ path, status: "added", addedLines: ["test"], deletedLines: [] })) } },
      ...extra, ...rest,
    });
  }
  const growth = (f) => evaluateConstraintIR(f).find(x => x.name === `size:${id}:max-growth`)?.check;
  const authority = (f) => evaluateConstraintIR(f).find(x => x.name === "size-rule-growth-authorization")?.check;
  const ordinary = facts(28);
  expect("ordinary PR +28 tests remains BLOCKED", growth(ordinary)?.ok, false);
  expect("no grant is not reported as authorization", authority(ordinary), undefined);
  const approved = facts(28, { grantValue: grant() });
  expect("exact authorized 28 passes growth", growth(approved)?.ok, true);
  expect("exact trusted issue grant verified", authority(approved)?.ok, true);
  expect("absolute limit unchanged", compileConstraintIR(approved).constraints.find(x => x.name === `size:${id}:max`)?.parameters?.max, 1000);
  expect("named growth numeric_bound retains policy limit", compileConstraintIR(approved).constraints.find(x => x.name === `size:${id}:max-growth`)?.parameters?.policy_limit, 1);
  expect("29 is blocked by 28 allowance", growth(facts(29, { grantValue: grant() }))?.ok, false);
  expect("ChangeIntent selection cannot self-authorize", growth(facts(28, { extra: { changeIntent: { change_type: "science", budgets: { max_new_files: 1000 } } } }))?.ok, false);
  for (const [label, badGrant, extra] of [
    ["stale BASE", grant(28, { base_sha: "c".repeat(40) })],
    ["stale HEAD", grant(28, { head_sha: "c".repeat(40) })],
    ["unknown rule", grant(28, { limits: [{ rule_id: "unknown", max_growth: 28 }] })],
    ["duplicate rule", grant(28, { limits: [{ rule_id: id, max_growth: 28 }, { rule_id: id, max_growth: 28 }] })],
    ["above absolute max", grant(1001)],
    ["growth below baseline", grant(1)],
    ["untrusted author", grant(), { trustedAuthorizer: { trusted: false, source: "none" } }],
    ["not a check-pr", grant(), { mode: "check-diff" }],
  ]) {
    const f = facts(28, { grantValue: badGrant, extra });
    expect(label + " rejects authority", authority(f)?.ok, false);
    expect(label + " retains base growth", growth(f)?.ok, false);
  }
  const advisoryRule = { ...old, level: "advisory" };
  expect("advisory rule cannot receive blocking allowance", authority(facts(28, { grantValue: grant(), policyRule: advisoryRule }))?.ok, false);
  const fileRule = { ...old, scope: "file" };
  try { authority(facts(28, { grantValue: grant(), policyRule: fileRule })); expect("invalid file growth rule remains rejected", false, true); }
  catch (error) { expect("invalid file growth rule remains rejected", String(error).includes("file scope"), true); }
  const scopedRule = { ...old, applies_to_change_types: ["other"] };
  expect("inapplicable typed rule rejects allowance", authority(facts(28, { grantValue: grant(), policyRule: scopedRule }))?.ok, false);
  expect("inapplicable typed rule has no numeric growth primitive", growth(facts(28, { grantValue: grant(), policyRule: scopedRule })), undefined);
  expect("no grant affects strictness", compileConstraintIR(ordinary).constraints.find(x => x.name === `size:${id}:max-growth`)?.parameters?.max, 1);
}

console.log(`\n${failures === 0 ? "All C3.3d3 lowering tests passed" : `${failures} C3.3d3 assertion(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
