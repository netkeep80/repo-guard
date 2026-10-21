import {
  normalizeProjectionModel,
  type ProjectionModel,
  type ProjectionTarget,
} from "./projection-model.mjs";
import {
  readMarkdownNode,
  readOwnedMarkdownBlock,
  type MarkdownOwnedBlock,
} from "./markdown-structure.mjs";

export type ProjectionInventoryState = "live" | "retained" | "base";

export type ProjectionOwnershipConflictCode =
  | "invalid_projection"
  | "duplicate_projection_id"
  | "multiple_writers"
  | "live_retained_overlap"
  | "insufficient_locator"
  | "unreadable_target"
  | "malformed_target"
  | "containment"
  | "managed_overlap";

export interface ProjectionOwnershipConflict {
  code: ProjectionOwnershipConflictCode;
  subject: string;
  path?: string;
  detail?: string;
}

export interface ProjectionOwnershipReport {
  ok: boolean;
  coverage: {
    expected_from: "live-and-retained-declarations";
    observed_from: "live-retained-and-base-declarations";
    arbitrary_undeclared_marker_scan: false;
  };
  live_expected: string[];
  retained: string[];
  base: string[];
  observed: string[];
  missing: string[];
  orphan: string[];
  conflicts: ProjectionOwnershipConflict[];
}

export interface ProjectionOwnershipInput {
  live: readonly unknown[];
  retained?: readonly unknown[];
  base?: readonly unknown[];
  readHead: (path: string) => unknown;
}

interface ModelEntry {
  state: ProjectionInventoryState;
  model: ProjectionModel;
}

interface TargetSpec {
  key: string;
  path: string;
  target: ProjectionTarget;
  state: ProjectionInventoryState;
  projection_id: string;
}

interface ObservedRegion {
  key: string;
  path: string;
  start: number;
  end: number;
}

function targetKey(target: ProjectionTarget): string {
  if (target.ownership === "generated") {
    return JSON.stringify({ kind: "whole_file", path: target.path });
  }
  if (target.locator?.kind === "markdown_owned_block") {
    return JSON.stringify({
      kind: "markdown_owned_block",
      path: target.path,
      anchor_id: target.locator.anchor_id,
      block_id: target.locator.block_id,
      begin_marker: target.locator.begin_marker,
      end_marker: target.locator.end_marker,
    });
  }
  return JSON.stringify({
    kind: "markdown_anchor",
    path: target.path,
    anchor_id: target.locator?.anchor_id ?? "",
  });
}

