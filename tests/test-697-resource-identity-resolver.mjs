import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeDocumentFact,
  parseJson,
  parseYaml,
  resolveJsonPointer,
} from "../dist/document-facts.mjs";
import { createImmutableSnapshotDocumentCache } from "../dist/immutable-snapshot-cache.mjs";
import {
  compareRequirementRelationGraphs,
  normalizeRequirementAuthority,
} from "../dist/requirement-relations.mjs";

const EXACT_SHA = /^[0-9a-f]{40}$/i;
const REQUIREMENT_RELATIONS = new Set(["derives_from", "depends_on", "constrains", "supersedes"]);
const RESOURCE_RELATIONS = new Set(["requires", "implemented_by", "verified_by", "documents", "generates"]);

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + ": must be object");
  return value;
}

function exactFields(value, allowed, label) {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new Error(label + ': unknown field "' + key + '"');
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + ": must be non-empty string");
  return value.trim();
}

function safePath(value, label = "path") {
  return normalizeDocumentFact(value, "repository_path", label);
}

function repositoryId(value, label = "repository") {
  const id = nonEmpty(value, label).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(id)) throw new Error(label + ": must be owner/repository");
  return id;
}

function exactRevision(value, label = "revision") {
  const revision = nonEmpty(value, label).toLowerCase();
  if (!EXACT_SHA.test(revision)) throw new Error(label + ": exact 40-hex revision required");
  return revision;
}

function pointer(value, label = "pointer") {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(label + ": must be string");
  // Reuse accepted pointer syntax validator without requiring a target.
  if (value !== "" && !value.startsWith("/")) throw new Error(label + ": malformed JSON Pointer");
  for (const raw of value === "" ? [] : value.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(raw)) throw new Error(label + ": malformed JSON Pointer escape");
  }
  return value;
}

