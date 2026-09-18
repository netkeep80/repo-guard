import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { compileConstraintProgram, runtimeConstraints } from "../dist/checks/constraint-program.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
const json = (path) => JSON.parse(read(path));
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

const ajv = new Ajv({ allErrors: true });
const policySchema = json("schemas/repo-policy.schema.json");
const changeIntentSchema = json("schemas/change-intent.schema.json");
const validatePolicy = ajv.compile(policySchema);
const validateIntent = ajv.compile(changeIntentSchema);

const validIntent = json("tests/fixtures/valid-change-intent.json");
const { surface_debt: _legacyDebt, ...intentWithoutDebt } = validIntent;
const removedDebtIntent = {
  ...intentWithoutDebt,
  surface_debt: {
    kind: "temporary_growth",
    reason: "historical form",
    expected_delta: { max_new_files: 1 },
    repayment_issue: 400,
  },
};
expect("public ChangeIntent schema rejects removed surface_debt", validateIntent(removedDebtIntent), false);
expect("surface_debt property is physically absent from ChangeIntent schema", changeIntentSchema.properties?.surface_debt, undefined);

const validPolicy = json("tests/fixtures/valid-policy.json");
const removedRegistryPolicy = {
  ...validPolicy,
  registry_rules: [{
    id: "legacy-registry",
    kind: "set_equality",
    left: { type: "json_array", file: "a.json", json_pointer: "/items" },
    right: { type: "json_array", file: "b.json", json_pointer: "/items" },
  }],
};
expect("public repo-policy schema rejects removed registry_rules", validatePolicy(removedRegistryPolicy), false);
expect("registry_rules property is physically absent from repo-policy schema", policySchema.properties?.registry_rules, undefined);
expect("registry_source DSL definition is physically absent", policySchema.definitions?.registry_source, undefined);

const legacyRuntime = runtimeConstraints(compileConstraintProgram(removedRegistryPolicy, removedDebtIntent));
expect(
  "constraint compiler emits no historical surface_debt runtime",
  legacyRuntime.some((item) => item.kind === "surface_debt"),
  false,
);
expect(
  "constraint compiler emits no historical registry_rules runtime",
  legacyRuntime.some((item) => item.kind === "registry_rules"),
  false,
);

const compilerSource = read("src/checks/constraint-program.mts");
expect(
  "constraint compiler source contains no historical debt or registry runtime emission",
  compilerSource.includes("surface_debt") || compilerSource.includes("registry_rules") || compilerSource.includes("runtime:registry-rules"),
  false,
);

const runtimeSource = read("src/checks/rules/constraints.mts");
expect(
  "runtime evaluator contains no surface debt kind or dedicated helper",
  runtimeSource.includes('"surface_debt"') || runtimeSource.includes("checkSurfaceDebt") || runtimeSource.includes("SurfaceDebt"),
  false,
);
expect(
  "runtime evaluator contains no registry rules kind or dedicated helper",
  runtimeSource.includes('"registry_rules"') || runtimeSource.includes("checkRegistryRules"),
  false,
);

expect("source registry evaluator is physically deleted", existsSync(resolve(root, "src/checks/rules/registry-rules.mts")), false);
expect("dist registry evaluator is physically deleted", existsSync(resolve(root, "dist/checks/rules/registry-rules.mjs")), false);

const kindBlock = runtimeSource.match(/type RuntimeConstraintKind =([\s\S]*?);/);
const runtimeKinds = kindBlock
  ? [...kindBlock[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort()
  : [];
const d1AcceptedTail = new Set([
  "change_profile",
  "integration",
  "primitive_relation",
  "size_rules",
]);
expect(
  "runtime vocabulary introduces no kind outside the C3.3d1 accepted tail",
  runtimeKinds.every((kind) => d1AcceptedTail.has(kind)),
  true,
);

const selfPolicy = read("repo-policy.json");
expect(
  "self-hosted repo policy consumes neither deleted concept",
  selfPolicy.includes("surface_debt") || selfPolicy.includes("registry_rules"),
  false,
);
expect("relation descriptor count remains ten", relationDescriptors().length, 10);

const factSourceMatch = read("src/document-facts.mts").match(/export type FactSource = ([^;]+);/);
const factSources = factSourceMatch
  ? [...factSourceMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort()
  : [];
expect("FactRef source vocabulary remains the accepted four", factSources, [
  "change_intent",
  "diff",
  "document",
  "repository",
]);

console.log(`\n${failures === 0 ? "C3.3d1 runtime-tail deletion contract passed" : `C3.3d1 RED confirmed by ${failures} failing probe(s)`}`);
process.exit(failures === 0 ? 0 : 1);
