import { defaultRuleFamilies } from "../src/checks/default-rule-families.mjs";
import { checkContentRules } from "../src/checks/rules/content-rules.mjs";
import { compileConstraintIR, evaluateConstraintIR } from "../src/checks/rules/constraints.mjs";
import { comparePolicyStrictness } from "../src/checks/rules/policy-delta-rules.mjs";
import { checkSizeRules } from "../src/checks/rules/size-rules.mjs";
import { parseMarkdown } from "../src/document-facts.mjs";
import { classifyPathSets, selectPaths } from "../src/diff/classification.mjs";

let failures = 0;
function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${expected}, got: ${actual}`);
  }
}
expect("relation-like runtime rules collapse into six default families", defaultRuleFamilies.length, 6);

const markdown = parseMarkdown("# Заголовок\nТекст [ссылка](docs/a.md)\n```js\ncode()\n```\nПосле\n");
expect("document facts parse headings once", markdown.headings[0].text, "Заголовок");
expect("document facts expose links", markdown.links[0].target, "docs/a.md");
expect("document facts exclude fenced code from prose", markdown.proseLines.some((line) => line.text.includes("code()")), false);

const selectorFiles = [
  { path: "src/a.mjs", status: "modified", addedLines: ["x"], deletedLines: [] },
  { path: "tests/a.test.mjs", status: "added", addedLines: ["t"], deletedLines: [] },
  { path: "docs/old.md", status: "deleted", addedLines: [], deletedLines: ["old"] },
];
const selected = classifyPathSets(selectorFiles, { source: ["src/**"], tests: ["tests/**"] });
expect("named selectors expose touched sets", selected.touched_selectors.join(","), "source,tests");
expect("named selectors expose unclassified files", selected.unclassified_files.join(","), "docs/old.md");
expect("selector status view isolates additions", selectPaths(selectorFiles, ["**"], { statuses: ["added"] }).join(","), "tests/a.test.mjs");

const constraintFacts = {
  diff: { files: { checked: selectorFiles } },
  policy: {
    paths: { forbidden: ["*.bak"], canonical_docs: [], operational_paths: [] },
    diff_rules: { max_new_docs: 0, max_new_files: 2, max_net_added_lines: 5 },
    cochange_rules: [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }],
  },
  contract: { must_touch: ["src/**"], must_not_touch: ["schemas/**"], budgets: {} },
};
const constraintIR = compileConstraintIR(constraintFacts);
expect("policy frontends compile into primitive constraints", constraintIR.constraints.some((c) => c.kind === "implies_nonempty"), true);
expect("constraint kernel preserves familiar result names", evaluateConstraintIR(constraintFacts).some((r) => r.name === "must-touch" && r.check.ok), true);

const strictnessBase = {
  enforcement: { mode: "blocking" },
  paths: { forbidden: ["secret/**"], governance_paths: ["repo-policy.json"], canonical_docs: [], operational_paths: [] },
  diff_rules: { max_new_files: 5 },
  size_rules: [{ id: "src", scope: "directory", glob: "src/**", metric: "lines", max: 100, max_growth: 0, level: "blocking", count: "all_tracked" }],
  content_rules: [],
};
const weakerPolicy = structuredClone(strictnessBase);
weakerPolicy.diff_rules.max_new_files = 10;
expect("Constraint Program detects monotonic weakening", comparePolicyStrictness(strictnessBase, weakerPolicy).relation, "weaker");
const stricterPolicy = structuredClone(strictnessBase);
stricterPolicy.diff_rules.max_new_files = 3;
expect("Constraint Program detects monotonic tightening", comparePolicyStrictness(strictnessBase, stricterPolicy).relation, "stricter");
const growthWeakened = structuredClone(strictnessBase);
growthWeakened.size_rules[0].max_growth = 1;
expect("Constraint Program protects compression max_growth", comparePolicyStrictness(strictnessBase, growthWeakened).relation, "weaker");
const unknownChange = structuredClone(strictnessBase);
unknownChange.content_rules.push({ id: "x", glob: "**", mode: "added_lines", forbid_regex: ["x"] });
expect("unknown policy semantics fail closed as incomparable", comparePolicyStrictness(strictnessBase, unknownChange).relation, "incomparable");

const currentFiles = new Map([
  ["docs/a.md", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n"],
  ["docs/b.md", "a\nb\nc\n"],
  ["README.md", "# Русский документ\n\nОбычный русский текст с `SomeClass` и API.\n\n```text\nCurrent production contract\n```\n"],
]);
const readFile = (path) => currentFiles.get(path) ?? null;
const balancedDiff = [
  { path: "docs/a.md", status: "modified", addedLines: ["n1", "n2"], deletedLines: ["o1", "o2", "o3", "o4", "o5"] },
  { path: "docs/b.md", status: "added", addedLines: ["a", "b", "c"], deletedLines: [] },
];
const lineRule = { id: "docs-lines", scope: "directory", metric: "lines", glob: "docs/**", max: 20, max_growth: 0 };
const lineResult = checkSizeRules(balancedDiff, [lineRule], { trackedFiles: ["docs/a.md", "docs/b.md"], readFile });
expect("line surface passes when net growth is zero", lineResult.ok, true);
expect("line surface reports before", lineResult.growth[0].before, 13);
expect("line surface reports after", lineResult.growth[0].after, 13);
expect("line surface reports delta", lineResult.growth[0].delta, 0);

const growingDiff = [{ path: "docs/a.md", status: "modified", addedLines: ["n1", "n2"], deletedLines: ["o1"] }];
const growingResult = checkSizeRules(growingDiff, [lineRule], { trackedFiles: ["docs/a.md", "docs/b.md"], readFile });
expect("line surface blocks positive growth", growingResult.ok, false);
expect("line surface growth violation kind", growingResult.size_violations[0].kind, "growth");
expect("line surface positive delta", growingResult.growth[0].delta, 1);
const shrinkRequired = checkSizeRules(balancedDiff, [{ ...lineRule, max_growth: -1 }], { trackedFiles: ["docs/a.md", "docs/b.md"], readFile });
expect("negative max_growth can require shrinkage", shrinkRequired.ok, false);

const fileRule = { id: "contract-files", scope: "directory", metric: "files", glob: "contracts/**", max: 10, max_growth: 0 };
const fileGrowth = checkSizeRules([
  { path: "contracts/new.json", status: "added", addedLines: ["{}"], deletedLines: [] },
], [fileRule], { trackedFiles: ["contracts/old.json", "contracts/new.json"], readFile });
expect("file-count surface blocks a new file", fileGrowth.ok, false);
expect("file-count delta is one", fileGrowth.growth[0].delta, 1);
expect("file-count before is reconstructed", fileGrowth.growth[0].before, 1);
expect("file-count after is current count", fileGrowth.growth[0].after, 2);

const byteGrowth = checkSizeRules(balancedDiff, [{ id: "docs-bytes", scope: "directory", metric: "bytes", glob: "docs/**", max: 1000, max_growth: 0 }], {
  trackedFiles: ["docs/a.md", "docs/b.md"], readFile,
});
expect("byte max_growth fails closed until exact base-byte measurement exists", byteGrowth.ok, false);
expect("byte max_growth reports a read/evaluation error", byteGrowth.errors.length, 1);

const russianRule = {
  id: "russian-docs", glob: "README.md", mode: "markdown_language", language: "ru",
  allow_words: ["API"], max_unapproved_latin_words_per_line: 1,
};
const readmeChange = [{ path: "README.md", status: "modified", addedLines: ["изменение"], deletedLines: [] }];
expect("Russian Markdown ignores inline/fenced code", checkContentRules(readmeChange, [russianRule], { readFile }).length, 0);
currentFiles.set("README.md", "# Документ\n\nCurrent production contract.\n");
const englishResult = checkContentRules(readmeChange, [russianRule], { readFile });
expect("English prose is rejected", englishResult.length, 1);
expect("language violation kind", englishResult[0].kind, "language");
expect("language violation line", englishResult[0].line_number, 3);
currentFiles.set("README.md", "# Документ\n\nИспользуется semantic contract.\n");
expect("multiple mixed Latin terms are rejected", checkContentRules(readmeChange, [russianRule], { readFile }).length, 1);
currentFiles.set("README.md", "# Документ\n\nИспользуется API.\n");
expect("allow-listed technical term passes", checkContentRules(readmeChange, [russianRule], { readFile }).length, 0);

if (failures > 0) {
  console.error(`\n${failures} compression-rule test(s) failed`);
  process.exit(1);
}
console.log("\nAll compression-rule tests passed");
