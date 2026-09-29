import assert from "node:assert/strict";
import * as api from "../dist/projection-api.mjs";

const expectedRuntimeExports = [
  "analyzeProjection",
  "insertMarkdownChild",
  "listMarkdownAnchorIds",
  "listMarkdownChildren",
  "listMarkdownSections",
  "normalizeProjectionBuildRecord",
  "normalizeProjectionModel",
  "parseMarkdown",
  "projectionModelIdentity",
  "readMarkdownNode",
  "readOwnedMarkdownBlock",
  "replaceOwnedMarkdownBlock",
  "resolveMarkdownAnchor",
];

assert.deepEqual(
  Object.keys(api).sort(),
  expectedRuntimeExports,
  "the external runtime entrypoint must expose only the curated projection/MDDB surface",
);

for (const forbidden of [
  "evaluatePrimitiveRelation",
  "lowerProjectionVerification",
  "readFact",
  "relationDescriptors",
]) {
  assert.equal(Object.hasOwn(api, forbidden), false, `${forbidden} must remain internal`);
}

const source = [
  '<a id="root"></a>',
  "# Root",
  "",
  '<a id="child"></a>',
  "## Child",
].join("\n");

assert.deepEqual(api.listMarkdownAnchorIds(source), ["root", "child"]);
assert.equal(api.readMarkdownNode(source, "child").heading.text, "Child");
assert.deepEqual(
  api.listMarkdownSections(source).map((section) => section.anchorId),
  ["root", "child"],
  "section inventory must be part of the curated runtime surface after P10b",
);

const model = api.normalizeProjectionModel({
  schema: "repo-guard/projection-model/v0",
  id: "projection.public-api.smoke",
  sources: [
    {
      id: "source",
      kind: "repository_content",
      path: "model/source.txt",
      algorithm: "sha256",
    },
  ],
  target: {
    path: "derived/output.md",
    ownership: "generated",
  },
  generator: {
    contract_id: "external-generator/v1",
  },
  required_evidence: [],
});

assert.equal(model.id, "projection.public-api.smoke");
assert.match(api.projectionModelIdentity(model), /^[0-9a-f]{64}$/);

const packageJson = JSON.parse(
  await (await import("node:fs/promises")).readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ),
);
assert.ok(
  packageJson.files.includes("dist/"),
  "npm package boundary must include the curated dist/projection-api.mjs entrypoint",
);

console.log("Projection runtime public API boundary passed.");
