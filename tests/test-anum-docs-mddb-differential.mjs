import assert from "node:assert/strict";
import {
  readMarkdownNode,
  listMarkdownChildren,
  readOwnedMarkdownBlock,
} from "../dist/markdown-structure.mjs";

const begin = "<!-- consumer:metadata:A:begin -->";
const end = "<!-- consumer:metadata:A:end -->";
const metadataBlock = {
  blockId: "metadata-A",
  beginMarker: begin,
  endMarker: end,
};
const options = {
  transparentOwnedBlocks: [metadataBlock],
};

const source = [
  '<a id="db-root"></a>',
  "# Root",
  "Root payload.",
  "",
  '<a id="db-a"></a>',
  begin,
  "> generated metadata before heading",
  end,
  "## Node A",
  "Authored A.",
  "",
  '<a id="db-a1"></a>',
  "### Node A1",
  "Authored A1.",
  "",
  '<a id="db-b"></a>',
  "## Node B",
  "Authored B.",
].join("\n");

const owned = readOwnedMarkdownBlock(source, metadataBlock);
assert.ok(owned, "baseline owned block must resolve");

const a = readMarkdownNode(source, "db-a", options);
assert.equal(a.heading.text, "Node A");
assert.deepEqual(
  a.headingPath.map((heading) => [heading.level, heading.text]),
  [[1, "Root"], [2, "Node A"]],
  "a declared compiler-owned metadata block between anchor and heading must be transparent to canonical node addressing",
);
assert.match(a.subtree, /generated metadata before heading/);
assert.match(a.subtree, /Authored A/);
assert.ok(!a.subtree.includes('<a id="db-b"></a>'));

assert.deepEqual(
  listMarkdownChildren(source, "db-root", options).map((node) => node.anchorId),
  ["db-a", "db-b"],
);
assert.deepEqual(
  listMarkdownChildren(source, "db-a", options).map((node) => node.anchorId),
  ["db-a1"],
);

assert.throws(
  () => readMarkdownNode(source, "db-a"),
  /not a canonical tree node/,
  "without an explicit generic transparency declaration repo-guard must not silently ignore generated content",
);

const ordinaryText = source.replace(
  [begin, "> generated metadata before heading", end].join("\n"),
  "ordinary non-owned text",
);
assert.throws(
  () => readMarkdownNode(ordinaryText, "db-a", options),
  /not a canonical tree node/,
  "ordinary authored text between anchor and heading must remain structurally significant",
);

const malformed = source.replace(end, "");
assert.throws(
  () => readMarkdownNode(malformed, "db-a", options),
  /malformed owned block|owned block.*start=1.*end=0/i,
  "declared transparent block structure must fail closed when malformed",
);

const wrongTokens = {
  transparentOwnedBlocks: [{
    blockId: "metadata-A",
    beginMarker: "<!-- wrong begin -->",
    endMarker: "<!-- wrong end -->",
  }],
};
assert.throws(
  () => readMarkdownNode(source, "db-a", wrongTokens),
  /not a canonical tree node/,
  "consumer-specific marker mapping stays outside repo-guard and must match exact tokens",
);

const nestedFenceSource = [
  '<a id="node"></a>',
  "~~~md",
  begin,
  "> fake metadata",
  end,
  "~~~",
  "## Heading",
].join("\n");
const fenced = readMarkdownNode(nestedFenceSource, "node", options);
assert.equal(
  fenced.heading.text,
  "Heading",
  "owned-block tokens inside fenced code must not become structural metadata",
);

console.log("anum_docs MDDB external differential fixture passed.");
