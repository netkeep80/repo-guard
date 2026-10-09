import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../dist/document-facts.mjs";
import { checkRequirementTransition, normalizeRequirementAuthority } from "../dist/requirement-relations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedIds = [
  "RG-01", "RG-02", "RG-03", "RG-04", "RG-05", "RG-06", "RG-07", "RG-08",
];
const requirementPaths = expectedIds.map((id) => `requirements/repo-guard/${id}.yaml`);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assert.match(revision, /^[0-9a-f]{40}$/);

const productRequirements = readFileSync(resolve(root, "docs/product-requirements.md"), "utf8");
for (const id of expectedIds) {
  assert.match(productRequirements, new RegExp(`^### ${id}\\b`, "m"), `${id}: semantic authority heading missing`);
}

const sources = requirementPaths.map((path, index) => {
  const content = readFileSync(resolve(root, path), "utf8");
  const parsed = parseYaml(content);
  assert.deepEqual(Object.keys(parsed).sort(), ["artifacts", "id"], `${path}: relation source must stay prose-free`);
  assert.equal(parsed.id, expectedIds[index]);
  assert.ok(Array.isArray(parsed.artifacts));
  for (const artifact of parsed.artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), ["path", "relations"], `${path}: artifact entry must contain only path + relations`);
  }
  return { path, format: "yaml", content };
});

const graph = normalizeRequirementAuthority({
  snapshot: "head",
  revision,
  scope: [{ glob: "requirements/repo-guard/*.yaml", format: "yaml" }],
  sources,
});

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean).sort();

const requiresRelations = graph.relations.filter((relation) => relation.relation === "requires");
const requires = [...new Set(requiresRelations.map((relation) => relation.object))].sort();

assert.deepEqual(requires, tracked, "every exact tracked artifact must have requires provenance");
assert.equal(requiresRelations.length, tracked.length, "P0 keeps exactly one primary requires owner per tracked artifact");

const forward = new Map();
const reverse = new Map();
for (const relation of graph.relations) {
  const byRequirement = forward.get(relation.subject) || [];
  byRequirement.push(relation);
  forward.set(relation.subject, byRequirement);
  const byArtifact = reverse.get(relation.object) || [];
  byArtifact.push(relation);
  reverse.set(relation.object, byArtifact);
}

assert.deepEqual([...forward.keys()].sort(), expectedIds);
assert.equal(reverse.size, tracked.length);
for (const path of tracked) {
  const relations = reverse.get(path) || [];
  assert.equal(relations.filter((relation) => relation.relation === "requires").length, 1, `${path}: requires owner must be unique in P0`);
  for (const relation of relations) {
    assert.equal(typeof relation.provenance.source_path, "string");
    assert.equal(relation.provenance.snapshot, "head");
    assert.equal(relation.provenance.revision, revision);
  }
}
for (const path of tracked.filter((path) => path.startsWith("src/") || path.startsWith("dist/"))) {
  assert.ok((reverse.get(path) || []).some((relation) => relation.relation === "implements"), `${path}: code artifact must implement`);
}
for (const path of tracked.filter((path) => path.startsWith("tests/"))) {
  assert.ok((reverse.get(path) || []).some((relation) => relation.relation === "verifies"), `${path}: test artifact must verify`);
}

console.log(`#645 self-host relation inventory: ${tracked.length}/${tracked.length} tracked artifacts, unique requires provenance, graph=${graph.graph_sha256}, revision=${revision}`);


// #662 PRE-POLICY differential witness.
// This remains test-local: production cochange authority is unchanged until
// relation-derived transaction evidence proves equivalent or stricter behavior.
const fixtureRevision = "a".repeat(40);
function fixtureGraph(snapshot, declarations) {
  const grouped = new Map();
  for (const declaration of declarations) {
    const artifacts = grouped.get(declaration.subject) || [];
    artifacts.push(declaration);
    grouped.set(declaration.subject, artifacts);
  }
  const fixtureSources = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([subject, artifacts]) => ({
    path: `requirements/${subject}.yaml`,
    format: "yaml",
    content: [
      `id: ${subject}`,
      "artifacts:",
      ...artifacts.flatMap(({ path, relations }) => [
        `  - path: ${JSON.stringify(path)}`,
        `    relations: [${relations.join(", ")}]`,
      ]),
      "",
    ].join("\n"),
  }));
  return normalizeRequirementAuthority({
    snapshot,
    revision: fixtureRevision,
    scope: [{ glob: "requirements/*.yaml", format: "yaml" }],
    sources: fixtureSources,
  });
}

