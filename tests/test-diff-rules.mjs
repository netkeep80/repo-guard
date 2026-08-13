import assert from "node:assert/strict";
import { classifyNewFiles, detectTouchedSurfaces } from "../dist/diff/classification.mjs";
import { filterOperationalPaths } from "../dist/diff/filters.mjs";
import { parseDiff } from "../dist/diff/parser.mjs";
import { checkAdvisoryTextRules } from "../dist/checks/rules/advisory-text-rules.mjs";
import { checkChangeProfile } from "../dist/checks/rules/change-profiles.mjs";
import { checkContentRules } from "../dist/checks/rules/content-rules.mjs";
import {
  checkCanonicalDocsBudget, checkCochangeRules, checkForbiddenPaths, checkMustNotTouch, checkMustTouch,
  checkNetAddedLinesBudget, checkNewFilesBudget, checkScope, checkSurfaceDebt,
} from "../dist/checks/rules/constraints.mjs";
import { checkRegistryRules } from "../dist/checks/rules/registry-rules.mjs";
import { checkSizeRules, countTextLines } from "../dist/checks/rules/size-rules.mjs";

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
assert.deepEqual(checkForbiddenPaths(files, ["*.bak"]), []);
assert.equal(checkNewFilesBudget(files, 1).ok, true);
assert.equal(checkNetAddedLinesBudget(files, 2).actual, 2);
assert.equal(checkCanonicalDocsBudget(files, ["README.md"], 0).ok, true);
assert.equal(checkCochangeRules(files, [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }]).length, 0);
assert.equal(checkMustTouch(files, ["tests/**"]).ok, true);
assert.equal(checkMustNotTouch(files, ["schemas/**"]).ok, true);
assert.equal(checkScope(files, ["src/**", "tests/**"]).ok, true);
assert.deepEqual(checkScope(files, ["src/**"]).out_of_scope_paths, ["tests/a.test.mjs"]);
assert.equal(checkScope([{ ...files[0], status: "deleted" }], ["src/**"]).ok, true);
assert.equal(checkScope(files, null).ok, true);

const forbidden = [{ path: "backup.bak", status: "added", addedLines: ["x"], deletedLines: [] }];
assert.deepEqual(checkForbiddenPaths(forbidden, ["*.bak"]), ["backup.bak"]);
assert.deepEqual(checkForbiddenPaths([{ ...forbidden[0], status: "deleted" }], ["*.bak"]), []);
assert.equal(checkMustNotTouch(files, ["src/**"]).ok, false);
assert.equal(checkMustTouch(files, ["docs/**"]).ok, false);
assert.equal(checkCochangeRules(files.slice(0, 1), [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }]).length, 1);

const growth = [{ path: "src/new.mjs", status: "added", addedLines: new Array(5).fill("x"), deletedLines: [] }];
assert.equal(checkSurfaceDebt(growth, null).status, "undeclared");
assert.equal(checkSurfaceDebt(growth, { kind: "temporary_growth", reason: "temporary", expected_delta: { max_new_files: 1, max_net_added_lines: 5 }, repayment_issue: 1 }).status, "declared");
assert.equal(checkSurfaceDebt(growth, { kind: "temporary_growth", reason: "temporary", expected_delta: { max_new_files: 0 }, repayment_issue: 1 }).status, "declared_debt_exceeded");

const filtered = filterOperationalPaths([...files, { path: ".claude/state.json", status: "added", addedLines: ["{}"], deletedLines: [] }], [".claude/**"]);
assert.equal(filtered.length, 2);
assert.equal(checkScope(filtered, ["src/**", "tests/**"]).ok, true);

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
