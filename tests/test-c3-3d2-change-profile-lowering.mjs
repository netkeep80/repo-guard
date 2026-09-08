import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileConstraintProgram, runtimeConstraints } from "../dist/checks/constraint-program.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";
import { compileChangeProfiles } from "../dist/policy-compiler.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
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

function file(path, status = "modified", added = 1, deleted = 0) {
  return {
    path,
    status,
    addedLines: Array.from({ length: added }, (_, index) => `+${index}`),
    deletedLines: Array.from({ length: deleted }, (_, index) => `-${index}`),
  };
}

function policy({ surfaces = {}, classes = {}, profile = {}, canonicalDocs = ["README.md"] } = {}) {
  return {
    paths: {
      forbidden: [],
      canonical_docs: canonicalDocs,
      operational_paths: [],
    },
    surfaces,
    new_file_classes: classes,
    change_profiles: { feature: profile },
  };
}

function profileOutcome(policyValue, changeType, files) {
  try {
    const results = evaluateConstraintIR({
      policy: policyValue,
      changeIntent: changeType === null ? null : { change_type: changeType },
      diff: { files: { checked: files } },
    }, { executionPhase: "transaction" });
    const profileChecks = results.filter((item) => item.name !== "forbidden-paths");
    return {
      ok: profileChecks.every((item) => item.check?.ok === true),
      names: profileChecks.map((item) => item.name),
      checks: profileChecks.map((item) => item.check),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), names: [], checks: [] };
  }
}

console.log("\n--- surface semantics lower without a dedicated evaluator ---");
{
  const surfacePolicy = policy({
    surfaces: { code: ["src/**"], docs: ["docs/**"] },
    profile: { allow_surfaces: ["code"] },
  });
  expect("allowed surface passes", profileOutcome(surfacePolicy, "feature", [file("src/a.mjs")]).ok, true);

  const forbiddenPolicy = policy({
    surfaces: { code: ["src/**"], docs: ["docs/**"] },
    profile: { forbid_surfaces: ["docs"] },
  });
  expect("forbidden surface fails", profileOutcome(forbiddenPolicy, "feature", [file("docs/a.md")]).ok, false);
  expect("deleted files still count as touched forbidden surfaces", profileOutcome(forbiddenPolicy, "feature", [file("docs/old.md", "deleted", 0, 1)]).ok, false);

  const requiredPolicy = policy({
    surfaces: { code: ["src/**"], tests: ["tests/**"] },
    profile: { require_surfaces: ["tests"] },
  });
  expect("required surface present passes", profileOutcome(requiredPolicy, "feature", [file("tests/a.test.mjs")]).ok, true);
  expect("required surface missing fails", profileOutcome(requiredPolicy, "feature", [file("src/a.mjs")]).ok, false);

  const overlapPolicy = policy({
    surfaces: { code: ["src/**"], generated: ["src/generated/**"] },
    profile: { allow_surfaces: ["code"] },
  });
  expect("path touching allowed and disallowed overlapping surfaces fails", profileOutcome(overlapPolicy, "feature", [file("src/generated/a.mjs")]).ok, false);

  const unconstrainedPolicy = policy({
    surfaces: { code: ["src/**"] },
    profile: {},
  });
  expect("unclassified paths are ignored when no surface constraints exist", profileOutcome(unconstrainedPolicy, "feature", [file("misc/a.txt")]).ok, true);

  const emptyAllowSurfacePolicy = policy({
    surfaces: { code: ["src/**"] },
    profile: { allow_surfaces: [] },
  });
  expect("empty allow_surfaces preserves historical no-restriction semantics", profileOutcome(emptyAllowSurfacePolicy, "feature", [file("src/a.mjs"), file("misc/a.txt")]).ok, true);

  const partialSurfacePolicy = policy({
    surfaces: { code: ["src/**"] },
    profile: { allow_surfaces: ["code"], allow_unclassified_surfaces: true },
  });
  expect("allow_unclassified_surfaces permits unclassified paths", profileOutcome(partialSurfacePolicy, "feature", [file("misc/a.txt")]).ok, true);
}

