import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRequirementAuthority } from "../dist/requirement-relations.mjs";

test("#697 RED: accepted artifact-only Requirement graph cannot express rooted Requirement provenance", () => {
  const graph = normalizeRequirementAuthority({
    snapshot: "head",
    revision: "b".repeat(40),
    sources: [
      {
        path: "requirements/root.yaml",
        format: "yaml",
        content: [
          "id: ROOT",
          "relations: []",
          "",
        ].join("\n"),
      },
      {
        path: "requirements/r1.yaml",
        format: "yaml",
        content: [
          "id: R1",
          "relations:",
          "  provenance:",
          "    predicate: derives_from",
          "    target:",
          "      kind: requirement",
          "      id: ROOT",
          "",
        ].join("\n"),
      },
    ],
  });

  assert.ok(
    graph.relations.some((relation) =>
      relation.subject === "R1"
      && relation.relation === "derives_from"
      && relation.object === "ROOT"
    ),
    "#697 RED: accepted RequirementAuthorityGraph is artifact-only and cannot serve as rooted J2 closure source",
  );
});
