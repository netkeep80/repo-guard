import assert from "node:assert/strict";
import { classifyNewFiles, detectTouchedSurfaces } from "../dist/diff/classification.mjs";
import { filterOperationalPaths } from "../dist/diff/filters.mjs";
import { parseDiff } from "../dist/diff/parser.mjs";
import { checkAdvisoryTextRules } from "../dist/checks/rules/advisory-text-rules.mjs";
import { checkChangeProfile } from "../dist/checks/rules/change-profiles.mjs";
import { checkContentRules } from "../dist/checks/rules/content-rules.mjs";
import { checkSurfaceDebt, evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";
import { checkRegistryRules } from "../dist/checks/rules/registry-rules.mjs";
import { checkSizeRules, countTextLines } from "../dist/checks/rules/size-rules.mjs";

const constraintResults = (checked, policy = {}, changeIntent = null) => evaluateConstraintIR({
  diff: { files: { checked } },
  policy,
  changeIntent,
});
const checkNamed = (results, name) => {
  const entry = results.find((result) => result.name === name);
  assert.ok(entry, `missing canonical constraint result: ${name}`);
  return entry.check;
};

const sampleDiff = [
  "diff --git a/src/app.mjs b/src/app.mjs", "new file mode 100644", "--- /dev/null", "+++ b/src/app.mjs", "+one", "+two",
  "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "-old", "+new",
].join("\n");
const parsed = parseDiff(sampleDiff);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].status, "added");
assert.equal(parsed[0].addedLines.length, 2);
assert.equal(parsed[1].deletedLines.length, 1);

const files = [
  { path: "src/a.mjs", status: "modified", addedLines: ["a", "b"], deletedLines: ["old"] },
  { path: "tests/a.test.mjs", status: "added", addedLines: ["test"], deletedLines: [] },
];
const canonicalResults = constraintResults(files, {
  paths: { forbidden: ["*.bak"], canonical_docs: ["README.md"] },
  diff_rules: { max_new_docs: 0, max_new_files: 1, max_net_added_lines: 2 },
  cochange_rules: [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }],
}, {
  scope: ["src/**", "tests/**"],
  must_touch: ["tests/**"],
  must_not_touch: ["schemas/**"],
  budgets: {},
});
assert.equal(checkNamed(canonicalResults, "forbidden-paths").ok, true);
assert.equal(checkNamed(canonicalResults, "max-new-files").ok, true);
assert.equal(checkNamed(canonicalResults, "max-net-added-lines").actual, 2);
assert.equal(checkNamed(canonicalResults, "canonical-docs-budget").ok, true);
assert.equal(checkNamed(canonicalResults, "cochange: src/** -> tests/**").ok, true);
assert.equal(checkNamed(canonicalResults, "must-touch").ok, true);
assert.equal(checkNamed(canonicalResults, "must-not-touch").ok, true);
assert.equal(checkNamed(canonicalResults, "change-intent-scope").ok, true);

const scopeFailure = constraintResults(files, {}, { scope: ["src/**"], must_touch: [], must_not_touch: [], budgets: {} });
assert.equal(checkNamed(scopeFailure, "change-intent-scope").ok, false);
assert.equal(checkNamed(scopeFailure, "change-intent-scope").actual, 1);
const deletedScope = constraintResults([{ ...files[0], status: "deleted" }], {}, { scope: ["src/**"], must_touch: [], must_not_touch: [], budgets: {} });
assert.equal(checkNamed(deletedScope, "change-intent-scope").ok, true);
const emptyScope = constraintResults(files, {}, { scope: null, must_touch: [], must_not_touch: [], budgets: {} });
assert.equal(emptyScope.some((result) => result.name === "change-intent-scope"), false);