function normalizeEntries(
  values: readonly unknown[],
  state: ProjectionInventoryState,
  conflicts: ProjectionOwnershipConflict[],
): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const ids = new Set<string>();
  values.forEach((value, index) => {
    let model: ProjectionModel;
    try {
      model = normalizeProjectionModel(value);
    } catch (error) {
      conflicts.push({
        code: "invalid_projection",
        subject: `${state}[${index}]`,
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (ids.has(model.id)) {
      conflicts.push({
        code: "duplicate_projection_id",
        subject: `${state}:${model.id}`,
      });
      return;
    }
    ids.add(model.id);
    entries.push({ state, model });
  });
  return entries;
}

function specs(entries: readonly ModelEntry[]): TargetSpec[] {
  return entries.map(({ state, model }) => ({
    key: targetKey(model.target),
    path: model.target.path,
    target: model.target,
    state,
    projection_id: model.id,
  }));
}

function readHeadText(
  input: ProjectionOwnershipInput,
  path: string,
  conflicts: ProjectionOwnershipConflict[],
  subject: string,
): string | null {
  let raw: unknown;
  try {
    raw = input.readHead(path);
  } catch (error) {
    conflicts.push({
      code: "unreadable_target",
      subject,
      path,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (raw === null || raw === undefined) return null;
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
}

function observeOwnedBlock(
  source: string,
  spec: TargetSpec,
  conflicts: ProjectionOwnershipConflict[],
): { observed: boolean; region?: ObservedRegion } {
  if (spec.target.ownership !== "hybrid" || spec.target.locator?.kind !== "markdown_owned_block") {
    return { observed: false };
  }
  const locator = spec.target.locator;
  const blockSpec = {
    blockId: locator.block_id,
    beginMarker: locator.begin_marker,
    endMarker: locator.end_marker,
  };

  let block: MarkdownOwnedBlock | null;
  try {
    block = readOwnedMarkdownBlock(source, blockSpec);
  } catch (error) {
    conflicts.push({
      code: "malformed_target",
      subject: spec.key,
      path: spec.path,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { observed: false };
  }

  let node;
  try {
    node = readMarkdownNode(source, locator.anchor_id, {
      transparentOwnedBlocks: [blockSpec],
    });
  } catch (error) {
    conflicts.push({
      code: "malformed_target",
      subject: spec.key,
      path: spec.path,
      detail: error instanceof Error ? error.message : String(error),
    });
    if (!block) return { observed: false };
    return {
      observed: true,
      region: { key: spec.key, path: spec.path, start: block.start, end: block.end },
    };
  }

  if (!block) return { observed: false };
  if (block.start < node.start || block.end > node.end) {
    conflicts.push({
      code: "containment",
      subject: spec.key,
      path: spec.path,
      detail: `owned block "${locator.block_id}" is outside anchor "${locator.anchor_id}" node`,
    });
  }
  return {
    observed: true,
    region: { key: spec.key, path: spec.path, start: block.start, end: block.end },
  };
}

function observeSpec(
  input: ProjectionOwnershipInput,
  spec: TargetSpec,
  conflicts: ProjectionOwnershipConflict[],
): { observed: boolean; region?: ObservedRegion } {
  const source = readHeadText(input, spec.path, conflicts, spec.key);
  if (source === null) return { observed: false };

  if (spec.target.ownership === "generated") {
    return {
      observed: true,
      region: { key: spec.key, path: spec.path, start: 0, end: source.length },
    };
  }

  if (spec.target.locator?.kind === "markdown_owned_block") {
    return observeOwnedBlock(source, spec, conflicts);
  }

  conflicts.push({
    code: "insufficient_locator",
    subject: spec.key,
    path: spec.path,
    detail: "hybrid markdown_anchor is address-only and does not establish an owned writable region",
  });

  const anchorId = spec.target.locator?.anchor_id;
  if (!anchorId) return { observed: false };
  try {
    const node = readMarkdownNode(source, anchorId);
    return {
      observed: true,
      region: { key: spec.key, path: spec.path, start: node.start, end: node.end },
    };
  } catch (error) {
    conflicts.push({
      code: "malformed_target",
      subject: spec.key,
      path: spec.path,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { observed: false };
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function pushDeclaredConflicts(
  allSpecs: readonly TargetSpec[],
  conflicts: ProjectionOwnershipConflict[],
): void {
  const live = allSpecs.filter((spec) => spec.state === "live");
  const retained = allSpecs.filter((spec) => spec.state === "retained");

  const writers = new Map<string, string[]>();
  for (const spec of live) {
    const ids = writers.get(spec.key) || [];
    ids.push(spec.projection_id);
    writers.set(spec.key, ids);
  }
  for (const [key, ids] of writers) {
    const unique = sorted(ids);
    if (unique.length > 1) {
      conflicts.push({
        code: "multiple_writers",
        subject: key,
        detail: unique.join(","),
      });
    }
  }

  const retainedKeys = new Set(retained.map((spec) => spec.key));
  for (const spec of live) {
    if (retainedKeys.has(spec.key)) {
      conflicts.push({
        code: "live_retained_overlap",
        subject: spec.key,
        path: spec.path,
      });
    }
  }

  const liveByPath = new Map<string, TargetSpec[]>();
  for (const spec of live) {
    const list = liveByPath.get(spec.path) || [];
    list.push(spec);
    liveByPath.set(spec.path, list);
  }
  for (const [path, pathSpecs] of liveByPath) {
    const wholeFile = pathSpecs.filter((spec) => spec.target.ownership === "generated");
    if (!wholeFile.length || pathSpecs.length === wholeFile.length) continue;
    conflicts.push({
      code: "managed_overlap",
      subject: path,
      path,
      detail: "whole-file writer overlaps a managed region writer",
    });
  }
}

function pushObservedOverlap(
  regions: readonly ObservedRegion[],
  conflicts: ProjectionOwnershipConflict[],
): void {
  const ordered = [...regions].sort(
    (left, right) =>
      left.path.localeCompare(right.path, "en")
      || left.start - right.start
      || left.end - right.end
      || left.key.localeCompare(right.key, "en"),
  );
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex]!;
      if (right.path !== left.path) break;
      if (right.start >= left.end) break;
      if (left.key === right.key) continue;
      if (left.start < right.end && right.start < left.end) {
        conflicts.push({
          code: "managed_overlap",
          subject: `${left.key} <-> ${right.key}`,
          path: left.path,
          detail: `intervals [${left.start},${left.end}) and [${right.start},${right.end}) overlap`,
        });
      }
    }
  }
}

export function analyzeProjectionOwnership(
  input: ProjectionOwnershipInput,
): ProjectionOwnershipReport {
  const conflicts: ProjectionOwnershipConflict[] = [];
  const entries = [
    ...normalizeEntries(input.live, "live", conflicts),
    ...normalizeEntries(input.retained || [], "retained", conflicts),
    ...normalizeEntries(input.base || [], "base", conflicts),
  ];
  const allSpecs = specs(entries);
  pushDeclaredConflicts(allSpecs, conflicts);

  const liveExpected = sorted(
    allSpecs.filter((spec) => spec.state === "live").map((spec) => spec.key),
  );
  const retained = sorted(
    allSpecs.filter((spec) => spec.state === "retained").map((spec) => spec.key),
  );
  const base = sorted(
    allSpecs.filter((spec) => spec.state === "base").map((spec) => spec.key),
  );

  const uniqueSpecs = new Map<string, TargetSpec>();
  for (const spec of allSpecs) {
    if (!uniqueSpecs.has(spec.key)) uniqueSpecs.set(spec.key, spec);
  }

  const observed = new Set<string>();
  const regions: ObservedRegion[] = [];
  for (const spec of [...uniqueSpecs.values()].sort((a, b) => a.key.localeCompare(b.key, "en"))) {
    const result = observeSpec(input, spec, conflicts);
    if (!result.observed) continue;
    observed.add(spec.key);
    if (result.region) regions.push(result.region);
  }
  pushObservedOverlap(regions, conflicts);

  const expected = new Set([...liveExpected, ...retained]);
  const observedSorted = sorted(observed);
  const missing = sorted([...expected].filter((key) => !observed.has(key)));
  const orphan = sorted(observedSorted.filter((key) => !expected.has(key)));

  conflicts.sort(
    (left, right) =>
      left.code.localeCompare(right.code, "en")
      || left.subject.localeCompare(right.subject, "en")
      || (left.path || "").localeCompare(right.path || "", "en")
      || (left.detail || "").localeCompare(right.detail || "", "en"),
  );

  return {
    ok: conflicts.length === 0 && missing.length === 0 && orphan.length === 0,
    coverage: {
      expected_from: "live-and-retained-declarations",
      observed_from: "live-retained-and-base-declarations",
      arbitrary_undeclared_marker_scan: false,
    },
    live_expected: liveExpected,
    retained,
    base,
    observed: observedSorted,
    missing,
    orphan,
    conflicts,
  };
}
