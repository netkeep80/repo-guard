import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAnchorDiagnostics } from "../dist/reporting/anchor-diagnostics.mjs";

describe("anchor diagnostics reporting boundary", () => {
  it("sorts and deduplicates declared anchors while preserving per-type changed counts", () => {
    const detected = [
      { anchorType: "req", value: "FR-002", file: "requirements/fr-002.json", sourceKind: "json_field", raw: "FR-002" },
      { anchorType: "req", value: "FR-001", file: "src/feature.mjs", sourceKind: "regex", raw: "FR-001" },
    ];
    const result = buildAnchorDiagnostics({
      policy: {
        paths: {},
        anchors: { types: { req: { sources: [] }, empty: { sources: [] } } },
        trace_rules: [],
      },
      anchors: { instances: detected, byType: { req: detected, empty: [] }, errors: [] },
      derived: { changedPaths: ["src/feature.mjs"] },
      changeIntent: { anchors: { affects: ["FR-002", "FR-001", "FR-002"], implements: [], verifies: [] } },
      diff: { files: { all: [], checked: [], skippedOperational: [] } },
      diagnostics: { skippedOperationalFiles: 0 },
    });

    assert.deepEqual(result.anchors.declaredByChangeIntent.affects, ["FR-001", "FR-002"]);
    assert.equal(result.anchors.stats.declaredByChangeIntent, 2);
    assert.deepEqual(result.anchors.stats.byType, {
      empty: { detected: 0, changed: 0 },
      req: { detected: 2, changed: 1 },
    });
  });
});