const forbidden = [{ path: "backup.bak", status: "added", addedLines: ["x"], deletedLines: [] }];
assert.equal(checkNamed(constraintResults(forbidden, { paths: { forbidden: ["*.bak"] } }), "forbidden-paths").ok, false);
assert.equal(checkNamed(constraintResults([{ ...forbidden[0], status: "deleted" }], { paths: { forbidden: ["*.bak"] } }), "forbidden-paths").ok, true);
assert.equal(checkNamed(constraintResults(files, {}, { scope: [], must_touch: [], must_not_touch: ["src/**"], budgets: {} }), "must-not-touch").ok, false);
assert.equal(checkNamed(constraintResults(files, {}, { scope: [], must_touch: ["docs/**"], must_not_touch: [], budgets: {} }), "must-touch").ok, false);
assert.equal(checkNamed(constraintResults(files.slice(0, 1), {
  cochange_rules: [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }],
}), "cochange: src/** -> tests/**").ok, false);

const growth = [{ path: "src/new.mjs", status: "added", addedLines: new Array(5).fill("x"), deletedLines: [] }];
assert.equal(checkSurfaceDebt(growth, null).status, "undeclared");
assert.equal(checkSurfaceDebt(growth, { kind: "temporary_growth", reason: "temporary", expected_delta: { max_new_files: 1, max_net_added_lines: 5 }, repayment_issue: 1 }).status, "declared");
assert.equal(checkSurfaceDebt(growth, { kind: "temporary_growth", reason: "temporary", expected_delta: { max_new_files: 0 }, repayment_issue: 1 }).status, "declared_debt_exceeded");

const filtered = filterOperationalPaths([...files, { path: ".claude/state.json", status: "added", addedLines: ["{}"], deletedLines: [] }], [".claude/**"]);
assert.equal(filtered.length, 2);
assert.equal(checkNamed(constraintResults(filtered, {}, { scope: ["src/**", "tests/**"], must_touch: [], must_not_touch: [], budgets: {} }), "change-intent-scope").ok, true);

const surfaces = detectTouchedSurfaces(files, { source: ["src/**"], tests: ["tests/**"] });
assert.deepEqual(surfaces.touched_surfaces, ["source", "tests"]);
const classes = classifyNewFiles(files, { source: ["src/**"], test: ["tests/**"] });
assert.deepEqual(classes.files_by_class.test, ["tests/a.test.mjs"]);

const contentViolations = checkContentRules([{ path: "include/a.h", status: "modified", addedLines: ["/// @brief bad"], deletedLines: [] }], [{ id: "no-brief", glob: "include/**/*.h", mode: "added_lines", forbid_regex: ["@brief"] }]);
assert.equal(contentViolations.length, 1);

const profilePolicy = {
  paths: { canonical_docs: ["README.md"] }, surfaces: { source: ["src/**"], tests: ["tests/**"] },
  new_file_classes: { source: ["src/**"], test: ["tests/**"] },
  change_profiles: { refactor: { allow_surfaces: ["source", "tests"], new_files: { allow_classes: ["test"] }, budgets: { max_new_files: 1, max_net_added_lines: 2 } } },
};
assert.equal(checkChangeProfile(files, profilePolicy, "refactor").ok, true);
assert.equal(checkChangeProfile(files, profilePolicy, "feature").ok, false);

const readFile = (path) => ({
  "src/a.mjs": "one\ntwo\n", "docs/new.md": "# Same\nalpha beta gamma delta\n", "README.md": "# Same\nalpha beta gamma delta\n",
  "registry.json": JSON.stringify({ files: ["docs/a.md"] }), "INDEX.md": "## Files\n- [A](docs/a.md)\n",
}[path]);
const size = checkSizeRules(files, [{ id: "src-lines", scope: "file", metric: "lines", glob: "src/**", max: 2 }], { trackedFiles: ["src/a.mjs"], readFile });
assert.equal(size.ok, true);
assert.equal(countTextLines("a\nb\n"), 2);

const advisory = checkAdvisoryTextRules([{ path: "docs/new.md", status: "added", addedLines: [] }], { canonical_files: ["README.md"], warn_on_similarity_above: 0.5 }, { allFiles: ["README.md", "docs/new.md"], readFile });
assert.equal(advisory.advisory, true);
assert.equal(advisory.matches.length, 1);

const registry = checkRegistryRules([{ id: "docs-index", kind: "set_equality", left: { type: "json_array", file: "registry.json", json_pointer: "/files" }, right: { type: "markdown_section_links", file: "INDEX.md", section: "Files" } }], { readFile });
assert.equal(registry.ok, true);

console.log("Canonical diff/rule primitive tests passed.");