console.log("\n--- new-file class semantics lower through added-path facts ---");
{
  const classPolicy = policy({
    surfaces: { code: ["src/**"] },
    classes: { code: ["src/**"], generated: ["src/generated/**"] },
    profile: { new_files: { allow_classes: ["code"] } },
  });
  expect("allowed new-file class passes", profileOutcome(classPolicy, "feature", [file("src/a.mjs", "added")]).ok, true);
  expect("overlapping disallowed new-file class fails", profileOutcome(classPolicy, "feature", [file("src/generated/a.mjs", "added")]).ok, false);

  const emptyAllowPolicy = policy({
    surfaces: { code: ["src/**"] },
    classes: { code: ["src/**"] },
    profile: { new_files: { allow_classes: [] } },
  });
  expect("empty allow_classes forbids touched declared classes", profileOutcome(emptyAllowPolicy, "feature", [file("src/a.mjs", "added")]).ok, false);

  const unclassifiedPolicy = policy({
    surfaces: { code: ["src/**"] },
    classes: { code: ["src/**"] },
    profile: { new_files: { allow_classes: ["code"] } },
  });
  expect("unclassified new file fails whenever new_files rule exists", profileOutcome(unclassifiedPolicy, "feature", [file("misc/a.txt", "added")]).ok, false);

  const perClassPolicy = policy({
    surfaces: { code: ["src/**"] },
    classes: { code: ["src/**"] },
    profile: { new_files: { allow_classes: ["code"], max_per_class: { code: 1 } } },
  });
  expect("max_per_class is enforced", profileOutcome(perClassPolicy, "feature", [file("src/a.mjs", "added"), file("src/b.mjs", "added")]).ok, false);

  const maxFilesPolicy = policy({
    surfaces: { code: ["src/**"] },
    classes: { code: ["src/**"] },
    profile: { new_files: { allow_classes: ["code"], max_new_files: 1 } },
  });
  expect("new_files.max_new_files is enforced", profileOutcome(maxFilesPolicy, "feature", [file("src/a.mjs", "added"), file("src/b.mjs", "added")]).ok, false);
}

console.log("\n--- profile budgets reuse canonical diff metrics ---");
{
  const docsPolicy = policy({
    surfaces: { docs: ["docs/**"], root: ["README.md"] },
    profile: { budgets: { max_new_docs: 1 } },
    canonicalDocs: ["README.md"],
  });
  expect("canonical docs are excluded from profile max_new_docs", profileOutcome(docsPolicy, "feature", [
    file("README.md", "added"),
    file("docs/a.md", "added"),
  ]).ok, true);
  expect("profile max_new_docs blocks excess non-canonical docs", profileOutcome(docsPolicy, "feature", [
    file("README.md", "added"),
    file("docs/a.md", "added"),
    file("docs/b.md", "added"),
  ]).ok, false);

  const fileBudgetPolicy = policy({
    surfaces: { code: ["src/**"], docs: ["docs/**"] },
    profile: { budgets: { max_new_files: 1 } },
  });
  expect("profile max_new_files is enforced", profileOutcome(fileBudgetPolicy, "feature", [file("src/a.mjs", "added"), file("docs/a.md", "added")]).ok, false);

  const lineBudgetPolicy = policy({
    surfaces: { code: ["src/**"] },
    profile: { budgets: { max_net_added_lines: 2 } },
  });
  expect("profile max_net_added_lines is enforced", profileOutcome(lineBudgetPolicy, "feature", [file("src/a.mjs", "modified", 3, 0)]).ok, false);
}

