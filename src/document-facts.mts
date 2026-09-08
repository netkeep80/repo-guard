import { parseDocument } from "yaml";
import type { DiffFileStatus, ParsedDiffFile } from "./diff/parser.mjs";
import { selectPaths } from "./diff/classification.mjs";
import { readRepositoryTextFile } from "./utils/repository-files.mjs";
import { uniqueSorted } from "./utils/collections.mjs";
import { matchesAny, normalizePathEntry } from "./utils/path-patterns.mjs";

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

export type DocumentProjection = "value" | "array_items" | "object_values" | "object_keys";
export type DocumentFactType = "scalar" | "string" | "boolean" | "string_set" | "repository_path" | "repository_path_set";
export type DocumentScalar = string | number | boolean | null;
export type NormalizedDocumentFact = DocumentScalar | string[];
export type FactSnapshot = "state" | "base" | "head";
export type FactFormat = "json" | "yaml" | "plain_text";
export type FactSource = "document" | "diff" | "repository" | "change_intent";
export type DiffFactSelector =
  | {
      kind: "changed_paths";
      patterns: readonly string[];
      mode?: "matching" | "outside";
      exclude_statuses?: readonly DiffFileStatus[];
    }
  | {
      kind: "metric";
      metric: "new_docs" | "new_files" | "net_added_lines";
      exclude_paths?: readonly string[];
    };
export type RepositoryFactSelector = {
  kind: "anchor_values";
  anchor_type: string;
};
export type ChangeIntentFactSelector = {
  pointer: string;
  projection?: DocumentProjection;
};
export type DocumentFactErrorCode =
  | "malformed_pointer"
  | "missing_pointer_segment"
  | "projection_type_mismatch"
  | "fact_type_mismatch"
  | "invalid_repository_path"
  | "document_read_error"
  | "unsupported_document_type";

export type FactRef =
  | {
      source: "document";
      selector: { path: string; format: FactFormat; snapshot: FactSnapshot; pointer: string; projection?: DocumentProjection };
      type: DocumentFactType;
    }
  | { source: "diff"; selector: DiffFactSelector; type: DocumentFactType }
  | { source: "repository"; selector: RepositoryFactSelector; type: "string_set" }
  | { source: "change_intent"; selector: ChangeIntentFactSelector; type: DocumentFactType };

type DocumentRef = Extract<FactRef, { source: "document" }>;
type DocumentSelector = DocumentRef["selector"];

interface AnchorFactInputInstance {
  value?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
}

export interface AnchorFactInstance {
  value: string;
  file: string;
  line?: number;
  column?: number;
}

export interface AnchorFactProvenance {
  kind: "anchor_instances";
  anchor_type: string;
  instances: AnchorFactInstance[];
}

export interface FactReadContext {
  documents?: DocumentReader;
  baseRef?: string | null;
  headRef?: string | null;
  readFileAtRef?: (ref: string, filePath: string) => unknown;
  diff?: { files?: { checked?: ParsedDiffFile[] } };
  anchors?: { byType?: Record<string, AnchorFactInputInstance[]> };
  changeIntent?: unknown;
}

export interface DocumentFactError {
  code: DocumentFactErrorCode;
  pointer: string;
  segment?: string;
  message: string;
}

export type DocumentFactResult =
  | { ok: true; value: NormalizedDocumentFact; provenance?: AnchorFactProvenance }
  | { ok: false; error: DocumentFactError };

export class DocumentFactFailure extends Error implements DocumentFactError {
  readonly code: DocumentFactErrorCode;
  readonly pointer: string;
  readonly segment?: string;

