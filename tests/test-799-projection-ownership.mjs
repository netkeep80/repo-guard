import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeProjection,
  evaluateProjectionCheck,
  normalizeProjectionModel,
  projectionModelIdentity,
} from "../dist/projection-api.mjs";
import { analyzeProjectionCurrent } from "../dist/projection-analysis.mjs";
import { analyzeProjectionOwnership } from "../dist/projection-ownership.mjs";
import { readFileBytesAtRef } from "../dist/git.mjs";
import {
  loadCanonicalRequirements,
  loadNativeRequirements,
} from "../dist/runtime/canonical-requirements.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  throw new Error("non-json fixture");
}

function projection(id, target) {
  return {
    schema: "repo-guard/projection-model/v0",
    id,
    sources: [
      {
        id: "source",
        kind: "repository_content",
        path: "inputs/source.txt",
        algorithm: "sha256",
      },
    ],
    target,
    generator: { contract_id: "fixture-generator/v1" },
    required_evidence: [],
  };
}

function owned(id, path, anchor, block, begin, end) {
  return projection(id, {
    path,
    ownership: "hybrid",
    locator: {
      kind: "markdown_owned_block",
      anchor_id: anchor,
      block_id: block,
      begin_marker: begin,
      end_marker: end,
    },
  });
}

function generated(id, path) {
  return projection(id, { path, ownership: "generated" });
}

function filesReader(files) {
  return (path) => files.has(path) ? files.get(path) : null;
}

test("#799 repository_subject pointer is an exact projection input identity", () => {
  const sourceV1 = JSON.stringify({
    byId: { core: { b: 2, a: 1 } },
    other: "v1",
  });
  const sourceOtherChanged = JSON.stringify({
    byId: { core: { a: 1, b: 2 } },
    other: "v2",
  });
  const sourceCoreChanged = JSON.stringify({
    byId: { core: { a: 1, b: 3 } },
    other: "v1",
  });
  const output = "# generated\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.subject.demo",
    sources: [
      {
        id: "core-record",
        kind: "repository_subject",
        subject: {
          kind: "resource",
          path: "model/data.json",
          pointer: "/byId/core",
        },
        algorithm: "sha256",
      },
    ],
    target: {
      path: "derived/output.md",
      ownership: "generated",
    },
    generator: { contract_id: "subject-generator/v1" },
    required_evidence: [],
  });
  const build = {
    schema: "repo-guard/projection-build-record/v0",
    projection_id: model.id,
    model_identity: projectionModelIdentity(model),
    source_identities: [
      {
        source_id: "core-record",
        algorithm: "sha256",
        digest: sha256(canonical({ a: 1, b: 2 })),
      },
    ],
    generator: {
      contract_id: "subject-generator/v1",
      tool_identity: "fixture@accepted",
    },
    configuration_digest: sha256("config:v1"),
    output_identity: {
      algorithm: "sha256",
      digest: sha256(output),
    },
    evidence: [],
  };

  const context = (source, changed = []) => ({
    readFile: (path) => {
      if (path === "model/data.json") return source;
      if (path === "derived/output.md") return output;
      throw new Error("missing " + path);
    },
    diff: { files: { checked: changed } },
  });

  assert.deepEqual(
    analyzeProjection(model, build, context(sourceV1)),
    {
      projection_id: model.id,
      freshness: "CURRENT",
      impact: "UNAFFECTED",
      failed_relations: [],
      affected_sources: [],
    },
  );

  assert.deepEqual(
    analyzeProjection(
      model,
      build,
      context(sourceOtherChanged, [{
        path: "model/data.json",
        status: "modified",
        addedLines: ["other"],
        deletedLines: ["other"],
      }]),
    ),
    {
      projection_id: model.id,
      freshness: "CURRENT",
      impact: "AFFECTED",
      failed_relations: [],
      affected_sources: ["core-record"],
    },
    "freshness is fragment-exact while current impact remains honestly file-conservative",
  );

  const stale = analyzeProjection(
    model,
    build,
    context(sourceCoreChanged, [{
      path: "model/data.json",
      status: "modified",
      addedLines: ["core"],
      deletedLines: ["core"],
    }]),
  );
  assert.equal(stale.freshness, "STALE");
  assert.deepEqual(stale.failed_relations, ["projection.subject.demo:source:core-record"]);

  const missing = analyzeProjection(
    model,
    build,
    context(JSON.stringify({ byId: {}, other: "v1" })),
  );
  assert.equal(missing.freshness, "BROKEN");
  assert.deepEqual(missing.failed_relations, ["projection.subject.demo:source:core-record"]);

  const unsupported = {
    ...model,
    sources: [{
      id: "bad-fragment",
      kind: "repository_subject",
      subject: { kind: "resource", path: "model/data.txt", pointer: "/core" },
      algorithm: "sha256",
    }],
  };
  assert.equal(
    analyzeProjection(unsupported, {
      ...build,
      projection_id: unsupported.id,
      model_identity: projectionModelIdentity(unsupported),
      source_identities: [{ source_id: "bad-fragment", algorithm: "sha256", digest: "0".repeat(64) }],
    }, context("ignored")).freshness,
    "BROKEN",
  );
});

test("#799 generated live/missing/base-orphan/retained inventories are distinct", () => {
  const live = generated("live.generated", "docs/live.md");
  const present = new Map([["docs/live.md", "generated\n"]]);
  const current = analyzeProjectionOwnership({
    live: [live],
    readHead: filesReader(present),
  });
  assert.equal(current.ok, true);
  assert.equal(current.live_expected.length, 1);
  assert.deepEqual(current.observed, current.live_expected);
  assert.deepEqual(current.missing, []);
  assert.deepEqual(current.orphan, []);

  const missing = analyzeProjectionOwnership({
    live: [live],
    readHead: () => null,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, missing.live_expected);
  assert.deepEqual(missing.orphan, []);

  const baseOnly = analyzeProjectionOwnership({
    live: [],
    base: [live],
    readHead: filesReader(present),
  });
  assert.equal(baseOnly.ok, false);
  assert.deepEqual(baseOnly.missing, []);
  assert.deepEqual(baseOnly.orphan, baseOnly.observed);

  const deletedBase = analyzeProjectionOwnership({
    live: [],
    base: [live],
    readHead: () => null,
  });
  assert.equal(deletedBase.ok, true, "already absent BASE-owned output is not an orphan");
  assert.deepEqual(deletedBase.orphan, []);
  assert.deepEqual(deletedBase.missing, []);

  const retained = analyzeProjectionOwnership({
    live: [],
    retained: [live],
    base: [live],
    readHead: filesReader(present),
  });
  assert.equal(retained.ok, true);
  assert.deepEqual(retained.orphan, []);
  assert.deepEqual(retained.missing, []);
});

test("#799 exact live/retained and duplicate live writers fail closed", () => {
  const target = generated("live.a", "docs/shared.md");
  const retainedSameTarget = generated("retained.a", "docs/shared.md");
  const duplicateWriter = generated("live.b", "docs/shared.md");
  const files = new Map([["docs/shared.md", "generated\n"]]);

  const liveRetained = analyzeProjectionOwnership({
    live: [target],
    retained: [retainedSameTarget],
    readHead: filesReader(files),
  });
  assert.equal(liveRetained.ok, false);
  assert.ok(liveRetained.conflicts.some((item) => item.code === "live_retained_overlap"));

  const duplicate = analyzeProjectionOwnership({
    live: [target, duplicateWriter],
    readHead: filesReader(files),
  });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.conflicts.some((item) => item.code === "multiple_writers"));
});

