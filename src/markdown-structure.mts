import { parseMarkdown, type MarkdownDocument, type MarkdownHeading } from "./markdown-parser.mjs";

export type MarkdownDocumentMode = "source" | "hybrid" | "generated";

export interface MarkdownAddress {
  anchorId: string;
  line: number;
  offset: number;
  headingPath: MarkdownHeading[];
}

export interface MarkdownNode {
  anchorId: string;
  anchorLine: number;
  headingLine: number;
  heading: MarkdownHeading;
  headingPath: MarkdownHeading[];
  start: number;
  end: number;
  subtree: string;
}

export interface MarkdownSection {
  diagnosticLine: number;
  heading: MarkdownHeading;
  headingPath: MarkdownHeading[];
  anchorId: string | null;
  start: number;
  end: number;
  content: string;
}

export interface MarkdownChildSpec {
  anchorId: string;
  title: string;
  payload?: string;
}

export interface MarkdownOwnedBlockSpec {
  blockId: string;
  beginMarker: string;
  endMarker: string;
}

export interface MarkdownStructureOptions {
  transparentOwnedBlocks?: readonly MarkdownOwnedBlockSpec[];
}

export interface MarkdownOwnedBlock {
  blockId: string;
  start: number;
  end: number;
  content: string;
}

export interface MarkdownStructureOptions {
  transparentOwnedBlocks?: readonly MarkdownOwnedBlockSpec[];
}

interface MarkdownIndexedLine {
  line: number;
  start: number;
  end: number;
  text: string;
}

interface MarkdownAnchorEntry {
  anchorId: string;
  line: number;
  start: number;
}

interface MarkdownStructureContext {
  source: string;
  markdown: MarkdownDocument;
  lines: MarkdownIndexedLine[];
  visibleLines: Set<number>;
  anchors: MarkdownAnchorEntry[];
}

function failMarkdownStructure(message: string): never {
  throw new Error(`markdown structural model: ${message}`);
}

function assertSafeMarkdownId(value: string, name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) {
    failMarkdownStructure(`${name} must be a stable ASCII identifier: ${value}`);
  }
}