console.log("\n--- selection is fail-closed frontend compilation, governance remains delegated ---");
{
  const selectionPolicy = policy({
    surfaces: { code: ["src/**"] },
    profile: { allow_surfaces: ["code"] },
  });
  expect("missing change_type fails frontend compilation", compileChangeProfiles(selectionPolicy, null).some((item) => /declared change_type/.test(item.message)), true);
  expect("unknown non-governance change_type fails frontend compilation", compileChangeProfiles(selectionPolicy, "unknown").some((item) => /not defined in change_profiles/.test(item.message)), true);
  expect("governance change_type is accepted by frontend compilation", compileChangeProfiles(selectionPolicy, "governance").length, 0);
  expect("governance change_type emits no ordinary profile runtime", runtimeConstraints(compileConstraintProgram(selectionPolicy, { change_type: "governance" }))
    .some((item) => item.kind === "change_profile" || String(item.relation_id || "").startsWith("change-profile:")), false);
}

console.log("\n--- frontend reference integrity remains compilation validation ---");
{
  const badSurface = policy({
    surfaces: { code: ["src/**"] },
    profile: { allow_surfaces: ["missing"] },
  });
  expect("unknown surface reference fails frontend compilation", compileChangeProfiles(badSurface).some((item) => /unknown surface/.test(item.message)), true);

  const badClass = policy({
    surfaces: { code: ["src/**"] },
    classes: { code: ["src/**"] },
    profile: { new_files: { allow_classes: ["missing"] } },
  });
  expect("unknown class reference fails frontend compilation", compileChangeProfiles(badClass).some((item) => /unknown class/.test(item.message)), true);
}

console.log("\n--- structural ratchet: change_profile runtime and evaluator disappear ---");
{
  const structuralPolicy = policy({
    surfaces: { code: ["src/**"], docs: ["docs/**"] },
    classes: { code: ["src/**"] },
    profile: {
      allow_surfaces: ["code"],
      require_surfaces: ["code"],
      new_files: { allow_classes: ["code"], max_per_class: { code: 1 }, max_new_files: 1 },
      budgets: { max_new_docs: 1, max_new_files: 2, max_net_added_lines: 20 },
    },
  });
  const runtimes = runtimeConstraints(compileConstraintProgram(structuralPolicy, { change_type: "feature" }));
  expect("compiled program contains no change_profile runtime kind", runtimes.some((item) => item.kind === "change_profile"), false);
  expect("profile semantics are emitted as primitive relations", runtimes.filter((item) => String(item.relation_id || "").startsWith("change-profile:")).every((item) => item.kind === "primitive_relation"), true);
  expect("profile lowering emits at least one canonical relation", runtimes.filter((item) => String(item.relation_id || "").startsWith("change-profile:")).length > 0, true);
  expect("source change-profile evaluator is physically deleted", existsSync(resolve(root, "src/checks/rules/change-profiles.mts")), false);
  expect("dist change-profile evaluator is physically deleted", existsSync(resolve(root, "dist/checks/rules/change-profiles.mjs")), false);

  const runtimeSource = read("src/checks/rules/constraints.mts");
  const kindBlock = runtimeSource.match(/type RuntimeConstraintKind =([\s\S]*?);/);
  const runtimeKinds = kindBlock
    ? [...kindBlock[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort()
    : [];
  expect("runtime kind vocabulary is exactly the C3.3d2 target three", runtimeKinds, ["integration", "primitive_relation", "size_rules"]);
}

console.log("\n--- global architecture invariants do not grow ---");
{
  expect("relation descriptor count remains ten", relationDescriptors().length, 10);
  const factSourceMatch = read("src/document-facts.mts").match(/export type FactSource = ([^;]+);/);
  const factSources = factSourceMatch
    ? [...factSourceMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort()
    : [];
  expect("FactRef source vocabulary remains the accepted four", factSources, ["change_intent", "diff", "document", "repository"]);
}

console.log(`\n${failures === 0 ? "C3.3d2 change-profile lowering contract passed" : `C3.3d2 RED confirmed by ${failures} failing probe(s)`}`);
process.exit(failures === 0 ? 0 : 1);