test("#799 whole-file and region writers on one path conflict before mutation", () => {
  const begin = "<!-- rg:a:begin -->";
  const end = "<!-- rg:a:end -->";
  const markdown = [
    '<a id="root-node"></a>',
    "# Root",
    begin,
    "generated",
    end,
    "",
  ].join("\n");
  const whole = generated("whole", "README.md");
  const region = owned("region", "README.md", "root-node", "a", begin, end);
  const report = analyzeProjectionOwnership({
    live: [whole, region],
    readHead: filesReader(new Map([["README.md", markdown]])),
  });
  assert.equal(report.ok, false);
  assert.ok(report.conflicts.some((item) => item.code === "managed_overlap"));
});

test("#799 owned block must be contained by its declared anchor node", () => {
  const begin = "<!-- rg:sibling:begin -->";
  const end = "<!-- rg:sibling:end -->";
  const markdown = [
    '<a id="node-a"></a>',
    "# A",
    "Authored A.",
    "",
    '<a id="node-b"></a>',
    "# B",
    begin,
    "generated in B",
    end,
    "",
  ].join("\n");
  const claimA = owned("claim-a", "docs/hybrid.md", "node-a", "sibling", begin, end);
  const report = analyzeProjectionOwnership({
    live: [claimA],
    readHead: filesReader(new Map([["docs/hybrid.md", markdown]])),
  });
  assert.equal(report.ok, false);
  assert.ok(report.conflicts.some((item) => item.code === "containment"));
});

test("#799 independently declared owned regions may not overlap", () => {
  const beginA = "<!-- rg:a:begin -->";
  const endA = "<!-- rg:a:end -->";
  const beginB = "<!-- rg:b:begin -->";
  const endB = "<!-- rg:b:end -->";
  const markdown = [
    '<a id="root"></a>',
    "# Root",
    beginA,
    "A-start",
    beginB,
    "B",
    endA,
    "B-end",
    endB,
    "",
  ].join("\n");

  const a = owned("a", "docs/overlap.md", "root", "a", beginA, endA);
  const b = owned("b", "docs/overlap.md", "root", "b", beginB, endB);
  const report = analyzeProjectionOwnership({
    live: [a, b],
    readHead: filesReader(new Map([["docs/overlap.md", markdown]])),
  });
  assert.equal(report.ok, false);
  assert.ok(report.conflicts.some((item) =>
    item.code === "managed_overlap" && /intervals/.test(item.detail || "")));
});

test("#799 malformed targets and address-only anchors fail closed", () => {
  const begin = "<!-- rg:x:begin -->";
  const end = "<!-- rg:x:end -->";
  const duplicateAnchors = [
    '<a id="node"></a>',
    "# One",
    begin,
    "generated",
    end,
    '<a id="node"></a>',
    "# Two",
    "",
  ].join("\n");

  const block = owned("block", "docs/bad.md", "node", "x", begin, end);
  const malformed = analyzeProjectionOwnership({
    live: [block],
    readHead: filesReader(new Map([["docs/bad.md", duplicateAnchors]])),
  });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.conflicts.some((item) => item.code === "malformed_target"));

  const anchorOnly = projection("anchor-only", {
    path: "docs/anchor.md",
    ownership: "hybrid",
    locator: { kind: "markdown_anchor", anchor_id: "node" },
  });
  const anchorDoc = ['<a id="node"></a>', "# Node", "Authored.", ""].join("\n");
  const insufficient = analyzeProjectionOwnership({
    live: [anchorOnly],
    readHead: filesReader(new Map([["docs/anchor.md", anchorDoc]])),
  });
  assert.equal(insufficient.ok, false);
  assert.ok(insufficient.conflicts.some((item) => item.code === "insufficient_locator"));
});

test("#799 BASE markers preserve orphan evidence when HEAD declaration changes", () => {
  const oldBegin = "<!-- rg:old:begin -->";
  const oldEnd = "<!-- rg:old:end -->";
  const newBegin = "<!-- rg:new:begin -->";
  const newEnd = "<!-- rg:new:end -->";
  const markdown = [
    '<a id="root"></a>',
    "# Root",
    oldBegin,
    "old generated",
    oldEnd,
    "",
  ].join("\n");

  const previous = owned("previous", "docs/evolve.md", "root", "old", oldBegin, oldEnd);
  const next = owned("next", "docs/evolve.md", "root", "new", newBegin, newEnd);
  const report = analyzeProjectionOwnership({
    live: [next],
    base: [previous],
    readHead: filesReader(new Map([["docs/evolve.md", markdown]])),
  });
  assert.equal(report.ok, false);
  assert.equal(report.missing.length, 1);
  assert.equal(report.orphan.length, 1);
});

test("#799 ownership analysis is deterministic and read-only", () => {
  const beginA = "<!-- rg:a:begin -->";
  const endA = "<!-- rg:a:end -->";
  const beginB = "<!-- rg:b:begin -->";
  const endB = "<!-- rg:b:end -->";
  const markdown = [
    '<a id="root"></a>',
    "# Root",
    beginA,
    "A",
    endA,
    beginB,
    "B",
    endB,
    "",
  ].join("\n");
  const a = owned("a", "docs/stable.md", "root", "a", beginA, endA);
  const b = owned("b", "docs/stable.md", "root", "b", beginB, endB);
  const files = new Map([["docs/stable.md", markdown]]);
  const before = files.get("docs/stable.md");
  const first = analyzeProjectionOwnership({
    live: [b, a],
    readHead: filesReader(files),
  });
  const second = analyzeProjectionOwnership({
    live: [a, b],
    readHead: filesReader(files),
  });
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(files.get("docs/stable.md"), before, "read-only analysis must not mutate target bytes");
  assert.equal(first.ownership_closed, false, "incomplete enumeration must never claim global ownership closure");
  assert.deepEqual(first.coverage, {
    status: "incomplete",
    expected_from: "live-and-retained-declarations",
    observed_from: "live-retained-and-base-declarations",
    candidate_marker_detection: "caller-supplied-only",
    arbitrary_undeclared_marker_scan: false,
  });
});


