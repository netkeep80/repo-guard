import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
let failures = 0;

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS: ${label}`);
  } catch {
    failures++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

for (const path of ["src/checks/trace-rules.mts", "dist/checks/trace-rules.mjs"]) {
  expect(`${path} is physically deleted`, existsSync(resolve(root, path)), false);
}

const consumers = [
  "src/checks/constraint-program.mts",
  "src/checks/rules/constraints.mts",
  "src/reporting/anchor-diagnostics.mts",
];
for (const path of consumers) {
  const source = readFileSync(resolve(root, path), "utf-8");
  expect(`${path} does not call buildTraceRuleDiagnostics`, source.includes("buildTraceRuleDiagnostics"), false);
  expect(`${path} does not call checkTraceRuleResult`, source.includes("checkTraceRuleResult"), false);
}

console.log(`\n${failures === 0 ? "C3.3b physical trace evaluator deletion contract passed" : `C3.3b deletion RED confirmed by ${failures} failing probe(s)`}`);
process.exit(failures === 0 ? 0 : 1);
