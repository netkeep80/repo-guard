import { parseDocument } from "yaml";
import { readRepositoryTextFile } from "./utils/repository-files.mjs";

export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

export interface MarkdownCodeBlock {
  language: string;
  infoString: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface MarkdownProseLine {
  line: number;
  text: string;
}

export interface MarkdownLink {
  target: string;
  line: number;
  column: number;
}

export interface MarkdownParseError {
  message: string;
}

export interface MarkdownDocument {
  lines: string[];
  headings: MarkdownHeading[];
  codeBlocks: MarkdownCodeBlock[];
  proseLines: MarkdownProseLine[];
  links: MarkdownLink[];
  errors: MarkdownParseError[];
}

export interface MarkdownSection {
  startLine: number;
  endLine: number;
  lines: string[];
  links: MarkdownLink[];
}

export interface DocumentReaderOptions {
  repoRoot?: string;
  readFile?: (filePath: string) => unknown;
}

export interface DocumentReader {
  text(path: string): string;
  markdown(path: string): MarkdownDocument;
  json(path: string): unknown;
  yaml(path: string): unknown;
}

type DocumentKind = "markdown" | "json" | "yaml";

interface OpenMarkdownFence {
  indent: string;
  marker: string;
  length: number;
  infoString: string;
  startLine: number;
  contentLines: string[];
}

function collapseMessage(message: unknown): string {
  return String(message || "").replace(/\s+/g, " ").trim();
}

export function parseYaml(content: string): unknown {
  const doc = parseDocument(content, { prettyErrors: false });
  if (doc.errors.length) throw new Error(`invalid YAML: ${doc.errors.map((e) => collapseMessage(e.message)).join("; ")}`);
  return doc.toJSON();
}

export function parseJson(content: string): unknown {
  return JSON.parse(content);
}

export function stripMarkdownInline(line: string): string {
  return line.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "");
}

export function parseMarkdown(content: unknown): MarkdownDocument {
  const lines = String(content || "").split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  const codeBlocks: MarkdownCodeBlock[] = [];
  const proseLines: MarkdownProseLine[] = [];
  const links: MarkdownLink[] = [];
  const errors: MarkdownParseError[] = [];
  let fence: OpenMarkdownFence | null = null;

  for (const [offset, line] of lines.entries()) {
    const lineNumber = offset + 1;
    if (!fence) {
      const opening = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
      if (opening) {
        fence = {
          indent: opening[1], marker: opening[2][0], length: opening[2].length,
          infoString: opening[3].trim(), startLine: lineNumber, contentLines: [],
        };
        continue;
      }
      const heading = line.match(/^[ \t]{0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
      if (heading) {
        const text = heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
        if (text) headings.push({ level: heading[1].length, text, line: lineNumber });
      }
      for (const match of line.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        links.push({ target: match[1], line: lineNumber, column: match.index + 1 });
      }
      proseLines.push({ line: lineNumber, text: line });
      continue;
    }

    const closing = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
    if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
      const language = fence.infoString.split(/\s+/).filter(Boolean)[0] || "";
      codeBlocks.push({ language, infoString: fence.infoString, startLine: fence.startLine, endLine: lineNumber, content: fence.contentLines.join("\n") });
      fence = null;
    } else {
      fence.contentLines.push(fence.indent && line.startsWith(fence.indent) ? line.slice(fence.indent.length) : line);
    }
  }
  if (fence) errors.push({ message: `unclosed Markdown fence starting at line ${fence.startLine}` });
  return { lines, headings, codeBlocks, proseLines, links, errors };
}

export function markdownSection(markdown: MarkdownDocument, section: string): MarkdownSection {
  const heading = markdown.headings.find((item) => item.text.toLowerCase() === section.trim().toLowerCase());
  if (!heading) throw new Error(`markdown section "${section}" not found`);
  const end = markdown.headings.find((item) => item.line > heading.line && item.level <= heading.level)?.line || markdown.lines.length + 1;
  return {
    startLine: heading.line + 1, endLine: end - 1,
    lines: markdown.lines.slice(heading.line, end - 1),
    links: markdown.links.filter((link) => link.line > heading.line && link.line < end),
  };
}

export function createDocumentReader(options: DocumentReaderOptions = {}): DocumentReader {
  const textCache = new Map<string, string>();
  const parsed: Record<DocumentKind, Map<string, unknown>> = { markdown: new Map(), json: new Map(), yaml: new Map() };
  const text = (path: string): string => {
    if (!textCache.has(path)) textCache.set(path, readRepositoryTextFile(path, options));
    return textCache.get(path)!;
  };
  const cached = <T>(kind: DocumentKind, path: string, parser: (content: string) => T): T => {
    if (!parsed[kind].has(path)) parsed[kind].set(path, parser(text(path)));
    return parsed[kind].get(path) as T;
  };
  return {
    text,
    markdown: (path) => cached("markdown", path, parseMarkdown),
    json: (path) => cached("json", path, parseJson),
    yaml: (path) => cached("yaml", path, parseYaml),
  };
}
