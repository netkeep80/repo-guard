import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../dist/document-facts.mjs";
import { normalizeRequirementAuthority } from "../dist/requirement-relations.mjs";

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