function broadCochange(changedPaths) {
  const sourceChanged = changedPaths.some((path) => path.startsWith("src/"));
  const testChanged = changedPaths.some((path) => path.startsWith("tests/"));
  return !sourceChanged || testChanged;
}

function relationOverlapEvidence({ baseGraph, headGraph, changedPaths }) {
  const changed = new Set(changedPaths);
  const implementationRequirements = new Set(
    [...baseGraph.relations, ...headGraph.relations]
      .filter((relation) => relation.relation === "implements"
        && relation.object.startsWith("src/")
        && changed.has(relation.object))
      .map((relation) => relation.subject),
  );
  if (!implementationRequirements.size) return { ok: true, overlap: [] };

  const verificationRequirements = new Set(
    headGraph.relations
      .filter((relation) => relation.relation === "verifies"
        && relation.object.startsWith("tests/")
        && changed.has(relation.object))
      .map((relation) => relation.subject),
  );
  const overlap = [...implementationRequirements].filter((subject) => verificationRequirements.has(subject)).sort();
  return { ok: overlap.length > 0, overlap };
}

const related = fixtureGraph("head", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
  { subject: "RG-A", path: "tests/a.mjs", relations: ["requires", "verifies"] },
]);
assert.equal(relationOverlapEvidence({
  baseGraph: related,
  headGraph: related,
  changedPaths: ["src/a.mts", "tests/a.mjs"],
}).ok, true, "#662 related implementation + verification must pass");

const unrelated = fixtureGraph("head", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
  { subject: "RG-B", path: "tests/b.mjs", relations: ["requires", "verifies"] },
]);
const unrelatedPaths = ["src/a.mts", "tests/b.mjs"];
assert.equal(broadCochange(unrelatedPaths), true, "#662 legacy broad cochange accepts any changed test");
assert.equal(relationOverlapEvidence({
  baseGraph: unrelated,
  headGraph: unrelated,
  changedPaths: unrelatedPaths,
}).ok, false, "#662 relation overlap must reject an unrelated changed test");

const crossCutting = fixtureGraph("head", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
  { subject: "RG-B", path: "src/b.mts", relations: ["requires", "implements"] },
  { subject: "RG-A", path: "tests/cross.mjs", relations: ["requires", "verifies"] },
  { subject: "RG-B", path: "tests/cross.mjs", relations: ["requires", "verifies"] },
]);
const crossVerdict = relationOverlapEvidence({
  baseGraph: crossCutting,
  headGraph: crossCutting,
  changedPaths: ["src/a.mts", "src/b.mts", "tests/cross.mjs"],
});
assert.equal(crossVerdict.ok, true, "#662 explicit many-to-many verification must pass");
assert.deepEqual(crossVerdict.overlap, ["RG-A", "RG-B"]);

const baseDeleted = fixtureGraph("base", [
  { subject: "RG-A", path: "src/old.mts", relations: ["requires", "implements"] },
  { subject: "RG-A", path: "tests/a.mjs", relations: ["requires", "verifies"] },
]);
const headDeleted = fixtureGraph("head", [
  { subject: "RG-A", path: "tests/a.mjs", relations: ["requires", "verifies"] },
]);
assert.equal(relationOverlapEvidence({
  baseGraph: baseDeleted,
  headGraph: headDeleted,
  changedPaths: ["src/old.mts", "tests/a.mjs"],
}).ok, true, "#662 deleted BASE-only implementation must retain requirement identity");

const generatedOnly = fixtureGraph("head", [
  { subject: "RG-A", path: "dist/a.mjs", relations: ["requires", "implements"] },
]);
assert.equal(relationOverlapEvidence({
  baseGraph: generatedOnly,
  headGraph: generatedOnly,
  changedPaths: ["dist/a.mjs"],
}).ok, true, "#662 generated dist must not duplicate src transaction evidence");

const transitionBase = fixtureGraph("base", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
]);
const transitionHead = fixtureGraph("head", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
  { subject: "RG-A", path: "tests/a.mjs", relations: ["requires", "verifies"] },
]);
assert.equal(relationOverlapEvidence({
  baseGraph: transitionBase,
  headGraph: transitionHead,
  changedPaths: ["src/a.mts", "tests/a.mjs"],
}).ok, true, "#662 candidate evidence can observe proposed relations");
const unauthorizedTransition = checkRequirementTransition({
  base: transitionBase,
  head: transitionHead,
  grant: null,
  trustedAuthorizer: null,
});
assert.equal(unauthorizedTransition.required, true);
assert.equal(unauthorizedTransition.authorized, false);
assert.equal(unauthorizedTransition.ok, false, "#662 evidence must not self-authorize its relation transition");

console.log("#662 relation-overlap transaction falsifier passed");
