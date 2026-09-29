import assert from "node:assert/strict";
import { listMarkdownSections } from "../dist/markdown-structure.mjs";

const begin = "<!-- consumer:metadata:A:begin -->";
const end = "<!-- consumer:metadata:A:end -->";
const options = {
  transparentOwnedBlocks: [{
    blockId: "metadata-A",
    beginMarker: begin,
    endMarker: end,
  }],
};

const source = [
  "# Unanchored top",
  "Intro.",
  "",
  '<a id="root"></a>',
  "# Root",
  "Root body.",
  "",
  '<a id="a"></a>',
  begin,
  "> generated metadata before heading",
  end,
  "## A",
  "A body.",
  "",
  "### A child without anchor",
  "Child body.",
  "",
  '<a id="b"></a>',
  "## B",
  "B body.",
  "",
  "~~~md",
  "## Fake fenced heading",
  "~~~",
].join("\n");

const sections = listMarkdownSections(source, options);
assert.deepEqual(
  sections.map((section) => ({
    line: section.diagnosticLine,
    level: section.heading.level,
    text: section.heading.text,
    anchorId: section.anchorId,
  })),
  [
    { line: 1, level: 1, text: "Unanchored top", anchorId: null },
    { line: 5, level: 1, text: "Root", anchorId: "root" },
    { line: 12, level: 2, text: "A", anchorId: "a" },
    { line: 15, level: 3, text: "A child without anchor", anchorId: null },
    { line: 19, level: 2, text: "B", anchorId: "b" },
  ],
  "sections must include every real heading and attach canonical stable anchors when present",
);

const [intro, root, a, child, b] = sections;

assert.equal(intro.start, 0);
assert.equal(intro.content, source.slice(intro.start, intro.end));
assert.equal(root.content, source.slice(root.start, root.end));
assert.equal(a.content, source.slice(a.start, a.end));
assert.equal(child.content, source.slice(child.start, child.end));
assert.equal(b.content, source.slice(b.start, b.end));

assert.ok(root.content.includes("### A child without anchor"));
assert.ok(!a.content.includes('<a id="b"></a>'));
assert.ok(a.content.startsWith('<a id="a"></a>'));
assert.ok(a.content.includes("generated metadata before heading"));
assert.ok(child.content.startsWith("### A child without anchor"));
assert.ok(b.content.includes("~~~md"));
assert.ok(!sections.some((section) => section.heading.text === "Fake fenced heading"));

assert.deepEqual(
  a.headingPath.map((heading) => [heading.level, heading.text]),
  [[1, "Root"], [2, "A"]],
);
assert.deepEqual(
  child.headingPath.map((heading) => [heading.level, heading.text]),
  [[1, "Root"], [2, "A"], [3, "A child without anchor"]],
);

const strictSections = listMarkdownSections(source);
assert.equal(
  strictSections.find((section) => section.heading.text === "A")?.anchorId,
  null,
  "without explicit transparency the heading still exists as a section but the separated anchor must not silently own it",
);

const ambiguous = [
  '<a id="first"></a><a id="second"></a>',
  "## Shared heading",
].join("\n");
assert.throws(
  () => listMarkdownSections(ambiguous),
  /multiple canonical node anchors|multiple.*anchors/i,
  "multiple canonical anchors for one heading must fail closed",
);

console.log("anum_docs Markdown section differential fixture passed.");