function encodePointerSegment(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function strictCanonicalParse(format, content) {
  if (format === "yaml") return parseYaml(content);
  if (format === "json") {
    // JSON.parse enforces JSON grammar; YAML's unique-key parser supplies the
    // fail-closed duplicate-key property missing from raw JSON.parse.
    parseJson(content);
    return parseYaml(content);
  }
  throw new Error("unsupported canonical format " + format);
}

function canonicalFormat(path) {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  throw new Error(path + ": canonical source extension must be yaml/yml/json");
}

function snapshot({ repository = "netkeep80/repo-guard", revision = "a".repeat(40), files = {}, trackedFiles = null }) {
  const repo = repositoryId(repository);
  const sha = exactRevision(revision);
  const normalized = new Map();
  for (const [rawPath, content] of Object.entries(files)) {
    const path = safePath(rawPath, "snapshot file");
    if (normalized.has(path)) throw new Error('duplicate snapshot path "' + path + '"');
    normalized.set(path, String(content));
  }
  const tracked = (trackedFiles || [...normalized.keys()]).map((path) => safePath(path, "tracked path")).sort();
  return { repository: repo, revision: sha, files: normalized, trackedFiles: [...new Set(tracked)] };
}

function discoverCanonicalSources(snap) {
  const result = [];
  for (const path of [...snap.files.keys()].sort()) {
    safePath(path, "canonical discovery");
    if (!path.startsWith("requirements/")) continue;
    if (!/\.(?:ya?ml|json)$/.test(path)) continue;
    result.push({ path, format: canonicalFormat(path), content: snap.files.get(path) });
  }
  return result;
}

function normalizeTarget(value, label) {
  const target = object(value, label);
  if (target.kind === "requirement") {
    exactFields(target, ["kind", "id"], label);
    return { kind: "requirement", id: nonEmpty(target.id, label + ".id") };
  }
  if (target.kind === "artifact") {
    exactFields(target, ["kind", "path"], label);
    return { kind: "artifact", path: safePath(target.path, label + ".path") };
  }
  throw new Error(label + ': unsupported target kind "' + String(target.kind) + '"');
}

function parseCanonicalRequirement(source) {
  const root = object(strictCanonicalParse(source.format, source.content), source.path);
  exactFields(root, ["id", "relations"], source.path);
  const id = nonEmpty(root.id, source.path + "#/id");
  const relationsObject = root.relations === undefined ? {} : object(root.relations, source.path + "#/relations");
  const relations = [];
  for (const key of Object.keys(relationsObject).sort()) {
    const raw = object(relationsObject[key], source.path + "#/relations/" + key);
    exactFields(raw, ["predicate", "target"], source.path + "#/relations/" + key);
    const predicate = nonEmpty(raw.predicate, source.path + "#/relations/" + key + "/predicate");
    const target = normalizeTarget(raw.target, source.path + "#/relations/" + key + "/target");
    if (target.kind === "requirement" && !REQUIREMENT_RELATIONS.has(predicate)) {
      throw new Error(source.path + ": invalid Requirement relation " + predicate);
    }
    if (target.kind === "artifact" && !RESOURCE_RELATIONS.has(predicate)) {
      throw new Error(source.path + ": invalid Resource relation " + predicate);
    }
    relations.push({
      key,
      predicate,
      target,
      pointer: "/relations/" + encodePointerSegment(key),
    });
  }
  const semantic = {
    id,
    relations: relations.map(({ key, predicate, target }) => ({ key, predicate, target })),
  };
  return {
    id,
    source_path: source.path,
    source_format: source.format,
    source_sha256: sha256(source.content),
    semantic_sha256: sha256(semantic),
    semantic,
    value: root,
    relations,
  };
}

function buildSourceIndex(snap) {
  const sources = discoverCanonicalSources(snap);
  const byId = new Map();
  const byPath = new Map();
  for (const source of sources) {
    const requirement = parseCanonicalRequirement(source);
    if (byId.has(requirement.id)) {
      throw new Error('duplicate Requirement id "' + requirement.id + '" in "' + byId.get(requirement.id).source_path + '" and "' + requirement.source_path + '"');
    }
    byId.set(requirement.id, requirement);
    byPath.set(requirement.source_path, requirement.id);
  }
  for (const requirement of byId.values()) {
    for (const relation of requirement.relations) {
      if (relation.target.kind === "requirement" && !byId.has(relation.target.id)) {
        throw new Error(requirement.id + ': missing Requirement target "' + relation.target.id + '"');
      }
    }
  }
  return { snapshot: snap, sources, byId, byPath };
}

function eagerClosure(snap, trustedRoots) {
  const index = buildSourceIndex(snap);
  const roots = [...new Set(trustedRoots.map((id) => nonEmpty(id, "trusted root")))].sort();
  const reachable = new Set();
  const whyRequirement = new Map();
  for (const root of roots) {
    if (!index.byId.has(root)) throw new Error('trusted root "' + root + '" is absent from exact snapshot');
    reachable.add(root);
    whyRequirement.set(root, [root]);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const requirement of [...index.byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (reachable.has(requirement.id)) continue;
      const parents = requirement.relations
        .filter((relation) => relation.predicate === "derives_from" && relation.target.kind === "requirement")
        .map((relation) => relation.target.id)
        .sort();
      const parent = parents.find((id) => reachable.has(id));
      if (!parent) continue;
      reachable.add(requirement.id);
      whyRequirement.set(requirement.id, [...whyRequirement.get(parent), requirement.id]);
      changed = true;
    }
  }

  const orphanRequirements = [...index.byId.keys()].filter((id) => !reachable.has(id)).sort();
  const justifiedResources = new Set();
  const whyResource = new Map();

  // Canonical source representation is justified by semantic Requirement reachability.
  for (const id of [...reachable].sort()) {
    const requirement = index.byId.get(id);
    justifiedResources.add(requirement.source_path);
    whyResource.set(requirement.source_path, [...whyRequirement.get(id), "@source:" + requirement.source_path]);
    for (const relation of requirement.relations) {
      if (relation.target.kind !== "artifact") continue;
      justifiedResources.add(relation.target.path);
      const candidate = [...whyRequirement.get(id), relation.predicate + ":" + relation.target.path];
      const previous = whyResource.get(relation.target.path);
      if (!previous || stable(candidate) < stable(previous)) whyResource.set(relation.target.path, candidate);
    }
  }

  const orphanTrackedResources = snap.trackedFiles
    .filter((path) => !justifiedResources.has(path))
    .sort();

  return {
    ok: orphanRequirements.length === 0 && orphanTrackedResources.length === 0,
    index,
    trustedRoots: roots,
    reachableRequirements: [...reachable].sort(),
    justifiedResources: [...justifiedResources].sort(),
    orphanRequirements,
    orphanTrackedResources,
    explanations: {
      whyRequirement: Object.fromEntries([...whyRequirement.entries()].sort(([a], [b]) => a.localeCompare(b))),
      whyResource: Object.fromEntries([...whyResource.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function compareSemanticRequirements(base, head) {
  const b = buildSourceIndex(base), h = buildSourceIndex(head);
  const ids = [...new Set([...b.byId.keys(), ...h.byId.keys()])].sort();
  const delta = { add: [], remove: [], modify: [], source_move: [] };
  for (const id of ids) {
    const before = b.byId.get(id), after = h.byId.get(id);
    if (!before) delta.add.push(id);
    else if (!after) delta.remove.push(id);
    else {
      if (before.semantic_sha256 !== after.semantic_sha256) delta.modify.push(id);
      if (before.source_path !== after.source_path) {
        delta.source_move.push({ id, from: before.source_path, to: after.source_path });
      }
    }
  }
  return delta;
}

function validateRequirementDeltaAuthority(base, head, authorizedIds = []) {
  const delta = compareSemanticRequirements(base, head);
  const protectedIds = new Set([...delta.add, ...delta.remove, ...delta.modify]);
  const authorized = new Set(authorizedIds);
  const missing = [...protectedIds].filter((id) => !authorized.has(id)).sort();
  return { ok: missing.length === 0, missing, delta };
}

function normalizeResourceRef(value) {
  const ref = object(value, "ResourceRef");
  if (ref.kind === "requirement") {
    exactFields(ref, ["kind", "id"], "RequirementRef");
    return { kind: "requirement", id: nonEmpty(ref.id, "RequirementRef.id") };
  }
  if (ref.kind === "artifact") {
    exactFields(ref, ["kind", "path"], "ArtifactRef");
    return { kind: "artifact", path: safePath(ref.path, "ArtifactRef.path") };
  }
  if (ref.kind === "document") {
    exactFields(ref, ["kind", "path", "pointer"], "DocumentRef");
    return { kind: "document", path: safePath(ref.path, "DocumentRef.path"), pointer: pointer(ref.pointer) };
  }
  if (ref.kind === "external_document") {
    exactFields(ref, ["kind", "repository", "revision", "path", "pointer"], "ExternalDocumentRef");
    return {
      kind: "external_document",
      repository: repositoryId(ref.repository, "ExternalDocumentRef.repository"),
      revision: exactRevision(ref.revision, "ExternalDocumentRef.revision"),
      path: safePath(ref.path, "ExternalDocumentRef.path"),
      pointer: pointer(ref.pointer),
    };
  }
  throw new Error('ResourceRef: unsupported kind "' + String(ref.kind) + '"');
}

function parseDocumentAt(snap, path) {
  const content = snap.files.get(path);
  if (content === undefined) throw new Error('missing exact document "' + path + '"');
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return strictCanonicalParse("yaml", content);
  if (path.endsWith(".json")) return strictCanonicalParse("json", content);
  return content;
}

function exactCoordinateKey(repository, revision, path, ptr = "") {
  return JSON.stringify([
    repositoryId(repository),
    exactRevision(revision),
    safePath(path),
    pointer(ptr),
  ]);
}

function createResolver({ localSnapshot, externalSnapshots = [], trustedResourcePaths = [] }) {
  const localIndex = buildSourceIndex(localSnapshot);
  const external = new Map();
  for (const snap of externalSnapshots) {
    const key = JSON.stringify([snap.repository, snap.revision]);
    if (external.has(key)) throw new Error("duplicate external exact snapshot");
    external.set(key, snap);
  }
  const trusted = new Set(trustedResourcePaths.map((path) => safePath(path, "trusted resource path")));
  const cache = new Map();

  const resolve = (rawRef) => {
    const ref = normalizeResourceRef(rawRef);
    if (ref.kind === "requirement") {
      const requirement = localIndex.byId.get(ref.id);
      if (!requirement) throw new Error('missing Requirement "' + ref.id + '"');
      return structuredClone({
        kind: "requirement",
        semantic_id: ref.id,
        semantic_sha256: requirement.semantic_sha256,
        representation: {
          repository: localSnapshot.repository,
          revision: localSnapshot.revision,
          path: requirement.source_path,
          pointer: "",
        },
      });
    }

    let snap = localSnapshot;
    let path = ref.path;
    let ptr = "";
    if (ref.kind === "external_document") {
      snap = external.get(JSON.stringify([ref.repository, ref.revision]));
      if (!snap) throw new Error("external exact snapshot unavailable");
      path = ref.path;
      ptr = ref.pointer;
    } else if (ref.kind === "document") {
      ptr = ref.pointer;
    }

    if (!snap.files.has(path)) throw new Error('missing exact resource "' + path + '"');
    const key = exactCoordinateKey(snap.repository, snap.revision, path, ptr);
    if (cache.has(key)) return structuredClone(cache.get(key));

    let selected = parseDocumentAt(snap, path);
    if (ptr !== "") selected = resolveJsonPointer(selected, ptr);
    const value = structuredClone(selected);
    const result = {
      kind: ref.kind,
      exact: {
        repository: snap.repository,
        revision: snap.revision,
        path,
        pointer: ptr,
      },
      trusted: trusted.has(path),
      value,
    };
    cache.set(key, result);
    return structuredClone(result);
  };

  return { resolve, localIndex, cache };
}

function pointerStability(ptr) {
  const normalized = pointer(ptr);
  if (normalized === "") return "stable-root";
  const segments = normalized.slice(1).split("/").map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.some((segment) => /^(?:0|[1-9]\d*)$/.test(segment))
    ? "positional-unsafe"
    : "stable-keyed";
}

function semanticSubject(index, id) {
  const requirement = index.byId.get(id);
  if (!requirement) throw new Error("missing semantic subject " + id);
  return {
    binding: "semantic_requirement",
    repository: index.snapshot.repository,
    requirement_id: id,
    semantic_sha256: requirement.semantic_sha256,
  };
}

function representationSubject(snap, path, ptr = "") {
  const selected = ptr === "" ? parseDocumentAt(snap, safePath(path)) : resolveJsonPointer(parseDocumentAt(snap, safePath(path)), pointer(ptr));
  return {
    binding: "exact_fragment",
    repository: snap.repository,
    revision: snap.revision,
    path: safePath(path),
    pointer: pointer(ptr),
    value_sha256: sha256(selected),
  };
}

function receiptMatches(receipt, subject) {
  return stable(receipt) === stable(subject);
}

function reverseImpactRequirements(index, artifactPath) {
  const path = safePath(artifactPath);
  const direct = new Set();
  for (const requirement of index.byId.values()) {
    if (requirement.relations.some((relation) => relation.target.kind === "artifact" && relation.target.path === path)) {
      direct.add(requirement.id);
    }
  }
  const impacted = new Set(direct);
  let changed = true;
  while (changed) {
    changed = false;
    for (const requirement of index.byId.values()) {
      for (const relation of requirement.relations) {
        if (relation.target.kind !== "requirement") continue;
        if (!["derives_from", "depends_on", "constrains"].includes(relation.predicate)) continue;
        if (impacted.has(requirement.id) && !impacted.has(relation.target.id)) {
          impacted.add(relation.target.id); changed = true;
        }
        if (impacted.has(relation.target.id) && relation.predicate === "derives_from" && !impacted.has(requirement.id)) {
          impacted.add(requirement.id); changed = true;
        }
      }
    }
  }
  return [...impacted].sort().map((id) => ({ kind: "impact_candidate", requirement_id: id }));
}

function requirementYaml(id, relations = {}) {
  const relationLines = Object.entries(relations).flatMap(([key, relation]) => {
    const target = relation.target.kind === "requirement"
      ? ["      kind: requirement", "      id: " + relation.target.id]
      : ["      kind: artifact", "      path: " + JSON.stringify(relation.target.path)];
    return [
      "  " + key + ":",
      "    predicate: " + relation.predicate,
      "    target:",
      ...target,
    ];
  });
  return [
    "id: " + id,
    ...(relationLines.length ? ["relations:", ...relationLines] : []),
    "",
  ].join("\n");
}

test("#697 witness: accepted RequirementAuthorityGraph is artifact-only", () => {
  const graph = normalizeRequirementAuthority({
    snapshot: "head",
    revision: "b".repeat(40),
    sources: [{
      path: "requirements/r1.yaml",
      format: "yaml",
      content: requirementYaml("R1", {
        provenance: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } },
      }),
    }],
  });
  assert.equal(graph.relations.some((relation) => relation.relation === "derives_from"), false);
});

test("#697 F01/F21 source rename preserves semantic Requirement identity and is not delete+add", () => {
  const content = requirementYaml("R1", {
    impl: { predicate: "implemented_by", target: { kind: "artifact", path: "src/a.mts" } },
  });
  const base = snapshot({ revision: "a".repeat(40), files: {
    "requirements/R1.yaml": content,
    "src/a.mts": "same",
  }});
  const head = snapshot({ revision: "b".repeat(40), files: {
    "requirements/security/R1.yaml": content,
    "src/a.mts": "same",
  }});
  const b = buildSourceIndex(base).byId.get("R1");
  const h = buildSourceIndex(head).byId.get("R1");
  assert.equal(b.id, h.id);
  assert.equal(b.semantic_sha256, h.semantic_sha256);
  assert.notEqual(b.source_path, h.source_path);
  const delta = compareSemanticRequirements(base, head);
  assert.deepEqual(delta.add, []);
  assert.deepEqual(delta.remove, []);
  assert.deepEqual(delta.modify, []);
  assert.deepEqual(delta.source_move, [{ id: "R1", from: "requirements/R1.yaml", to: "requirements/security/R1.yaml" }]);

  // Accepted relation identity already exhibits the same useful distinction.
  const oldGraph = normalizeRequirementAuthority({
    snapshot: "base", revision: base.revision,
    sources: [{ path: "requirements/R1.yaml", format: "yaml", content: "id: R1\\nartifacts:\\n  - path: src/a.mts\\n    relations: [requires, implements]\\n" }],
  });
  const newGraph = normalizeRequirementAuthority({
    snapshot: "head", revision: head.revision,
    sources: [{ path: "requirements/security/R1.yaml", format: "yaml", content: "id: R1\\nartifacts:\\n  - path: src/a.mts\\n    relations: [requires, implements]\\n" }],
  });
  assert.deepEqual(compareRequirementRelationGraphs(oldGraph, newGraph), { add: [], remove: [] });
  assert.equal(oldGraph.graph_sha256, newGraph.graph_sha256);
  assert.notEqual(oldGraph.authority_sha256, newGraph.authority_sha256);
});

test("#697 F02 duplicate semantic Requirement ID fails closed", () => {
  const snap = snapshot({ files: {
    "requirements/a.yaml": requirementYaml("R1"),
    "requirements/b.yaml": requirementYaml("R1"),
  }});
  assert.throws(() => buildSourceIndex(snap), /duplicate Requirement id "R1"/);
});

test("#697 F03 missing Requirement target fails closed", () => {
  const snap = snapshot({ files: {
    "requirements/r1.yaml": requirementYaml("R1", {
      missing: { predicate: "derives_from", target: { kind: "requirement", id: "NOPE" } },
    }),
  }});
  assert.throws(() => buildSourceIndex(snap), /missing Requirement target "NOPE"/);
});

test("#697 F04 resolver is read-only and cannot create missing nodes", () => {
  const snap = snapshot({ files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "docs/spec.json": '{"a":{"b":1}}',
  }});
  const resolver = createResolver({ localSnapshot: snap });
  const before = snap.files.get("docs/spec.json");
  assert.throws(() => resolver.resolve({ kind: "document", path: "docs/spec.json", pointer: "/a/missing" }), /does not exist/);
  assert.equal(snap.files.get("docs/spec.json"), before);
  const result = resolver.resolve({ kind: "document", path: "docs/spec.json", pointer: "/a" });
  result.value.b = 99;
  const reread = resolver.resolve({ kind: "document", path: "docs/spec.json", pointer: "/a" });
  assert.equal(reread.value.b, 1);
});

test("#697 F05 missing fragment is RED", () => {
  const snap = snapshot({ files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "docs/spec.json": '{"a":1}',
  }});
  const resolver = createResolver({ localSnapshot: snap });
  assert.throws(() => resolver.resolve({ kind: "document", path: "docs/spec.json", pointer: "/missing" }), /does not exist/);
});

test("#697 F06 malformed JSON Pointer is RED", () => {
  const snap = snapshot({ files: { "requirements/root.yaml": requirementYaml("ROOT"), "docs/spec.json": '{"a":1}' }});
  const resolver = createResolver({ localSnapshot: snap });
  assert.throws(() => resolver.resolve({ kind: "document", path: "docs/spec.json", pointer: "/a~2b" }), /malformed JSON Pointer/);
});

test("#697 F07 exact external acceptance/document ref requires exact revision", () => {
  assert.throws(() => normalizeResourceRef({
    kind: "external_document",
    repository: "netkeep80/anum_docs",
    path: "requirements/r.yaml",
    pointer: "",
  }), /revision/);
  assert.throws(() => normalizeResourceRef({
    kind: "external_document",
    repository: "netkeep80/anum_docs",
    revision: "main",
    path: "requirements/r.yaml",
    pointer: "",
  }), /exact 40-hex/);
});

test("#697 F08 wrong external repository/revision/path/pointer is RED", () => {
  const local = snapshot({ files: { "requirements/root.yaml": requirementYaml("ROOT") }});
  const ext = snapshot({
    repository: "netkeep80/anum_docs",
    revision: "1".repeat(40),
    files: { "requirements/r.yaml": "id: X\\n" },
  });
  const resolver = createResolver({ localSnapshot: local, externalSnapshots: [ext] });
  assert.throws(() => resolver.resolve({ kind: "external_document", repository: "netkeep80/other", revision: ext.revision, path: "requirements/r.yaml", pointer: "" }), /snapshot unavailable/);
  assert.throws(() => resolver.resolve({ kind: "external_document", repository: ext.repository, revision: "2".repeat(40), path: "requirements/r.yaml", pointer: "" }), /snapshot unavailable/);
  assert.throws(() => resolver.resolve({ kind: "external_document", repository: ext.repository, revision: ext.revision, path: "requirements/missing.yaml", pointer: "" }), /missing exact resource/);
  assert.throws(() => resolver.resolve({ kind: "external_document", repository: ext.repository, revision: ext.revision, path: "requirements/r.yaml", pointer: "/missing" }), /does not exist/);
});

test("#697 F09 unrooted SCC is RED", () => {
  const snap = snapshot({ files: {
    "requirements/r1.yaml": requirementYaml("R1", { d: { predicate: "derives_from", target: { kind: "requirement", id: "R2" } } }),
    "requirements/r2.yaml": requirementYaml("R2", { d: { predicate: "derives_from", target: { kind: "requirement", id: "R1" } } }),
  }});
  const result = eagerClosure(snap, []);
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphanRequirements, ["R1", "R2"]);
});

test("#697 F10 rooted SCC is valid when relation targets are valid", () => {
  const snap = snapshot({ files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "requirements/r1.yaml": requirementYaml("R1", {
      root: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } },
      cycle: { predicate: "derives_from", target: { kind: "requirement", id: "R2" } },
    }),
    "requirements/r2.yaml": requirementYaml("R2", {
      cycle: { predicate: "derives_from", target: { kind: "requirement", id: "R1" } },
    }),
  }});
  const result = eagerClosure(snap, ["ROOT"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.reachableRequirements, ["R1", "R2", "ROOT"]);
});