  constructor(code: DocumentFactErrorCode, message: string, pointer = "", segment?: string) {
    super(message);
    this.name = "DocumentFactFailure";
    this.code = code;
    this.pointer = pointer;
    this.segment = segment;
  }
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

function failDocumentFact(code: DocumentFactErrorCode, message: string, pointer = "", segment?: string): never {
  throw new DocumentFactFailure(code, message, pointer, segment);
}

function documentFactError(error: unknown, pointer: string): DocumentFactError {
  if (error instanceof DocumentFactFailure) {
    return { code: error.code, pointer: error.pointer, ...(error.segment === undefined ? {} : { segment: error.segment }), message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "document_read_error", pointer, message: collapseMessage(message) || "document read failed" };
}

export function parseYaml(content: string): unknown {
  const doc = parseDocument(content, { prettyErrors: false });
  if (doc.errors.length) throw new Error(`invalid YAML: ${doc.errors.map((e) => collapseMessage(e.message)).join("; ")}`);
  return doc.toJSON();
}

export function parseJson(content: string): unknown {
  return JSON.parse(content);
}

function decodeJsonPointerSegment(raw: string, pointer: string): string {
  if (/~(?:[^01]|$)/.test(raw)) failDocumentFact("malformed_pointer", `invalid json_pointer "${pointer}"`, pointer);
  return raw.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function resolveJsonPointer(data: unknown, pointer: string): unknown {
  if (pointer === "") return data;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    const rendered = typeof pointer === "string" ? pointer : String(pointer ?? "");
    failDocumentFact("malformed_pointer", `invalid json_pointer "${rendered}"`, rendered);
  }
  let current: unknown = data;
  for (const raw of pointer.slice(1).split("/")) {
    const part = decodeJsonPointerSegment(raw, pointer);
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) {
      failDocumentFact("missing_pointer_segment", `json_pointer "${pointer}" does not exist`, pointer, part);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function projectDocumentValue(data: unknown, pointer: string): unknown;
export function projectDocumentValue(data: unknown, pointer: string, projection: "value"): unknown;
export function projectDocumentValue(data: unknown, pointer: string, projection: "array_items" | "object_values" | "object_keys"): unknown[];
export function projectDocumentValue(data: unknown, pointer: string, projection: DocumentProjection): unknown | unknown[];
export function projectDocumentValue(data: unknown, pointer: string, projection: DocumentProjection = "value"): unknown | unknown[] {
  const selected = resolveJsonPointer(data, pointer);
  if (projection === "value") return selected;
  if (projection === "array_items") {
    if (!Array.isArray(selected)) {
      failDocumentFact("projection_type_mismatch", `document projection "array_items" requires an array at json_pointer "${pointer}"`, pointer);
    }
    return [...selected];
  }
  if (projection === "object_values") {
    if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
      failDocumentFact("projection_type_mismatch", `document projection "object_values" requires an object at json_pointer "${pointer}"`, pointer);
    }
    return Object.values(selected as Record<string, unknown>);
  }
  if (projection === "object_keys") {
    if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
      failDocumentFact("projection_type_mismatch", `document projection "object_keys" requires an object at json_pointer "${pointer}"`, pointer);
    }
    return Object.keys(selected as Record<string, unknown>);
  }
  const exhaustive: never = projection;
  return failDocumentFact("projection_type_mismatch", `unsupported document projection "${String(exhaustive)}"`, pointer);
}

function normalizeRepositoryPathFact(value: unknown, pointer = ""): string {
  if (typeof value !== "string") failDocumentFact("fact_type_mismatch", "document fact repository_path requires a string", pointer);
  const normalized = normalizePathEntry(value);
  const parts = normalized.split("/");
  if (
    !normalized
    || normalized.includes("\\")
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
    || parts.some((part) => !part || part === "." || part === "..")
  ) {
    failDocumentFact("invalid_repository_path", `invalid repository_path "${value}"`, pointer);
  }
  return normalized;
}

function normalizeStringSet(value: unknown, itemType: "string" | "repository_path", pointer = ""): string[] {
  if (!Array.isArray(value)) {
    failDocumentFact("fact_type_mismatch", `document fact ${itemType === "string" ? "string_set" : "repository_path_set"} requires a collection`, pointer);
  }
  const normalized = value.map((item) => {
    if (itemType === "repository_path") return normalizeRepositoryPathFact(item, pointer);
    if (typeof item !== "string") failDocumentFact("fact_type_mismatch", "document fact string_set requires string items", pointer);
    return item;
  });
  return uniqueSorted(normalized);
}

export function normalizeDocumentFact(value: unknown, type: "scalar", pointer?: string): DocumentScalar;
export function normalizeDocumentFact(value: unknown, type: "string", pointer?: string): string;
export function normalizeDocumentFact(value: unknown, type: "boolean", pointer?: string): boolean;
export function normalizeDocumentFact(value: unknown, type: "string_set" | "repository_path_set", pointer?: string): string[];
export function normalizeDocumentFact(value: unknown, type: "repository_path", pointer?: string): string;
export function normalizeDocumentFact(value: unknown, type: DocumentFactType, pointer?: string): NormalizedDocumentFact;
export function normalizeDocumentFact(value: unknown, type: DocumentFactType, pointer = ""): NormalizedDocumentFact {
  if (type === "scalar") {
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value as DocumentScalar;
    return failDocumentFact("fact_type_mismatch", "document fact scalar requires a JSON scalar", pointer);
  }
  if (type === "string") {
    if (typeof value === "string") return value;
    return failDocumentFact("fact_type_mismatch", "document fact string requires a string", pointer);
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    return failDocumentFact("fact_type_mismatch", "document fact boolean requires a boolean", pointer);
  }
  if (type === "string_set") return normalizeStringSet(value, "string", pointer);
  if (type === "repository_path") return normalizeRepositoryPathFact(value, pointer);
  if (type === "repository_path_set") return normalizeStringSet(value, "repository_path", pointer);
  const exhaustive: never = type;
  return failDocumentFact("fact_type_mismatch", `unsupported document fact type "${String(exhaustive)}"`, pointer);
}

function factPointer(ref: FactRef): string {
  return ref.source === "document" || ref.source === "change_intent" ? ref.selector.pointer : "";
}

function documentSelector(ref: FactRef): DocumentSelector {
  if (ref.source !== "document") failDocumentFact("document_read_error", "document fact requires document source");
  return ref.selector;
}

function structuredFactSource(reader: DocumentReader, selector: DocumentSelector): unknown {
  const path = normalizeRepositoryPathFact(selector.path, selector.pointer);
  if (selector.format === "json") return reader.json(path);
  if (selector.format === "yaml") return reader.yaml(path);
  if (selector.format === "plain_text") {
    if (selector.pointer !== "" || (selector.projection !== undefined && selector.projection !== "value")) {
      return failDocumentFact("projection_type_mismatch", "plain_text fact requires the root value selector", selector.pointer);
    }
    return reader.text(path).trim();
  }
  const exhaustive: never = selector.format;
  return failDocumentFact("unsupported_document_type", `unsupported document type for "${String(exhaustive)}"`, selector.pointer);
}

function snapshotFactSource(context: FactReadContext, selector: DocumentSelector): unknown {
  const label = selector.snapshot === "base" ? "BASE" : "HEAD";
  const revision = selector.snapshot === "base" ? context.baseRef : context.headRef;
  const path = normalizeRepositoryPathFact(selector.path, selector.pointer);
  if (!revision) return failDocumentFact("document_read_error", `missing ${label} ref`, selector.pointer);
  if (!context.readFileAtRef) return failDocumentFact("document_read_error", `snapshot reader unavailable for ${label}`, selector.pointer);
  let raw: unknown;
  try {
    raw = context.readFileAtRef(revision, path);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return failDocumentFact("document_read_error", `${label} read failed: ${collapseMessage(message)}`, selector.pointer);
  }
  if (raw === null || raw === undefined) return failDocumentFact("document_read_error", `missing ${label} file`, selector.pointer);
  if (selector.format === "plain_text") {
    if (selector.pointer !== "" || (selector.projection !== undefined && selector.projection !== "value")) {
      return failDocumentFact("projection_type_mismatch", "plain_text fact requires the root value selector", selector.pointer);
    }
    return String(raw).trim();
  }
  if (selector.format === "json") return parseJson(String(raw));
  if (selector.format === "yaml") return parseYaml(String(raw));
  const exhaustive: never = selector.format;
  return failDocumentFact("unsupported_document_type", `unsupported document type for "${String(exhaustive)}"`, selector.pointer);
}

function diffFactSource(context: FactReadContext, selector: DiffFactSelector): unknown {
  const files = context.diff?.files?.checked;
  if (!Array.isArray(files)) return failDocumentFact("document_read_error", "diff facts are unavailable");

  if (selector.kind === "metric") {
    const excludedPaths = new Set(selector.exclude_paths || []);
    if (selector.metric === "new_files") return files.filter((file) => file.status === "added").length;
    if (selector.metric === "new_docs") {
      return files.filter((file) => file.status === "added" && /\.md$/i.test(file.path) && !excludedPaths.has(file.path)).length;
    }
    return files.reduce((sum, file) => sum + (file.addedLines?.length || 0) - (file.deletedLines?.length || 0), 0);
  }

  const patterns = [...selector.patterns];
  const excluded = new Set(selector.exclude_statuses || []);
  const candidates = files.filter((file) => !excluded.has(file.status));
  const paths = selector.mode === "outside"
    ? uniqueSorted(candidates.filter((file) => !matchesAny(file.path, patterns)).map((file) => file.path))
    : selectPaths(candidates, patterns);
  return paths;
}

function anchorFactInstance(instance: AnchorFactInputInstance): AnchorFactInstance {
  if (typeof instance.value !== "string") failDocumentFact("fact_type_mismatch", "repository anchor fact requires string values");
  if (typeof instance.file !== "string") failDocumentFact("fact_type_mismatch", "repository anchor fact requires source files");
  return {
    value: instance.value,
    file: instance.file,
    ...(typeof instance.line === "number" ? { line: instance.line } : {}),
    ...(typeof instance.column === "number" ? { column: instance.column } : {}),
  };
}

function compareAnchorFactInstances(left: AnchorFactInstance, right: AnchorFactInstance): number {
  return left.file.localeCompare(right.file)
    || (left.line || 0) - (right.line || 0)
    || (left.column || 0) - (right.column || 0)
    || left.value.localeCompare(right.value);
}

function repositoryFact(context: FactReadContext, ref: Extract<FactRef, { source: "repository" }>): DocumentFactResult {
  const byType = context.anchors?.byType;
  if (!byType) return failDocumentFact("document_read_error", "repository anchor facts are unavailable");
  const instances = (byType[ref.selector.anchor_type] || []).map(anchorFactInstance).sort(compareAnchorFactInstances);
  return {
    ok: true,
    value: normalizeDocumentFact(instances.map((instance) => instance.value), ref.type),
    provenance: { kind: "anchor_instances", anchor_type: ref.selector.anchor_type, instances },
  };
}

function changeIntentFactSource(context: FactReadContext, ref: Extract<FactRef, { source: "change_intent" }>): unknown {
  const projection = ref.selector.projection ?? "value";
  try {
    return projectDocumentValue(context.changeIntent ?? {}, ref.selector.pointer, projection);
  } catch (error) {
    if (error instanceof DocumentFactFailure && error.code === "missing_pointer_segment" && projection !== "value") return [];
    throw error;
  }
}

export function readFact(context: FactReadContext, ref: FactRef): DocumentFactResult {
  const pointer = factPointer(ref);
  try {
    if (ref.source === "diff") {
      return { ok: true, value: normalizeDocumentFact(diffFactSource(context, ref.selector), ref.type, pointer) };
    }
    if (ref.source === "repository") return repositoryFact(context, ref);
    if (ref.source === "change_intent") {
      return { ok: true, value: normalizeDocumentFact(changeIntentFactSource(context, ref), ref.type, pointer) };
    }
    const selector = documentSelector(ref);
    const source = selector.snapshot === "state"
      ? context.documents ? structuredFactSource(context.documents, selector) : failDocumentFact("document_read_error", "document reader is unavailable", selector.pointer)
      : selector.snapshot === "base" || selector.snapshot === "head"
        ? snapshotFactSource(context, selector)
        : failDocumentFact("document_read_error", `unsupported fact snapshot "${String((selector as { snapshot?: unknown }).snapshot)}"`, selector.pointer);
    const projected = selector.format === "plain_text" ? source : projectDocumentValue(source, selector.pointer, selector.projection ?? "value");
    return { ok: true, value: normalizeDocumentFact(projected, ref.type, selector.pointer) };
  } catch (error: unknown) {
    return { ok: false, error: documentFactError(error, pointer) };
  }
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
  const cached = <T,>(kind: DocumentKind, path: string, parser: (content: string) => T): T => {
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