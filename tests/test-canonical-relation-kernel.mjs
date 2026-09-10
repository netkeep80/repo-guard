import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readFact } from "../dist/document-facts.mjs";
import {
  relationDescriptor,
  relationDescriptors,
} from "../dist/checks/relation-kernel.mjs";
import { observeImmutable } from "./support/immutable-observation.mjs";

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
  "one relation descriptor table owns public and internal canonical relation kinds",
  descriptorKinds.join(","),
  expectedKinds.join(",")
);
expect(
  "public relation surface remains the established seven document relations",
  publicKinds.join(","),
  expectedPublicKinds.join(",")
);

const schema = JSON.parse(source("schemas/repo-policy.schema.json"));
const schemaKinds = schema.definitions.document_relation_rule.oneOf
  .map((form) => form.properties?.kind?.const)
  .filter((kind) => typeof kind === "string")
  .sort();
expect(
  "schema document relation kinds exactly match public canonical descriptors",
  schemaKinds.join(","),
  publicKinds.join(",")
);

const transition = relationDescriptor("scalar_strictly_greater");
expect("transition relation phase comes from descriptor", transition.phase, "transaction");
expect("transition relation operands come from descriptor", transition.operands.join(","), "left,right");
expect("transition relation has evaluator binding", typeof transition.evaluate, "function");
expect("transition relation has explicit strictness semantics", Boolean(transition.strictness), true);
expect("transition relation has stable identity inputs", transition.identity.join(","), "id");

for (const kind of expectedInternalKinds) {
  expect(`${kind} is internal canonical semantics`, relationDescriptor(kind).public, false);
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

for (const file of [
  "src/policy-compiler.mts",
  "src/checks/constraint-program.mts",
  "src/checks/rules/constraints.mts",
]) {
  const text = source(file);
  const duplicated = expectedPublicKinds.filter((kind) => text.includes(`"${kind}"`));
  expect(`${file} has no independent public relation-kind switch`, duplicated.join(","), "");
}

expect("old selector type is deleted", source("src/document-facts.mts").includes("DocumentFactSelector"), false);
expect("old selector reader is deleted", source("src/document-facts.mts").includes("readDocumentFact"), false);

const compressionMetrics = JSON.parse(observeImmutable(
  process.execPath,
  ["scripts/compression-metrics.mjs", "--ref", "HEAD"],
));
const c31 = compressionMetrics.architecture;
expect("compression metrics see one canonical FactRef model", c31.canonical_factref_model_count, 1);
expect("compression metrics see one primitive descriptor registry", c31.primitive_descriptor_registry_count, 1);
expect("compression metrics see all canonical descriptor kinds", c31.primitive_descriptor_kinds.join(","), expectedKinds.join(","));
expect("compression metrics see established public descriptor kinds", c31.public_primitive_descriptor_kinds.join(","), expectedPublicKinds.join(","));
expect("compression metrics prove schema and public descriptor parity", c31.schema_relation_kinds_match_descriptors, true);
expect("compression metrics see one generic primitive runtime shape", c31.primitive_runtime_shape_count, 1);
expect("compression metrics see no downstream public relation switches", c31.independent_document_relation_switches, 0);
expect("new primitive requires one semantic kernel edit-site", c31.semantic_edit_sites_per_new_primitive, 1);

if (failures) {
  console.error(`\n${failures} canonical relation kernel assertion(s) failed.`);
  process.exit(1);
}

console.log("\nCanonical relation kernel contract passed.");
