import assert from "node:assert/strict";
import {
  checkRoutineRequirementTransition,
  normalizeRequirementAuthority,
} from "../dist/requirement-relations.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const requirementPath = "requirements/r1.yaml";

const baseSource = [
  "id: RG-R1",
  "artifacts:",
  "  - path: requirements/r1.yaml",
  "    relations: [requires]",
  "",
].join("\n");

function headSource(role) {
  return [
    "id: RG-R1",
    "artifacts:",
    "  - path: requirements/r1.yaml",
    "    relations: [requires]",
    "  - path: src/a.mts",
    `    role: "${role}"`,
    "    relations: [requires, implements]",
    "",
  ].join("\n");
}

function graph(snapshot, revision, content) {
  return normalizeRequirementAuthority({
    snapshot,
    revision,
    sources: [{ path: requirementPath, format: "yaml", content }],
  });
}

function evaluate(role) {
  const headRaw = headSource(role);
  const base = graph("base", BASE, baseSource);
  const head = graph("head", HEAD, headRaw);
  return checkRoutineRequirementTransition({
    base,
    head,
    changedFiles: [
      { path: requirementPath, status: "modified", addedLines: [], deletedLines: [] },
      { path: "src/a.mts", status: "added", addedLines: ["export const a = 1;"], deletedLines: [] },
    ],
    headTrackedFiles: [requirementPath, "src/a.mts"],
    readFileAtRef: (revision, path) => path === requirementPath
      ? (revision === BASE ? baseSource : revision === HEAD ? headRaw : null)
      : null,
    governancePaths: ["requirements/**"],
    forbiddenPaths: [],
    closedRepository: false,
  });
}

const canonical = evaluate("authority");
assert.equal(canonical.ok, false);
assert.ok(canonical.reasons.some((reason) => reason === "routine_new_protected_artifact_role:src/a.mts"));

const padded = evaluate(" authority ");
assert.equal(padded.ok, false, "protected artifact roles must not bypass the routine gate through surrounding whitespace");
assert.ok(padded.reasons.some((reason) => reason === "routine_new_protected_artifact_role:src/a.mts"));

console.log("#681 protected role normalization boundary passed");