test("#799 named Relation may be a logical Projection input through an exact representation", () => {
  const relationV1 = { id: "R_CORE", meaning: "depends_on", source: "A", target: "B" };
  const relationV2 = { id: "R_CORE", meaning: "depends_on", source: "A", target: "C" };
  const file = (relation) => JSON.stringify({ relations: { R_CORE: relation } });
  const output = "derived\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.relation.input",
    sources: [{
      id: "relation",
      kind: "repository_subject",
      subject: { kind: "relation", id: "R_CORE" },
      representation: {
        kind: "resource",
        path: "model/relations.json",
        pointer: "/relations/R_CORE",
      },
      algorithm: "sha256",
    }],
    target: { path: "derived/relation.txt", ownership: "generated" },
    generator: { contract_id: "relation-renderer/v1" },
    required_evidence: [],
  });
  assert.deepEqual(model.sources[0].subject, { kind: "relation", id: "R_CORE" });
  assert.deepEqual(model.sources[0].representation, {
    kind: "resource",
    path: "model/relations.json",
    pointer: "/relations/R_CORE",
  });

  const build = {
    schema: "repo-guard/projection-build-record/v0",
    projection_id: model.id,
    model_identity: projectionModelIdentity(model),
    source_identities: [{
      source_id: "relation",
      algorithm: "sha256",
      digest: sha256(canonical(relationV1)),
    }],
    generator: {
      contract_id: "relation-renderer/v1",
      tool_identity: "fixture@accepted",
    },
    configuration_digest: sha256("config:v1"),
    output_identity: { algorithm: "sha256", digest: sha256(output) },
    evidence: [],
  };
  const context = (relation) => ({
    readFile: (path) => {
      if (path === "model/relations.json") return file(relation);
      if (path === "derived/relation.txt") return output;
      throw new Error("missing " + path);
    },
    diff: { files: { checked: [] } },
  });

  assert.equal(analyzeProjection(model, build, context(relationV1)).freshness, "CURRENT");
  const stale = analyzeProjection(model, build, context(relationV2));
  assert.equal(stale.freshness, "STALE");
  assert.deepEqual(stale.failed_relations, ["projection.relation.input:source:relation"]);
});

test("#799 durable JSON subject lookup rejects duplicate keys", () => {
  const ambiguous = '{"byId":{"core":{"value":1},"core":{"value":2}}}';
  const output = "derived\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.strict-json",
    sources: [{
      id: "core",
      kind: "repository_subject",
      subject: {
        kind: "resource",
        path: "model/data.json",
        pointer: "/byId/core",
      },
      algorithm: "sha256",
    }],
    target: { path: "derived/strict.txt", ownership: "generated" },
    generator: { contract_id: "strict-json/v1" },
    required_evidence: [],
  });
  const build = {
    schema: "repo-guard/projection-build-record/v0",
    projection_id: model.id,
    model_identity: projectionModelIdentity(model),
    source_identities: [{
      source_id: "core",
      algorithm: "sha256",
      digest: sha256(canonical({ value: 2 })),
    }],
    generator: { contract_id: "strict-json/v1", tool_identity: "fixture@accepted" },
    configuration_digest: sha256("config:v1"),
    output_identity: { algorithm: "sha256", digest: sha256(output) },
    evidence: [],
  };
  const result = analyzeProjection(model, build, {
    readFile: (path) => path === "model/data.json" ? ambiguous : output,
    diff: { files: { checked: [] } },
  });
  assert.equal(result.freshness, "BROKEN");
  assert.deepEqual(result.failed_relations, ["projection.strict-json:source:core"]);
});

test("#799 logical region identity is independent of marker spelling and conflicting aliases are RED", () => {
  const aBegin = "<!-- rg:same:a:begin -->";
  const aEnd = "<!-- rg:same:a:end -->";
  const bBegin = "<!-- rg:same:b:begin -->";
  const bEnd = "<!-- rg:same:b:end -->";
  const markdown = [
    '<a id="root"></a>',
    "# Root",
    aBegin,
    "A",
    aEnd,
    bBegin,
    "B",
    bEnd,
    "",
  ].join("\n");
  const a = owned("writer-a", "docs/alias.md", "root", "same", aBegin, aEnd);
  const b = owned("writer-b", "docs/alias.md", "root", "same", bBegin, bEnd);
  const report = analyzeProjectionOwnership({
    live: [a, b],
    readHead: filesReader(new Map([["docs/alias.md", markdown]])),
  });
  assert.equal(report.ok, false);
  assert.equal(report.live_expected.length, 1, "marker spelling must not create a second logical region identity");
  assert.ok(report.conflicts.some((item) => item.code === "multiple_writers"));
  assert.ok(report.conflicts.some((item) => item.code === "locator_alias"));
});

test("#799 incomplete discovery cannot produce a false ownership-closed claim", () => {
  const live = generated("known", "docs/known.md");
  const report = analyzeProjectionOwnership({
    live: [live],
    observedCandidates: [{
      identity: "candidate:unknown-block",
      path: "docs/unknown.md",
      detail: "consumer scanner found a managed-looking marker with no provenance",
    }],
    readHead: filesReader(new Map([
      ["docs/known.md", "known\n"],
      ["docs/unknown.md", "<!-- consumer:managed:begin -->\nunknown\n"],
    ])),
  });
  assert.equal(report.ownership_closed, false);
  assert.equal(report.coverage.status, "incomplete");
  assert.deepEqual(report.unknown_origin, ["candidate:unknown-block"]);
  assert.ok(report.conflicts.some((item) => item.code === "unknown_origin"));
});