test("#697 F11 orphan canonical Requirement source is RED even when it links an artifact", () => {
  const snap = snapshot({ files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "requirements/orphan.yaml": requirementYaml("ORPHAN", {
      artifact: { predicate: "requires", target: { kind: "artifact", path: "src/orphan.mts" } },
    }),
    "src/orphan.mts": "x",
  }});
  const result = eagerClosure(snap, ["ROOT"]);
  assert.equal(result.ok, false);
  assert.ok(result.orphanRequirements.includes("ORPHAN"));
});

test("#697 F12 reachable Requirement source needs no tautological self-requires", () => {
  const snap = snapshot({ files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "requirements/r1.yaml": requirementYaml("R1", {
      provenance: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } },
    }),
  }});
  const result = eagerClosure(snap, ["ROOT"]);
  assert.equal(result.ok, true);
  assert.ok(result.justifiedResources.includes("requirements/r1.yaml"));
  assert.equal(buildSourceIndex(snap).byId.get("R1").relations.some((r) => r.target.kind === "artifact" && r.target.path === "requirements/r1.yaml"), false);
});

test("#697 F13 unowned tracked infrastructure/resource is RED", () => {
  const snap = snapshot({ files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    ".github/workflows/ci.yml": "name: CI",
  }});
  const result = eagerClosure(snap, ["ROOT"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphanTrackedResources, [".github/workflows/ci.yml"]);
});

