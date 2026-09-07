import { readFileSync } from "node:fs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

let failures = 0;

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${expected}, got: ${actual}`);
  }
}

const source = (path) => readFileSync(path, "utf8");
const constraints = source("src/checks/rules/constraints.mts");
const documentFacts = source("src/document-facts.mts");
const declaration = (start, end) => {
  const from = documentFacts.indexOf(start);
  const to = documentFacts.indexOf(end, from);
  return from >= 0 && to > from ? documentFacts.slice(from, to) : "";
};
const factRef = declaration("export type FactRef =", "\ntype DocumentRef");
const diffSelector = declaration("export type DiffFactSelector =", "\nexport type DocumentFactErrorCode");

const historicalRuntimeKinds = [
  "max_metric",
  "scope_paths",
  "require_paths",
  "forbid_paths",
  "implies_nonempty",
  "cochange_group",
];

for (const kind of historicalRuntimeKinds) {
  expect(`historical runtime kind ${kind} is deleted`, constraints.includes(`\"${kind}\"`), false);
}

const factSources = [...factRef.matchAll(/\bsource\s*:\s*"([^"]+)"/g)].map((match) => match[1]).sort();
expect("canonical FactRef has exactly the finite document/diff source alternatives", factSources.join(","), "diff,document");
expect("canonical FactRef keeps one selector per source alternative", (factRef.match(/\bselector\s*:/g) || []).length, 2);
const diffSelectorKinds = [...diffSelector.matchAll(/\bkind\s*:\s*([^;]+);/g)]
  .flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]))
  .sort();
expect("diff selector vocabulary is finite", diffSelectorKinds.join(","), "changed_paths,metric,path_count");
expect("no compatibility document selector model is reintroduced", documentFacts.includes("DocumentFactSelector"), false);

const descriptorKinds = new Set(relationDescriptors().map((descriptor) => descriptor.kind));
for (const kind of ["numeric_bound", "set_presence_implies", "set_all_or_none"]) {
  expect(`generic relation descriptor ${kind} exists`, descriptorKinds.has(kind), true);
}

const forbiddenVocabulary = [
  "scope_relation",
  "must_touch_relation",
  "must_not_touch_relation",
  "budget_relation",
  "cochange_relation",
];
const kernel = source("src/checks/relation-kernel.mts");
for (const name of forbiddenVocabulary) {
  expect(`kernel has no historical/domain primitive ${name}`, kernel.includes(name), false);
}

if (failures) {
  console.error(`\n${failures} C3.3a historical-lowering assertion(s) failed.`);
  process.exit(1);
}

console.log("\nC3.3a historical runtime lowering contract passed.\n");