test("#799 current analysis separates model/tool/config staleness from output breakage", () => {
  const source = "source\n";
  const output = "output\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.current.identity",
    sources: [{
      id: "source",
      kind: "repository_content",
      path: "model/source.txt",
      algorithm: "sha256",
    }],
    target: { path: "derived/output.txt", ownership: "generated" },
    generator: { contract_id: "generator/v1" },
    required_evidence: [],
  });
  const build = {
    schema: "repo-guard/projection-build-record/v0",
    projection_id: model.id,
    model_identity: projectionModelIdentity(model),
    source_identities: [{
      source_id: "source",
      algorithm: "sha256",
      digest: sha256(source),
    }],
    generator: {
      contract_id: "generator/v1",
      tool_identity: "generator@one",
    },
    configuration_digest: sha256("config:one"),
    output_identity: { algorithm: "sha256", digest: sha256(output) },
    evidence: [],
  };
  const context = (target = output) => ({
    readFile: (path) => {
      if (path === "model/source.txt") return source;
      if (path === "derived/output.txt") return target;
      throw new Error("missing " + path);
    },
    diff: { files: { checked: [] } },
  });

  const current = analyzeProjectionCurrent(model, build, context(), {
    tool_identity: "generator@one",
    configuration_digest: sha256("config:one"),
  });
  assert.equal(current.freshness, "CURRENT");
  assert.deepEqual(current.reasons, []);
  assert.deepEqual(current.verification_scope, {
    causal_inputs: "declared-only",
    renderer_semantics: "not-proven",
  });

  const toolStale = analyzeProjectionCurrent(model, build, context(), {
    tool_identity: "generator@two",
    configuration_digest: sha256("config:one"),
  });
  assert.equal(toolStale.freshness, "STALE");
  assert.ok(toolStale.reasons.includes("tool_identity_changed"));

  const configStale = analyzeProjectionCurrent(model, build, context(), {
    tool_identity: "generator@one",
    configuration_digest: sha256("config:two"),
  });
  assert.equal(configStale.freshness, "STALE");
  assert.ok(configStale.reasons.includes("configuration_changed"));

  const changedModel = {
    ...model,
    generator: { contract_id: "generator/v2" },
  };
  const modelStale = analyzeProjectionCurrent(changedModel, build, context(), {
    tool_identity: "generator@one",
    configuration_digest: sha256("config:one"),
  });
  assert.equal(modelStale.freshness, "STALE");
  assert.ok(modelStale.reasons.includes("model_changed"));
  assert.ok(modelStale.reasons.includes("generator_contract_changed"));

  const broken = analyzeProjectionCurrent(model, build, context("manual\n"), {
    tool_identity: "generator@two",
    configuration_digest: sha256("config:two"),
  });
  assert.equal(broken.freshness, "BROKEN");
  assert.ok(broken.reasons.includes("output_changed"));
  assert.ok(broken.reasons.includes("tool_identity_changed"));
  assert.ok(broken.reasons.includes("configuration_changed"));
});




test("#799 fragment freshness is exact while file-level impact is explicitly conservative", () => {
  const original = JSON.stringify({ byId: { core: { value: 1 }, other: { value: 1 } } });
  const neighborChanged = JSON.stringify({ byId: { core: { value: 1 }, other: { value: 2 } } });
  const output = "derived\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.fragment.impact-scope",
    sources: [{
      id: "core",
      kind: "repository_subject",
      subject: {
        kind: "resource",
        path: "model/data.json",
        pointer: "/byId/core",
      },
      algorithm: "sha256",
    }],
    target: { path: "derived/fragment.txt", ownership: "generated" },
    generator: { contract_id: "fragment-renderer/v1" },
    required_evidence: [],
  });
  const build = {
    schema: "repo-guard/projection-build-record/v0",
    projection_id: model.id,
    model_identity: projectionModelIdentity(model),
    source_identities: [{
      source_id: "core",
      algorithm: "sha256",
      digest: sha256(canonical({ value: 1 })),
    }],
    generator: {
      contract_id: "fragment-renderer/v1",
      tool_identity: "fragment-renderer@1",
    },
    configuration_digest: sha256("config:1"),
    output_identity: { algorithm: "sha256", digest: sha256(output) },
    evidence: [],
  };
  const current = analyzeProjectionCurrent(model, build, {
    readFile: (path) => {
      if (path === "model/data.json") return neighborChanged;
      if (path === "derived/fragment.txt") return output;
      throw new Error("missing " + path);
    },
    diff: {
      files: {
        checked: [{
          path: "model/data.json",
          status: "modified",
          addedLines: ["neighbor changed"],
          deletedLines: ["neighbor old"],
        }],
      },
    },
  }, {
    tool_identity: "fragment-renderer@1",
    configuration_digest: sha256("config:1"),
  });
  assert.equal(current.freshness, "CURRENT", "unchanged selected fragment must remain fresh");
  assert.equal(current.impact, "AFFECTED", "file change conservatively affects the transaction");
  assert.equal(current.impact_scope, "file-conservative");
  assert.deepEqual(current.affected_sources, ["core"]);
});