test("#697 F14 HEAD-only rooted new Requirement cannot authorize its own normative introduction", () => {
  const base = snapshot({ revision: "a".repeat(40), files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
  }});
  const head = snapshot({ revision: "b".repeat(40), files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "requirements/new.yaml": requirementYaml("RNEW", {
      provenance: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } },
    }),
  }});
  assert.equal(eagerClosure(head, ["ROOT"]).ok, true, "HEAD future state itself is rooted");
  const unauthorized = validateRequirementDeltaAuthority(base, head, []);
  assert.equal(unauthorized.ok, false);
  assert.deepEqual(unauthorized.missing, ["RNEW"]);
  assert.equal(validateRequirementDeltaAuthority(base, head, ["RNEW"]).ok, true);
});

test("#697 F15 keyed fragment remains stable across unrelated sibling insertion", () => {
  const before = {
    relations: {
      "implementation-core": { predicate: "implemented_by", target: "src/a.mts" },
      "verifier-core": { predicate: "verified_by", target: "tests/a.mjs" },
    },
  };
  const after = {
    relations: {
      "documentation-core": { predicate: "documents", target: "README.md" },
      "implementation-core": { predicate: "implemented_by", target: "src/a.mts" },
      "verifier-core": { predicate: "verified_by", target: "tests/a.mjs" },
    },
  };
  assert.equal(pointerStability("/relations/verifier-core"), "stable-keyed");
  assert.deepEqual(resolveJsonPointer(before, "/relations/verifier-core"), resolveJsonPointer(after, "/relations/verifier-core"));
  assert.equal(sha256(resolveJsonPointer(before, "/relations/verifier-core")), sha256(resolveJsonPointer(after, "/relations/verifier-core")));
});

