import { readFact } from "../dist/document-facts.mjs";
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

const expectedPublicKinds = [
  "referenced_paths_exist",
  "referenced_pointer_exists",
  "scalar_equal",
  "scalar_equals_literal",
  "scalar_strictly_greater",
  "set_equal",
  "set_subset",
].sort();
const expectedInternalKinds = [
  "numeric_bound",
  "set_all_or_none",
  "set_presence_implies",
].sort();
const expectedKinds = [...expectedPublicKinds, ...expectedInternalKinds].sort();

const descriptors = relationDescriptors();
const descriptorKinds = descriptors.map((item) => item.kind).sort();
const publicKinds = descriptors.filter((item) => item.public).map((item) => item.kind).sort();
expect(
  "one relation descriptor table owns public and internal generic relation kinds",
  descriptorKinds.join(","),
  expectedKinds.join(","),
);
expect(
  "public relation surface remains the established seven document relations",
  publicKinds.join(","),
  expectedPublicKinds.join(","),
);

const transition = relationDescriptor("scalar_strictly_greater");
expect("transition relation phase comes from descriptor", transition.phase, "transaction");
expect("transition relation operands come from descriptor", transition.operands.join(","), "left,right");
expect("transition relation has evaluator binding", typeof transition.evaluate, "function");
expect("transition relation has explicit strictness semantics", Boolean(transition.strictness), true);
expect("transition relation has stable identity inputs", transition.identity.join(","), "id");

for (const kind of expectedInternalKinds) {
  expect(`${kind} is internal generic semantics`, relationDescriptor(kind).public, false);
}

let unknownError = "";
try {
  relationDescriptor("unknown_relation");
} catch (error) {
  unknownError = error.message;
}
expect("unknown relation fails closed", unknownError.includes("unknown relation"), true);

const stateDocument = { version: "3.1.0" };
const documents = {
  text: () => "3.1.0\n",
  markdown: () => { throw new Error("not used"); },
  json: () => stateDocument,
  yaml: () => { throw new Error("not used"); },
};
const stateFact = readFact({ documents }, {
  source: "document",
  selector: { path: "meta.json", format: "json", snapshot: "state", pointer: "/version" },
  type: "string",
});
expect("FactRef reads typed state facts", stateFact.ok ? stateFact.value : stateFact.error.code, "3.1.0");

const snapshotContext = {
  baseRef: "BASE",
  headRef: "HEAD",
  readFileAtRef: (ref, path) => `${ref === "BASE" ? "3.0.0" : "3.1.0"}\n`,
};
const baseFact = readFact(snapshotContext, {
  source: "document",
  selector: { path: "VERSION", format: "plain_text", snapshot: "base", pointer: "" },
  type: "string",
});
const headFact = readFact(snapshotContext, {
  source: "document",
  selector: { path: "VERSION", format: "plain_text", snapshot: "head", pointer: "" },
  type: "string",
});
expect("FactRef reads BASE through the same boundary", baseFact.ok ? baseFact.value : baseFact.error.code, "3.0.0");
expect("FactRef reads HEAD through the same boundary", headFact.ok ? headFact.value : headFact.error.code, "3.1.0");

const diff = {
  files: {
    checked: [
      { path: "src/a.mts", status: "modified", addedLines: ["x"], deletedLines: [] },
      { path: "docs/new.md", status: "added", addedLines: ["# New"], deletedLines: [] },
    ],
  },
};
const changedPaths = readFact({ diff }, {
  source: "diff",
  selector: { kind: "changed_paths", patterns: ["src/**"] },
  type: "repository_path_set",
});
const addedFiles = readFact({ diff }, {
  source: "diff",
  selector: { kind: "metric", metric: "new_files" },
  type: "scalar",
});
expect("FactRef reads typed diff path facts", changedPaths.ok ? changedPaths.value.join(",") : changedPaths.error.code, "src/a.mts");
expect("FactRef reads typed diff metric facts", addedFiles.ok ? addedFiles.value : addedFiles.error.code, 1);

const missingBase = readFact({ ...snapshotContext, baseRef: null }, {
  source: "document",
  selector: { path: "VERSION", format: "plain_text", snapshot: "base", pointer: "" },
  type: "string",
});
expect("FactRef snapshot reads fail closed", missingBase.ok, false);

if (failures) {
  console.error(`\n${failures} generic relation kernel assertion(s) failed.`);
  process.exit(1);
}

console.log("\nGeneric relation kernel contract passed.");
