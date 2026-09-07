import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  relationDescriptor,
  relationDescriptors,
} from "../dist/checks/relation-kernel.mjs";

let failures = 0;

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${expected}, got: ${actual}`);
  }
}

function source(path) {
  return readFileSync(resolve(path), "utf8");
}

const expectedKinds = [
  "referenced_paths_exist",
  "referenced_pointer_exists",
  "scalar_equal",
  "scalar_equals_literal",
  "scalar_strictly_greater",
  "set_equal",
  "set_subset",
].sort();

const descriptors = relationDescriptors();
expect(
  "one relation descriptor table owns every public document relation kind",
  descriptors.map((item) => item.kind).sort().join(","),
  expectedKinds.join(",")
);

const transition = relationDescriptor("scalar_strictly_greater");
expect("transition relation phase comes from descriptor", transition.phase, "transaction");
expect("transition relation operands come from descriptor", transition.operands.join(","), "left,right");
expect("transition relation has evaluator binding", typeof transition.evaluate, "function");
expect("transition relation has explicit strictness semantics", Boolean(transition.strictness), true);
expect("transition relation has stable identity inputs", transition.identity.join(","), "id");

let unknownError = "";
try {
  relationDescriptor("unknown_relation");
} catch (error) {
  unknownError = error.message;
}
expect("unknown relation fails closed", unknownError.includes("unknown relation"), true);

for (const file of [
  "src/policy-compiler.mts",
  "src/checks/constraint-program.mts",
  "src/checks/rules/constraints.mts",
]) {
  const text = source(file);
  const duplicated = expectedKinds.filter((kind) => text.includes(`\"${kind}\"`));
  expect(`${file} has no independent public relation-kind switch`, duplicated.join(","), "");
}

if (failures) {
  console.error(`\n${failures} canonical relation kernel assertion(s) failed.`);
  process.exit(1);
}

console.log("\nCanonical relation kernel contract passed.");