test("#697 F16 positional pointer semantic drift is classified unsafe for durable identity", () => {
  const before = { relations: [
    { predicate: "implemented_by", target: "src/a.mts" },
    { predicate: "verified_by", target: "tests/a.mjs" },
  ]};
  const after = { relations: [
    { predicate: "documents", target: "README.md" },
    { predicate: "implemented_by", target: "src/a.mts" },
    { predicate: "verified_by", target: "tests/a.mjs" },
  ]};
  assert.equal(pointerStability("/relations/1"), "positional-unsafe");
  assert.notDeepEqual(resolveJsonPointer(before, "/relations/1"), resolveJsonPointer(after, "/relations/1"));
});

test("#697 F17 historical exact external ref survives main advance", () => {
  const local = snapshot({ files: { "requirements/root.yaml": requirementYaml("ROOT") }});
  const old = snapshot({
    repository: "netkeep80/anum_docs",
    revision: "1".repeat(40),
    files: { "docs/value.json": '{"value":"old"}' },
  });
  const current = snapshot({
    repository: "netkeep80/anum_docs",
    revision: "2".repeat(40),
    files: { "docs/value.json": '{"value":"new"}' },
  });
  const resolver = createResolver({ localSnapshot: local, externalSnapshots: [old, current] });
  const ref = { kind: "external_document", repository: old.repository, revision: old.revision, path: "docs/value.json", pointer: "/value" };
  assert.equal(resolver.resolve(ref).value, "old");
  // "main" can move to current.revision; exact ref is unaffected because no branch name participates.
  assert.equal(resolver.resolve(ref).exact.revision, old.revision);
});