test("#799 repo-guard check consumes exact BASE/HEAD projection state without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-799-check-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=#799 Fixture", "-c", "user.email=799@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const requirement = `format: repo-guard/requirement-v1
id: CORE
normative: "projection check fixture"
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: ".repo-guard/projections.json"
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "model/source.txt"
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "derived/output.txt"
`;
  const model = {
    schema: "repo-guard/projection-model/v0",
    id: "projection.cli.fixture",
    sources: [{
      id: "source",
      kind: "repository_content",
      path: "model/source.txt",
      algorithm: "sha256",
    }],
    target: { path: "derived/output.txt", ownership: "generated" },
    generator: { contract_id: "fixture-generator/v1" },
    required_evidence: [],
  };
  const state = (source, output) => JSON.stringify({
    schema: "repo-guard/projection-check/v0",
    entries: [{
      state: "live",
      model,
      build: {
        schema: "repo-guard/projection-build-record/v0",
        projection_id: model.id,
        model_identity: projectionModelIdentity(model),
        source_identities: [{
          source_id: "source",
          algorithm: "sha256",
          digest: sha256(source),
        }],
        generator: {
          contract_id: "fixture-generator/v1",
          tool_identity: "fixture-generator@1",
        },
        configuration_digest: sha256("config:1"),
        output_identity: {
          algorithm: "sha256",
          digest: sha256(output),
        },
        evidence: [],
      },
      current_generator: {
        tool_identity: "fixture-generator@1",
        configuration_digest: sha256("config:1"),
      },
    }],
  }, null, 2) + "\n";
  const cliPath = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
  const check = (base, head) => {
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync(process.execPath, [
        cliPath,
        "--repo-root", root,
        "check",
        "--base", base,
        "--head", head,
        "--format", "json",
      ], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
    } catch (error) {
      status = error.status ?? 1;
      stdout = String(error.stdout || "");
    }
    return { status, stdout, report: JSON.parse(stdout) };
  };

  try {
    git("init", "-q");
    put("requirements/core.rg.yaml", requirement);
    put("model/source.txt", "alpha\n");
    put("derived/output.txt", "ALPHA\n");
    put(".repo-guard/projections.json", state("alpha\n", "ALPHA\n"));
    const base = commit("base");

    const current = check(base, base);
    const currentRepeat = check(base, base);
    assert.equal(current.status, 0);
    assert.equal(
      currentRepeat.stdout,
      current.stdout,
      "same exact BASE/HEAD must produce byte-identical JSON report",
    );
    assert.equal(current.report.ok, true);
    assert.equal(current.report.projections.analyses[0].freshness, "CURRENT");
    assert.equal(current.report.projections.ownership.coverage.status, "incomplete");

    const before = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
    assert.equal(before, "", "fixture must be clean before read-only check");

    put("model/source.txt", "beta\n");
    const staleHead = commit("source changed without rebuild");
    const stale = check(base, staleHead);
    assert.notEqual(stale.status, 0);
    assert.equal(stale.report.projections.analyses[0].freshness, "STALE");
    assert.ok(stale.report.diagnostics.some((item) => item.code === "projection_stale"));

    put("derived/output.txt", "BETA\n");
    put(".repo-guard/projections.json", state("beta\n", "BETA\n"));
    const rebuiltHead = commit("record deterministic rebuild");
    const rebuilt = check(base, rebuiltHead);
    assert.equal(rebuilt.status, 0);
    assert.equal(rebuilt.report.projections.analyses[0].freshness, "CURRENT");

    put("derived/output.txt", "MANUAL\n");
    const brokenHead = commit("manual output drift");
    const broken = check(rebuiltHead, brokenHead);
    assert.notEqual(broken.status, 0);
    assert.equal(broken.report.projections.analyses[0].freshness, "BROKEN");
    assert.ok(broken.report.projections.analyses[0].reasons.includes("output_changed"));

    assert.equal(
      execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }),
      "",
      "repo-guard check must not mutate the repository",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("#799 Requirement SubjectRef resolves through canonical identity instead of redeclared path", () => {
  const normative = "stable normative statement";
  const output = "derived\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.requirement.input",
    sources: [{
      id: "requirement",
      kind: "repository_subject",
      subject: { kind: "requirement", id: "REQ-1" },
      algorithm: "sha256",
    }],
    target: { path: "derived/requirement.txt", ownership: "generated" },
    generator: { contract_id: "requirement-renderer/v1" },
    required_evidence: [],
  });
  assert.equal(model.sources[0].representation, undefined);

  assert.throws(
    () => normalizeProjectionModel({
      ...model,
      sources: [{
        id: "requirement",
        kind: "repository_subject",
        subject: { kind: "requirement", id: "REQ-1" },
        representation: { kind: "resource", path: "requirements/wrong.rg.yaml" },
        algorithm: "sha256",
      }],
    }),
    /resolved from the canonical native Requirement index/,
  );

  const build = {
    schema: "repo-guard/projection-build-record/v0",
    projection_id: model.id,
    model_identity: projectionModelIdentity(model),
    source_identities: [{
      source_id: "requirement",
      algorithm: "sha256",
      digest: sha256(canonical(normative)),
    }],
    generator: {
      contract_id: "requirement-renderer/v1",
      tool_identity: "requirement-renderer@1",
    },
    configuration_digest: sha256("config:1"),
    output_identity: { algorithm: "sha256", digest: sha256(output) },
    evidence: [],
  };
  const raw = JSON.stringify({
    schema: "repo-guard/projection-check/v0",
    entries: [{
      state: "live",
      model,
      build,
      current_generator: {
        tool_identity: "requirement-renderer@1",
        configuration_digest: sha256("config:1"),
      },
    }],
  });

  const current = evaluateProjectionCheck({
    baseRaw: null,
    headRaw: raw,
    readHead: (path) => path === "derived/requirement.txt" ? output : null,
    facts: {
      readFile: (path) => path === "derived/requirement.txt" ? output : null,
      diff: { files: { checked: [] } },
    },
    resolveRequirement: (id) => id === "REQ-1"
      ? { digest: sha256(canonical(normative)), path: "requirements/REQ-1.rg.yaml" }
      : null,
  });
  assert.equal(current.ok, true);
  assert.equal(current.analyses[0].freshness, "CURRENT");
  assert.equal(current.analyses[0].impact_scope, "file-conservative");

  const missing = evaluateProjectionCheck({
    baseRaw: null,
    headRaw: raw,
    readHead: (path) => path === "derived/requirement.txt" ? output : null,
    facts: {
      readFile: (path) => path === "derived/requirement.txt" ? output : null,
      diff: { files: { checked: [] } },
    },
    resolveRequirement: () => null,
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((item) => item.code === "projection_subject_unresolved"));
  assert.equal(missing.analyses[0].freshness, "BROKEN");
});

test("#799 named Relation binding rejects a representation of another relation", () => {
  const relationOther = { id: "R_OTHER", meaning: "depends_on", source: "A", target: "B" };
  const output = "derived\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.relation.binding",
    sources: [{
      id: "relation",
      kind: "repository_subject",
      subject: { kind: "relation", id: "R_CORE" },
      representation: {
        kind: "resource",
        path: "model/relations.json",
        pointer: "/relations/R_OTHER",
      },
      algorithm: "sha256",
    }],
    target: { path: "derived/relation-binding.txt", ownership: "generated" },
    generator: { contract_id: "relation-renderer/v1" },
    required_evidence: [],
  });
  const build = {
    schema: "repo-guard/projection-build-record/v0",
    projection_id: model.id,
    model_identity: projectionModelIdentity(model),
    source_identities: [{
      source_id: "relation",
      algorithm: "sha256",
      digest: sha256(canonical(relationOther)),
    }],
    generator: {
      contract_id: "relation-renderer/v1",
      tool_identity: "relation-renderer@1",
    },
    configuration_digest: sha256("config:1"),
    output_identity: { algorithm: "sha256", digest: sha256(output) },
    evidence: [],
  };
  const raw = JSON.stringify({
    schema: "repo-guard/projection-check/v0",
    entries: [{
      state: "live",
      model,
      build,
      current_generator: {
        tool_identity: "relation-renderer@1",
        configuration_digest: sha256("config:1"),
      },
    }],
  });
  const report = evaluateProjectionCheck({
    baseRaw: null,
    headRaw: raw,
    readHead: (path) => {
      if (path === "model/relations.json") return JSON.stringify({ relations: { R_OTHER: relationOther } });
      if (path === "derived/relation-binding.txt") return output;
      return null;
    },
    facts: {
      readFile: (path) => {
        if (path === "model/relations.json") return JSON.stringify({ relations: { R_OTHER: relationOther } });
        if (path === "derived/relation-binding.txt") return output;
        return null;
      },
      diff: { files: { checked: [] } },
    },
  });
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((item) => item.code === "projection_subject_binding"));
  assert.equal(report.analyses[0].freshness, "BROKEN");
});

test("#799 block_id is unique within a file even across different anchors", () => {
  const aBegin = "<!-- rg:a:shared:begin -->";
  const aEnd = "<!-- rg:a:shared:end -->";
  const bBegin = "<!-- rg:b:shared:begin -->";
  const bEnd = "<!-- rg:b:shared:end -->";
  const markdown = [
    '<a id="a"></a>',
    "# A",
    aBegin,
    "A",
    aEnd,
    '<a id="b"></a>',
    "# B",
    bBegin,
    "B",
    bEnd,
    "",
  ].join("\n");
  const report = analyzeProjectionOwnership({
    live: [
      owned("writer-a", "docs/blocks.md", "a", "shared", aBegin, aEnd),
      owned("writer-b", "docs/blocks.md", "b", "shared", bBegin, bEnd),
    ],
    readHead: filesReader(new Map([["docs/blocks.md", markdown]])),
  });
  assert.equal(report.ok, false);
  assert.ok(report.conflicts.some((item) => item.code === "duplicate_block_id"));
  assert.deepEqual(report.invalid_projections, ["writer-a", "writer-b"]);
});

test("#799 global ownership conflict prevents a local CURRENT verdict", () => {
  const output = "same\n";
  const one = generated("writer.one", "docs/shared-current.md");
  const two = generated("writer.two", "docs/shared-current.md");
  const liveEntry = (model) => ({
    state: "live",
    model,
    build: {
      schema: "repo-guard/projection-build-record/v0",
      projection_id: model.id,
      model_identity: projectionModelIdentity(model),
      source_identities: [{
        source_id: "source",
        algorithm: "sha256",
        digest: sha256("source\n"),
      }],
      generator: {
        contract_id: "fixture-generator/v1",
        tool_identity: "fixture-generator@1",
      },
      configuration_digest: sha256("config:1"),
      output_identity: { algorithm: "sha256", digest: sha256(output) },
      evidence: [],
    },
    current_generator: {
      tool_identity: "fixture-generator@1",
      configuration_digest: sha256("config:1"),
    },
  });
  const raw = JSON.stringify({
    schema: "repo-guard/projection-check/v0",
    entries: [liveEntry(one), liveEntry(two)],
  });
  const report = evaluateProjectionCheck({
    baseRaw: null,
    headRaw: raw,
    readHead: (path) => path === "docs/shared-current.md" ? output : null,
    facts: {
      readFile: (path) => {
        if (path === "inputs/source.txt") return "source\n";
        if (path === "docs/shared-current.md") return output;
        return null;
      },
      diff: { files: { checked: [] } },
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.analyses.every((item) => item.freshness === "BROKEN"), true);
  assert.equal(report.analyses.every((item) => item.reasons.includes("ownership_conflict")), true);
});


test("#799 real CLI resolves RequirementId independently of file representation", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-799-requirement-cli-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=#799 Requirement Fixture", "-c", "user.email=799-req@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const normativeV1 = "stable normative statement";
  const normativeV2 = "changed normative statement";
  const semanticDigest = (value) => sha256(JSON.stringify(value));
  const requirementText = (normative, variant = "base") => {
    const optional = variant === "relation"
      ? `  - predicates: [documents]
    target:
      kind: artifact
      path: "derived/output.txt"
`
      : "";
    return `format: repo-guard/requirement-v1
id: CORE
normative: ${JSON.stringify(normative)}
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: ".repo-guard/projections.json"
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "derived/output.txt"
${optional}`;
  };
  const output = "derived\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.requirement.cli",
    sources: [{
      id: "requirement",
      kind: "repository_subject",
      subject: { kind: "requirement", id: "CORE" },
      algorithm: "sha256",
    }],
    target: { path: "derived/output.txt", ownership: "generated" },
    generator: { contract_id: "requirement-renderer/v1" },
    required_evidence: [],
  });
  const state = JSON.stringify({
    schema: "repo-guard/projection-check/v0",
    entries: [{
      state: "live",
      model,
      build: {
        schema: "repo-guard/projection-build-record/v0",
        projection_id: model.id,
        model_identity: projectionModelIdentity(model),
        source_identities: [{
          source_id: "requirement",
          algorithm: "sha256",
          digest: semanticDigest(normativeV1),
        }],
        generator: {
          contract_id: "requirement-renderer/v1",
          tool_identity: "requirement-renderer@1",
        },
        configuration_digest: sha256("config:1"),
        output_identity: {
          algorithm: "sha256",
          digest: sha256(output),
        },
        evidence: [],
      },
      current_generator: {
        tool_identity: "requirement-renderer@1",
        configuration_digest: sha256("config:1"),
      },
    }],
  }, null, 2) + "\n";
  const cliPath = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
  const check = (base, head) => {
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync(process.execPath, [
        cliPath,
        "--repo-root", root,
        "check",
        "--base", base,
        "--head", head,
        "--format", "json",
      ], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
    } catch (error) {
      status = error.status ?? 1;
      stdout = String(error.stdout || "");
    }
    return { status, report: JSON.parse(stdout) };
  };

  try {
    git("init", "-q");
    put("requirements/CORE.rg.yaml", requirementText(normativeV1));
    put(".repo-guard/projections.json", state);
    put("derived/output.txt", output);
    const base = commit("canonical Requirement projection baseline");

    const current = check(base, base);
    assert.equal(current.status, 0);
    assert.equal(current.report.projections.analyses[0].freshness, "CURRENT");

    put("requirements/CORE.rg.yaml", [
      "# formatting-only comment",
      "",
      requirementText(normativeV1),
    ].join("\n"));
    const formatting = commit("format Requirement representation only");
    const formatCheck = check(base, formatting);
    assert.equal(formatCheck.status, 0);
    assert.equal(
      formatCheck.report.projections.analyses[0].freshness,
      "CURRENT",
      "Requirement path/file bytes are not the normative Subject identity",
    );

    put("requirements/CORE.rg.yaml", requirementText(normativeV1, "relation"));
    const relationOnly = commit("change Requirement relation only");
    const relationCheck = check(formatting, relationOnly);
    assert.equal(relationCheck.status, 0);
    assert.equal(
      relationCheck.report.projections.analyses[0].freshness,
      "CURRENT",
      "Projection depending only on Requirement normative Subject ignores relation-only drift",
    );

    put("requirements/CORE.rg.yaml", requirementText(normativeV2, "relation"));
    const normativeChanged = commit("change normative Requirement subject");
    const stale = check(relationOnly, normativeChanged);
    assert.notEqual(stale.status, 0);
    assert.equal(stale.report.projections.analyses[0].freshness, "STALE");
    assert.ok(stale.report.projections.analyses[0].reasons.includes("source_changed:requirement"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#799 duplicate native RequirementId makes dependent Projection BROKEN in real CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-799-ambiguous-requirement-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const requirement = [
    "format: repo-guard/requirement-v1",
    "id: CORE",
    "normative: X",
    "relations:",
    "  - predicates: [implemented_by]",
    "    target:",
    "      kind: artifact",
    '      path: ".repo-guard/projections.json"',
    "  - predicates: [implemented_by]",
    "    target:",
    "      kind: artifact",
    '      path: "derived/output.txt"',
    "",
  ].join("\n");
  const output = "stable derived output\n";
  const model = normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: "projection.requirement.ambiguous",
    sources: [{
      id: "normative",
      kind: "repository_subject",
      subject: { kind: "requirement", id: "CORE" },
      algorithm: "sha256",
    }],
    target: { path: "derived/output.txt", ownership: "generated" },
    generator: { contract_id: "requirement-renderer/v1" },
    required_evidence: [],
  });
  const state = JSON.stringify({
    schema: "repo-guard/projection-check/v0",
    entries: [{
      state: "live",
      model,
      build: {
        schema: "repo-guard/projection-build-record/v0",
        projection_id: model.id,
        model_identity: projectionModelIdentity(model),
        source_identities: [{
          source_id: "normative",
          algorithm: "sha256",
          digest: sha256(canonical("X")),
        }],
        generator: {
          contract_id: "requirement-renderer/v1",
          tool_identity: "requirement-renderer@1",
        },
        configuration_digest: sha256("config:1"),
        output_identity: { algorithm: "sha256", digest: sha256(output) },
        evidence: [],
      },
      current_generator: {
        tool_identity: "requirement-renderer@1",
        configuration_digest: sha256("config:1"),
      },
    }],
  }, null, 2) + "\n";

  try {
    git("init", "-q");
    put("requirements/A.rg.yaml", requirement);
    put("requirements/B.rg.yaml", requirement);
    put(".repo-guard/projections.json", state);
    put("derived/output.txt", output);
    git("add", "-A");
    git("-c", "user.name=#799 Duplicate Requirement", "-c", "user.email=799-dup@example.invalid",
      "commit", "-qm", "two files claim one canonical RequirementId");
    const revision = git("rev-parse", "HEAD");

    // The canonical native loader itself rejects the ambiguous model.
    const native = loadNativeRequirements({
      repository: "local/repository",
      revision,
      paths: ["requirements/A.rg.yaml", "requirements/B.rg.yaml"],
      readFile: (_sha, path) => path === "requirements/A.rg.yaml" || path === "requirements/B.rg.yaml"
        ? requirement : null,
    });
    assert.equal(native.ok, false);
    assert.ok(native.errors.some((item) => item.code === "duplicate_requirement_id"));

    const cliPath = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync(process.execPath, [
        cliPath, "--repo-root", root, "check",
        "--base", revision, "--head", revision, "--format", "json",
      ], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
    } catch (error) {
      status = error.status ?? 1;
      stdout = String(error.stdout || "");
    }
    const report = JSON.parse(stdout);
    assert.notEqual(status, 0);
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.some((item) =>
      item.code === "invalid_requirement" && /duplicate RequirementId CORE/.test(item.detail || "")));
    const dependent = report.projections.analyses.find((item) => item.projection_id === model.id);
    assert.ok(dependent, "dependent Projection must be included in local compiler report");
    assert.equal(dependent.freshness, "BROKEN");
    assert.notEqual(dependent.freshness, "CURRENT");
    assert.ok(report.diagnostics.some((item) =>
      item.code === "projection_subject_unresolved"
      && item.subject === model.id + ":source:normative"));
    assert.equal(git("status", "--porcelain=v1"), "", "read-only check must not mutate fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#822 G1 clean BASE HYBRID retirement does not enforce a retired HEAD anchor", () => {
  const begin = "<!-- rg:retired:begin -->";
  const end = "<!-- rg:retired:end -->";
  const previous = owned("previous", "README.md", "old-anchor", "retired", begin, end);
  const head = "# Replacement document\n\nNo retired anchor or owned markers remain.\n";
  const report = analyzeProjectionOwnership({
    live: [],
    base: [previous],
    readHead: filesReader(new Map([["README.md", head]])),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.observed, []);
  assert.deepEqual(report.orphan, []);
  assert.equal(report.conflicts.some((item) => item.code === "malformed_target"), false);
});

test("#822 G2 BASE HYBRID may retire into one HEAD GENERATED whole-file writer", () => {
  const begin = "<!-- rg:retired:begin -->";
  const end = "<!-- rg:retired:end -->";
  const previous = owned("previous", "README.md", "old-anchor", "retired", begin, end);
  const current = generated("current", "README.md");
  const head = "# Fully generated replacement\n";
  const report = analyzeProjectionOwnership({
    live: [current],
    base: [previous],
    readHead: filesReader(new Map([["README.md", head]])),
  });

  assert.equal(report.ok, true, JSON.stringify(report.conflicts));
  assert.deepEqual(report.orphan, []);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.invalid_projections, []);
  for (const code of ["multiple_writers", "managed_overlap", "malformed_target"]) {
    assert.equal(report.conflicts.some((item) => item.code === code), false, code);
  }
});

test("#822 G3 surviving retired BASE region remains orphan RED", () => {
  const begin = "<!-- rg:retired:begin -->";
  const end = "<!-- rg:retired:end -->";
  const previous = owned("previous", "docs/residue.md", "old-anchor", "retired", begin, end);
  const head = [
    '<a id="old-anchor"></a>',
    "# Old",
    begin,
    "surviving managed residue",
    end,
    "",
  ].join("\n");
  const report = analyzeProjectionOwnership({
    live: [],
    base: [previous],
    readHead: filesReader(new Map([["docs/residue.md", head]])),
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.orphan, report.observed);
  assert.equal(report.orphan.length, 1);
});

test("#822 G4 malformed surviving retired BASE residue remains RED", () => {
  const begin = "<!-- rg:retired:begin -->";
  const end = "<!-- rg:retired:end -->";
  const previous = owned("previous", "docs/malformed-residue.md", "old-anchor", "retired", begin, end);
  const head = [
    '<a id="old-anchor"></a>',
    "# Old",
    begin,
    "first",
    begin,
    "duplicate begin marker",
    end,
    "",
  ].join("\n");
  const report = analyzeProjectionOwnership({
    live: [],
    base: [previous],
    readHead: filesReader(new Map([["docs/malformed-residue.md", head]])),
  });

  assert.equal(report.ok, false);
  assert.ok(report.conflicts.some((item) =>
    item.code === "malformed_target" && /malformed owned block/.test(item.detail || "")));
});

test("#822 G5 active writer, locator, containment and SOURCE safety remain fail-closed", () => {
  const begin = "<!-- rg:active:begin -->";
  const end = "<!-- rg:active:end -->";
  const activeDoc = ['<a id="active"></a>', "# Active", begin, "owned", end, ""].join("\n");

  const twoWriters = analyzeProjectionOwnership({
    live: [generated("one", "docs/generated.md"), generated("two", "docs/generated.md")],
    readHead: filesReader(new Map([["docs/generated.md", "generated\n"]])),
  });
  assert.ok(twoWriters.conflicts.some((item) => item.code === "multiple_writers"));

  const wholeAndRegion = analyzeProjectionOwnership({
    live: [
      generated("whole", "docs/active.md"),
      owned("region", "docs/active.md", "active", "active", begin, end),
    ],
    readHead: filesReader(new Map([["docs/active.md", activeDoc]])),
  });
  assert.ok(wholeAndRegion.conflicts.some((item) => item.code === "managed_overlap"));

  const liveRetained = analyzeProjectionOwnership({
    live: [generated("live", "docs/retained.md")],
    retained: [generated("retained", "docs/retained.md")],
    readHead: filesReader(new Map([["docs/retained.md", "retained\n"]])),
  });
  assert.ok(liveRetained.conflicts.some((item) => item.code === "live_retained_overlap"));

  const malformedLive = analyzeProjectionOwnership({
    live: [owned("live", "docs/missing-anchor.md", "missing", "active", begin, end)],
    readHead: filesReader(new Map([["docs/missing-anchor.md", "# No anchor or block\n"]])),
  });
  assert.ok(malformedLive.conflicts.some((item) => item.code === "malformed_target"));

  const outside = [
    '<a id="a"></a>',
    "# A",
    "",
    '<a id="b"></a>',
    "# B",
    begin,
    "owned under B",
    end,
    "",
  ].join("\n");
  const containment = analyzeProjectionOwnership({
    live: [owned("live", "docs/containment.md", "a", "active", begin, end)],
    readHead: filesReader(new Map([["docs/containment.md", outside]])),
  });
  assert.ok(containment.conflicts.some((item) => item.code === "containment"));

  const sourceModel = generated("former", "docs/source.md");
  const sourceState = JSON.stringify({
    schema: "repo-guard/projection-check/v0",
    entries: [{ state: "source", model: sourceModel }],
  });
  const sourceReport = evaluateProjectionCheck({
    baseRaw: JSON.stringify({ schema: "repo-guard/projection-check/v0", entries: [] }),
    headRaw: sourceState,
    readHead: () => "source\n",
    facts: { readFile: () => "source\n", diff: { files: { checked: [] } } },
  });
  assert.equal(sourceReport.ok, false);
  assert.ok(sourceReport.diagnostics.some((item) =>
    item.code === "projection_source_reclassification_invalid"));
});



test("#831 Git adapter preserves byte identity before projection hashing", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-831-byte-"));
  const git831 = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit831 = (message) => {
    git831("add", "-A");
    git831("-c", "user.name=RepoGuard Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message);
    return git831("rev-parse", "HEAD");
  };
  try {
    git831("init", "-q");
    const oldBytes = Buffer.from([0xef, 0xbf, 0xbd]);
    const newBytes = Buffer.from([0xff]);
    const output = Buffer.from("derived", "utf8");

    writeFileSync(join(root, "input.txt"), oldBytes);
    writeFileSync(join(root, "output.txt"), output);

    const model = normalizeProjectionModel({
      schema: "repo-guard/projection-model/v0",
      id: "binary-source",
      sources: [{
        id: "input",
        kind: "repository_content",
        path: "input.txt",
        algorithm: "sha256",
      }],
      target: { path: "output.txt", ownership: "generated" },
      generator: { contract_id: "renderer/v1" },
      required_evidence: [],
    });
    const build = {
      schema: "repo-guard/projection-build-record/v0",
      projection_id: model.id,
      model_identity: projectionModelIdentity(model),
      source_identities: [{
        source_id: "input",
        algorithm: "sha256",
        digest: sha256(oldBytes),
      }],
      generator: {
        contract_id: "renderer/v1",
        tool_identity: "renderer@1",
      },
      configuration_digest: sha256("config"),
      output_identity: {
        algorithm: "sha256",
        digest: sha256(output),
      },
      evidence: [],
    };
    const raw = JSON.stringify({
      schema: "repo-guard/projection-check/v0",
      entries: [{
        state: "live",
        model,
        build,
        current_generator: {
          tool_identity: "renderer@1",
          configuration_digest: sha256("config"),
        },
      }],
    });

    mkdirSync(join(root, ".repo-guard"));
    writeFileSync(join(root, ".repo-guard", "projections.json"), raw);
    const base = commit831("base");

    const evaluate = (revision, changed) => {
      const read = (path) => readFileBytesAtRef(revision, path, root);
      return evaluateProjectionCheck({
        baseRaw: raw,
        headRaw: raw,
        readHead: read,
        facts: {
          readFile: read,
          diff: { files: { checked: changed ? [{ path: "input.txt", status: "modified" }] : [] } },
        },
      });
    };

    const baseReport = evaluate(base, false);
    assert.equal(baseReport.ok, true);
    assert.equal(baseReport.analyses[0].freshness, "CURRENT");

    writeFileSync(join(root, "input.txt"), newBytes);
    const head = commit831("head");
    assert.notEqual(sha256(oldBytes), sha256(newBytes));

    const headReport = evaluate(head, true);
    assert.equal(headReport.ok, false);
    assert.equal(headReport.analyses[0].freshness, "STALE");
    assert.ok(headReport.analyses[0].reasons.includes("source_changed:input"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#831 canonical textual Requirement rejects invalid UTF-8 from exact Git blob", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-831-utf8-"));
  const git831 = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git831("init", "-q");
    mkdirSync(join(root, "requirements"));
    const raw = Buffer.concat([
      Buffer.from("format: repo-guard/requirement-v1\nid: Q\nnormative: \"", "utf8"),
      Buffer.from([0xff]),
      Buffer.from("\"\n", "utf8"),
    ]);
    writeFileSync(join(root, "requirements", "Q.rg.yaml"), raw);
    git831("add", "-A");
    git831("-c", "user.name=RepoGuard Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "invalid utf8");
    const revision = git831("rev-parse", "HEAD");

    const result = loadCanonicalRequirements({
      repository: "audit/fixture",
      revision,
      paths: ["requirements/Q.rg.yaml"],
      readFile: (sha, path) => readFileBytesAtRef(sha, path, root),
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "invalid_canonical_source");
    assert.match(result.errors[0]?.message || "", /valid UTF-8/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