function indexedMarkdownLines(source: string, markdown: MarkdownDocument): MarkdownIndexedLine[] {
  const result: MarkdownIndexedLine[] = [];
  let offset = 0;
  for (let index = 0; index < markdown.lines.length; index++) {
    const newline = source.indexOf("\n", offset);
    const rawEnd = newline < 0 ? source.length : newline;
    const contentEnd = rawEnd > offset && source[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    const end = newline < 0 ? source.length : newline + 1;
    result.push({ line: index + 1, start: offset, end, text: source.slice(offset, contentEnd) });
    offset = end;
  }
  return result;
}

function markdownStructure(source: string): MarkdownStructureContext {
  const markdown = parseMarkdown(source);
  if (markdown.errors.length) {
    failMarkdownStructure(markdown.errors.map((error) => error.message).join("; "));
  }
  const lines = indexedMarkdownLines(source, markdown);
  const visibleLines = new Set(markdown.proseLines.map((line) => line.line));
  const anchors: MarkdownAnchorEntry[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\s+id=["']([^"']+)["']\s*><\/a>/gi;
  for (const line of lines) {
    if (!visibleLines.has(line.line)) continue;
    for (const match of line.text.matchAll(anchorPattern)) {
      const anchorId = match[1]!;
      assertSafeMarkdownId(anchorId, "anchorId");
      if (seen.has(anchorId)) failMarkdownStructure(`anchor is duplicated: ${anchorId}`);
      seen.add(anchorId);
      anchors.push({ anchorId, line: line.line, start: line.start });
    }
  }
  return { source, markdown, lines, visibleLines, anchors };
}

function headingPathAt(markdown: MarkdownDocument, targetLine: number): MarkdownHeading[] {
  const stack: MarkdownHeading[] = [];
  for (const heading of markdown.headings) {
    if (heading.line > targetLine) break;
    while (stack.length && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    stack.push(heading);
  }
  return [...stack];
}

function anchorIn(context: MarkdownStructureContext, anchorId: string): MarkdownAddress {
  assertSafeMarkdownId(anchorId, "anchorId");
  const anchor = context.anchors.find((candidate) => candidate.anchorId === anchorId);
  if (!anchor) failMarkdownStructure(`anchor not found: ${anchorId}`);
  return {
    anchorId,
    line: anchor.line,
    offset: anchor.start,
    headingPath: headingPathAt(context.markdown, anchor.line),
  };
}

function transparentLines(
  context: MarkdownStructureContext,
  options: MarkdownStructureOptions,
): Set<number> {
  const result = new Set<number>();
  for (const block of options.transparentOwnedBlocks ?? []) {
    const owned = ownedBlockIn(context, block);
    if (!owned) continue;
    for (const line of context.lines) {
      if (line.start >= owned.start && line.start < owned.end) result.add(line.line);
    }
  }
  return result;
}

function headingAfterAnchor(
  context: MarkdownStructureContext,
  anchorLine: number,
  options: MarkdownStructureOptions = {},
): MarkdownHeading | null {
  const headings = new Map(context.markdown.headings.map((heading) => [heading.line, heading]));
  const transparent = transparentLines(context, options);
  for (const prose of context.markdown.proseLines) {
    if (prose.line <= anchorLine || transparent.has(prose.line)) continue;
    const trimmed = prose.text.trim();
    if (!trimmed || /^<!--.*-->$/.test(trimmed)) continue;
    return headings.get(prose.line) ?? null;
  }
  return null;
}

function lineAt(context: MarkdownStructureContext, line: number): MarkdownIndexedLine {
  const indexed = context.lines[line - 1];
  if (!indexed) failMarkdownStructure(`line ${line} is unavailable`);
  return indexed;
}

function nodeIn(
  context: MarkdownStructureContext,
  anchorId: string,
  options: MarkdownStructureOptions = {},
): MarkdownNode | null {
  const anchor = anchorIn(context, anchorId);
  const heading = headingAfterAnchor(context, anchor.line, options);
  if (!heading) return null;

  const owningAnchors = context.anchors.filter(
    (candidate) =>
      candidate.line < heading.line
      && headingAfterAnchor(context, candidate.line, options)?.line === heading.line,
  );
  if (owningAnchors.length > 1) {
    failMarkdownStructure(`heading at line ${heading.line} has multiple node anchors`);
  }

  const nextHeading = context.markdown.headings.find(
    (candidate) => candidate.line > heading.line && candidate.level <= heading.level,
  );
  let end = context.source.length;
  if (nextHeading) {
    const owningAnchors = context.anchors.filter((candidate) => {
      if (candidate.line >= nextHeading.line) return false;
      return headingAfterAnchor(context, candidate.line, options)?.line === nextHeading.line;
    });
    if (owningAnchors.length > 1) {
      failMarkdownStructure(`heading at line ${nextHeading.line} has multiple node anchors`);
    }
    end = owningAnchors[0]?.start ?? lineAt(context, nextHeading.line).start;
  }

  return {
    anchorId,
    anchorLine: anchor.line,
    headingLine: heading.line,
    heading,
    headingPath: headingPathAt(context.markdown, heading.line),
    start: anchor.offset,
    end,
    subtree: context.source.slice(anchor.offset, end),
  };
}

export function resolveMarkdownAnchor(source: string, anchorId: string): MarkdownAddress {
  return anchorIn(markdownStructure(source), anchorId);
}

export function listMarkdownAnchorIds(source: string): string[] {
  return markdownStructure(source).anchors.map((anchor) => anchor.anchorId);
}

export function readMarkdownNode(
  source: string,
  anchorId: string,
  options: MarkdownStructureOptions = {},
): MarkdownNode {
  const node = nodeIn(markdownStructure(source), anchorId, options);
  if (!node) failMarkdownStructure(`${anchorId}: anchor is not a canonical tree node`);
  return node;
}

export function listMarkdownChildren(
  source: string,
  parentAnchorId: string,
  options: MarkdownStructureOptions = {},
): MarkdownNode[] {
  const context = markdownStructure(source);
  const parent = nodeIn(context, parentAnchorId, options);
  if (!parent) failMarkdownStructure(`${parentAnchorId}: anchor is not a canonical tree node`);
  return context.anchors
    .map((anchor) => nodeIn(context, anchor.anchorId, options))
    .filter((node): node is MarkdownNode =>
      node !== null
      && node.anchorId !== parent.anchorId
      && node.start > parent.start
      && node.start < parent.end
      && node.heading.level === parent.heading.level + 1)
    .sort((left, right) => left.start - right.start);
}

export function listMarkdownSections(
  source: string,
  options: MarkdownStructureOptions = {},
): MarkdownSection[] {
  const context = markdownStructure(source);
  const nodesByHeadingLine = new Map<number, MarkdownNode>();

  for (const anchor of context.anchors) {
    const node = nodeIn(context, anchor.anchorId, options);
    if (!node) continue;
    if (nodesByHeadingLine.has(node.headingLine)) {
      failMarkdownStructure(
        `heading at line ${node.headingLine} has multiple canonical node anchors`,
      );
    }
    nodesByHeadingLine.set(node.headingLine, node);
  }

  return context.markdown.headings.map((heading, index) => {
    const node = nodesByHeadingLine.get(heading.line);
    const next = context.markdown.headings.slice(index + 1).find(
      (candidate) => candidate.level <= heading.level,
    );
    const start = node?.start ?? lineAt(context, heading.line).start;
    const end = next
      ? (nodesByHeadingLine.get(next.line)?.start ?? lineAt(context, next.line).start)
      : source.length;

    return {
      diagnosticLine: heading.line,
      heading,
      headingPath: headingPathAt(context.markdown, heading.line),
      anchorId: node?.anchorId ?? null,
      start,
      end,
      content: source.slice(start, end),
    };
  });
}

function validateMarkdownChild(child: MarkdownChildSpec): void {
  assertSafeMarkdownId(child.anchorId, "child.anchorId");
  if (!child.title.trim() || /[\r\n]/.test(child.title)) {
    failMarkdownStructure("child title must be one non-empty line");
  }
  const payload = child.payload ?? "";
  if (/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/m.test(payload) || /<a\s+id=["']/i.test(payload)) {
    failMarkdownStructure("child payload cannot contain headings or stable anchors");
  }
}

function markdownNewline(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

export function insertMarkdownChild(args: {
  source: string;
  mode: MarkdownDocumentMode;
  parentAnchorId: string;
  child: MarkdownChildSpec;
}): string {
  const { source, mode, parentAnchorId, child } = args;
  if (mode === "source") failMarkdownStructure(`${parentAnchorId}: SOURCE document is read-only`);
  if (mode === "generated") failMarkdownStructure(`${parentAnchorId}: whole-file GENERATED mode is not supported`);
  validateMarkdownChild(child);

  const context = markdownStructure(source);
  if (context.anchors.some((anchor) => anchor.anchorId === child.anchorId)) {
    failMarkdownStructure(`anchor is duplicated: ${child.anchorId}`);
  }
  const parent = nodeIn(context, parentAnchorId);
  if (!parent) failMarkdownStructure(`${parentAnchorId}: anchor is not a canonical tree node`);
  if (parent.heading.level >= 6) {
    failMarkdownStructure(`${parentAnchorId}: heading level 6 cannot have a Markdown child`);
  }

  const newline = markdownNewline(source);
  const payload = child.payload?.trimEnd();
  const block = [
    `<a id="${child.anchorId}"></a>`,
    `${"#".repeat(parent.heading.level + 1)} ${child.title.trim()}`,
    ...(payload ? [payload] : []),
  ].join(newline);
  const prefix = parent.end > 0 && !source.slice(0, parent.end).endsWith("\n") ? newline : "";
  const inserted = `${prefix}${block}${newline}${newline}`;
  const updated = source.slice(0, parent.end) + inserted + source.slice(parent.end);

  if (
    updated.slice(0, parent.end) !== source.slice(0, parent.end)
    || updated.slice(parent.end + inserted.length) !== source.slice(parent.end)
  ) {
    failMarkdownStructure("insert child modified bytes outside insertion point");
  }

  const updatedContext = markdownStructure(updated);
  for (const anchor of context.anchors) anchorIn(updatedContext, anchor.anchorId);
  const created = nodeIn(updatedContext, child.anchorId);
  if (!created || created.heading.level !== parent.heading.level + 1) {
    failMarkdownStructure("inserted child has invalid heading level");
  }
  return updated;
}

function validateOwnedBlockSpec(block: MarkdownOwnedBlockSpec): void {
  assertSafeMarkdownId(block.blockId, "blockId");
  if (!block.beginMarker || !block.endMarker || block.beginMarker === block.endMarker) {
    failMarkdownStructure(`${block.blockId}: owned block markers must be distinct non-empty tokens`);
  }
  if (/[\r\n]/.test(block.beginMarker) || /[\r\n]/.test(block.endMarker)) {
    failMarkdownStructure(`${block.blockId}: owned block markers must be single-line tokens`);
  }
}

function ownedBlockIn(
  context: MarkdownStructureContext,
  block: MarkdownOwnedBlockSpec,
): MarkdownOwnedBlock | null {
  validateOwnedBlockSpec(block);
  const begin = block.beginMarker.trim();
  const end = block.endMarker.trim();
  const starts = context.lines.filter(
    (line) => context.visibleLines.has(line.line) && line.text.trim() === begin,
  );
  const ends = context.lines.filter(
    (line) => context.visibleLines.has(line.line) && line.text.trim() === end,
  );

  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    failMarkdownStructure(
      `${block.blockId}: malformed owned block start=${starts.length} end=${ends.length}`,
    );
  }
  if (ends[0]!.line <= starts[0]!.line) {
    failMarkdownStructure(`${block.blockId}: owned block end must follow begin marker`);
  }

  return {
    blockId: block.blockId,
    start: starts[0]!.start,
    end: ends[0]!.end,
    content: context.source.slice(starts[0]!.start, ends[0]!.end),
  };
}

export function readOwnedMarkdownBlock(
  source: string,
  block: MarkdownOwnedBlockSpec,
): MarkdownOwnedBlock | null {
  return ownedBlockIn(markdownStructure(source), block);
}

export function replaceOwnedMarkdownBlock(args: {
  source: string;
  mode: MarkdownDocumentMode;
  anchorId: string;
  block: MarkdownOwnedBlockSpec;
  generatedContent: string;
}): string {
  const { source, mode, anchorId, block, generatedContent } = args;
  if (mode === "source") failMarkdownStructure(`${anchorId}: SOURCE document is read-only`);
  if (mode === "generated") failMarkdownStructure(`${anchorId}: whole-file GENERATED mode is not supported`);
  validateOwnedBlockSpec(block);

  const context = markdownStructure(source);
  const anchor = anchorIn(context, anchorId);
  const newline = markdownNewline(source);
  const generated = generatedContent.trimEnd();
  const wrapped = [block.beginMarker, generated, block.endMarker].join(newline);
  const existing = readOwnedMarkdownBlock(source, block);

  if (!existing) {
    const anchorLine = lineAt(context, anchor.line);
    const needsLeadingNewline = anchorLine.end === source.length && !source.endsWith("\n");
    const inserted = `${needsLeadingNewline ? newline : ""}${wrapped}${newline}`;
    const insertAt = anchorLine.end;
    const updated = source.slice(0, insertAt) + inserted + source.slice(insertAt);
    const created = readOwnedMarkdownBlock(updated, block);
    if (!created) failMarkdownStructure(`${block.blockId}: inserted owned block cannot be resolved`);
    return updated;
  }

  if (existing.start < anchor.offset) {
    failMarkdownStructure(`${block.blockId}: owned block precedes its anchor ${anchorId}`);
  }
  const replacement = wrapped + (existing.content.endsWith("\n") ? newline : "");
  const updated = source.slice(0, existing.start) + replacement + source.slice(existing.end);
  const beforeOutside = source.slice(0, existing.start) + source.slice(existing.end);
  const afterOutside = updated.slice(0, existing.start) + updated.slice(existing.start + replacement.length);
  if (beforeOutside !== afterOutside) {
    failMarkdownStructure(`${block.blockId}: bytes outside owned block changed`);
  }
  return updated;
}