test("#697 F18 eager closure is deterministic under source discovery/insertion order permutations", () => {
  const filesA = {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "requirements/b.yaml": requirementYaml("B", { p: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } } }),
    "requirements/a.yaml": requirementYaml("A", { p: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } } }),
  };
  const filesB = {
    "requirements/a.yaml": filesA["requirements/a.yaml"],
    "requirements/root.yaml": filesA["requirements/root.yaml"],
    "requirements/b.yaml": filesA["requirements/b.yaml"],
  };
  const a = eagerClosure(snapshot({ files: filesA }), ["ROOT"]);
  const b = eagerClosure(snapshot({ files: filesB }), ["ROOT"]);
  assert.equal(stable({
    reachable: a.reachableRequirements,
    resources: a.justifiedResources,
    explanations: a.explanations,
  }), stable({
    reachable: b.reachableRequirements,
    resources: b.justifiedResources,
    explanations: b.explanations,
  }));
});

test("#697 F19 exact resolver/cache coordinate keys cannot collide across repo/revision/path/pointer", () => {
  const values = [
    exactCoordinateKey("o/r1", "1".repeat(40), "a/b.json", "/x"),
    exactCoordinateKey("o/r2", "1".repeat(40), "a/b.json", "/x"),
    exactCoordinateKey("o/r1", "2".repeat(40), "a/b.json", "/x"),
    exactCoordinateKey("o/r1", "1".repeat(40), "a/c.json", "/x"),
    exactCoordinateKey("o/r1", "1".repeat(40), "a/b.json", "/y"),
  ];
  assert.equal(new Set(values).size, values.length);

  let reads = 0;
  const cache = createImmutableSnapshotDocumentCache({
    readFileAtRef: (sha, path) => { reads++; return sha + ":" + path; },
    parsers: { json: parseJson, yaml: parseYaml },
  });
  cache.read({ repository: "o/r1", sha: "1".repeat(40) }, "a/b.json");
  cache.read({ repository: "o/r2", sha: "1".repeat(40) }, "a/b.json");
  assert.equal(reads, 2, "accepted immutable cache already includes repository in its key");
});

