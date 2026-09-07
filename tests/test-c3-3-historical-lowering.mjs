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
const factRef = documentFacts.match(/export\s+(?:interface|type)\s+FactRef\b[\s\S]*?(?:\n}\n|;\n)/)?.[0] || "";

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

expect("canonical FactRef declares a typed fact source", /\bsource\s*:/.test(factRef), true);
expect("canonical FactRef declares a finite selector", /\bselector\s*:/.test(factRef), true);

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

console.log("\nC3.3a historical runtime lowering contract passed.");
