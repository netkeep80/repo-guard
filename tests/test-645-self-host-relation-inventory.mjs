import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRequirementAuthority } from "../dist/requirement-relations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requirementPaths = [
  "requirements/repo-guard/RG-01.yaml",
  "requirements/repo-guard/RG-02.yaml",
  "requirements/repo-guard/RG-03.yaml",
  "requirements/repo-guard/RG-04.yaml",
  "requirements/repo-guard/RG-05.yaml",
  "requirements/repo-guard/RG-06.yaml",
  "requirements/repo-guard/RG-07.yaml",
  "requirements/repo-guard/RG-08.yaml",
];

const sources = requirementPaths.map((path) => ({
  path,
  format: "yaml",
  content: readFileSync(resolve(root, path), "utf8"),
}));

const graph = normalizeRequirementAuthority({
  snapshot: "head",
  revision: "f".repeat(40),
  scope: [{ glob: "requirements/repo-guard/*.yaml", format: "yaml" }],
  sources,
});

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean).sort();

const requires = [...new Set(
  graph.relations.filter((relation) => relation.relation === "requires").map((relation) => relation.object),
)].sort();

assert.deepEqual(requires, tracked, "every exact tracked artifact must have requires provenance");

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

assert.deepEqual([...forward.keys()].sort(), [
  "RG-01", "RG-02", "RG-03", "RG-04", "RG-05", "RG-06", "RG-07", "RG-08",
]);
assert.equal(reverse.size, tracked.length);
for (const path of tracked) {
  const relations = reverse.get(path) || [];
  assert.ok(relations.some((relation) => relation.relation === "requires"), `${path}: missing requires`);
  for (const relation of relations) {
    assert.equal(typeof relation.provenance.source_path, "string");
    assert.equal(relation.provenance.snapshot, "head");
    assert.equal(relation.provenance.revision, "f".repeat(40));
  }
}
for (const path of tracked.filter((path) => path.startsWith("src/") || path.startsWith("dist/"))) {
  assert.ok((reverse.get(path) || []).some((relation) => relation.relation === "implements"), `${path}: code artifact must implement`);
}
for (const path of tracked.filter((path) => path.startsWith("tests/"))) {
  assert.ok((reverse.get(path) || []).some((relation) => relation.relation === "verifies"), `${path}: test artifact must verify`);
}

console.log(`#645 self-host relation inventory: ${tracked.length}/${tracked.length} tracked artifacts have exact reverse requirement provenance; graph=${graph.graph_sha256}`);