test("#697 F20 canonical loader cannot escape source scope through traversal/backslash/URI/absolute aliases", () => {
  for (const bad of [
    "requirements/../evil.yaml",
    "requirements\\\\evil.yaml",
    "file:requirements/evil.yaml",
    "/requirements/evil.yaml",
    "C:/requirements/evil.yaml",
  ]) {
    assert.throws(() => snapshot({ files: { [bad]: "id: EVIL\\n" } }), /invalid repository_path/);
  }
});

test("#697 F22 localDiffBase can resolve candidate parent without promoting it to trusted authority baseline", () => {
  const authorityBase = snapshot({ revision: "1".repeat(40), files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
  }});
  const localParent = snapshot({ revision: "2".repeat(40), files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "requirements/parent.yaml": requirementYaml("PARENT", {
      provenance: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } },
    }),
  }});
  const child = snapshot({ revision: "3".repeat(40), files: {
    ...Object.fromEntries(localParent.files),
    "src/child.mts": "x",
  }, trackedFiles: [...localParent.trackedFiles, "src/child.mts"] });

  const localResolver = createResolver({ localSnapshot: localParent });
  assert.equal(localResolver.resolve({ kind: "requirement", id: "PARENT" }).semantic_id, "PARENT");

  const authority = validateRequirementDeltaAuthority(authorityBase, child, []);
  assert.equal(authority.ok, false);
  assert.ok(authority.missing.includes("PARENT"));
  const afterPromotion = validateRequirementDeltaAuthority(localParent, child, []);
  assert.equal(afterPromotion.ok, true, "once local parent is independently trusted as authority baseline, no RequirementDelta remains");
});

