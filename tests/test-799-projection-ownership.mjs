import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  analyzeProjection,
  analyzeProjectionOwnership,
  normalizeProjectionModel,
  projectionModelIdentity,
} from "../dist/projection-api.mjs";

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
  assert.ok(report.conflicts.some((item) =>
    item.code === "managed_overlap" &&
    item.detail === "whole-file writer overlaps a managed region writer"));
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
  assert.deepEqual(first.coverage, {
    expected_from: "live-and-retained-declarations",
    observed_from: "live-retained-and-base-declarations",
    arbitrary_undeclared_marker_scan: false,
  });
});