test("#697 F23 reverse impact can traverse transitive refs but resolver never marks impact as causal/authority", () => {
  const snap = snapshot({ files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    "requirements/r1.yaml": requirementYaml("R1", {
      p: { predicate: "derives_from", target: { kind: "requirement", id: "ROOT" } },
      impl: { predicate: "implemented_by", target: { kind: "artifact", path: "src/a.mts" } },
    }),
    "src/a.mts": "x",
  }});
  const impacts = reverseImpactRequirements(buildSourceIndex(snap), "src/a.mts");
  assert.deepEqual(impacts.map((item) => item.requirement_id), ["R1", "ROOT"]);
  assert.ok(impacts.every((item) => item.kind === "impact_candidate"));
  assert.ok(impacts.every((item) => !Object.hasOwn(item, "causal") && !Object.hasOwn(item, "authorized")));
});

test("#697 F24 candidate ResourceRef kind/fields cannot reclassify independent trusted provider/root", () => {
  const snap = snapshot({ files: {
    "requirements/root.yaml": requirementYaml("ROOT"),
    ".github/workflows/trusted.yml": "name: trusted",
  }});
  const resolver = createResolver({
    localSnapshot: snap,
    trustedResourcePaths: [".github/workflows/trusted.yml"],
  });
  assert.equal(resolver.resolve({ kind: "artifact", path: ".github/workflows/trusted.yml" }).trusted, true);
  assert.equal(resolver.resolve({ kind: "document", path: ".github/workflows/trusted.yml", pointer: "" }).trusted, true);
  assert.throws(() => resolver.resolve({
    kind: "artifact",
    path: ".github/workflows/trusted.yml",
    trusted: false,
  }), /unknown field "trusted"/);
});

test("#697 F25 receipt binding mode is explicit; semantic receipt may survive source move, exact representation receipt may not", () => {
  const content = requirementYaml("R1");
  const base = snapshot({ revision: "1".repeat(40), files: { "requirements/r1.yaml": content }});
  const moved = snapshot({ revision: "2".repeat(40), files: { "requirements/security/r1.yaml": content }});
  const baseIndex = buildSourceIndex(base), movedIndex = buildSourceIndex(moved);

  const semanticReceipt = semanticSubject(baseIndex, "R1");
  assert.equal(receiptMatches(semanticReceipt, semanticSubject(movedIndex, "R1")), true);

  const exactReceipt = representationSubject(base, "requirements/r1.yaml", "/id");
  const movedExact = representationSubject(moved, "requirements/security/r1.yaml", "/id");
  assert.equal(receiptMatches(exactReceipt, movedExact), false);
  assert.equal(exactReceipt.binding, "exact_fragment");
  assert.equal(semanticReceipt.binding, "semantic_requirement");
});

test("#697 F26 source representation identity and semantic Requirement identity are independently explainable", () => {
  const snap = snapshot({ repository: "netkeep80/repo-guard", revision: "9".repeat(40), files: {
    "requirements/r1.yaml": requirementYaml("R1"),
  }});
  const index = buildSourceIndex(snap);
  const requirement = index.byId.get("R1");
  const explanation = {
    semantic: {
      requirement_id: requirement.id,
      semantic_sha256: requirement.semantic_sha256,
    },
    representation: {
      repository: snap.repository,
      revision: snap.revision,
      path: requirement.source_path,
      source_sha256: requirement.source_sha256,
    },
  };
  assert.equal(explanation.semantic.requirement_id, "R1");
  assert.equal(explanation.representation.path, "requirements/r1.yaml");
  assert.notEqual(explanation.semantic.semantic_sha256, explanation.representation.source_sha256);
});

test("#697 parser safety: YAML duplicate keys/aliases/tags/merge are fail-closed", () => {
  assert.throws(() => parseYaml("id: A\\nid: B\\n"), /invalid YAML/);
  assert.throws(() => parseYaml("a: &x {b: 1}\\nc: *x\\n"), /aliases are not allowed/);
  assert.throws(() => parseYaml("a: !foo bar\\n"), /explicit tag/);
  assert.throws(() => parseYaml("base: &b {x: 1}\\nobj:\\n  <<: *b\\n"), /invalid YAML|aliases are not allowed|merge keys are not allowed/);
});

test("#697 parser boundary witness: raw accepted JSON parser is last-key-wins, strict canonical parser rejects duplicates", () => {
  const duplicate = '{"id":"R1","id":"R2"}';
  assert.equal(parseJson(duplicate).id, "R2", "accepted raw JSON parser currently accepts duplicate object keys");
  assert.throws(() => strictCanonicalParse("json", duplicate), /invalid YAML|Map keys must be unique|unique/);
});
