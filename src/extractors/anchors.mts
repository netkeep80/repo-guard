import type { ParsedDiffFile } from "../diff/parser.mjs";
import type { DocumentReader, DocumentReaderOptions } from "../document-facts.mjs";
import { parseJson } from "../document-facts.mjs";
import { uniqueSorted } from "../utils/collections.mjs";
import { matchesAny } from "../utils/path-patterns.mjs";
import { readRepositoryTextFile } from "../utils/repository-files.mjs";

export interface AnchorSource {
  kind: string;
  glob: string;
  pattern?: string;
  field?: string;
}

export interface AnchorTypeConfig {
  sources?: readonly AnchorSource[];
}

export interface AnchorPolicyProjection {
  anchors?: { types?: Readonly<Record<string, AnchorTypeConfig>> } | null;
}

export interface AnchorExtractionOptions extends DocumentReaderOptions {
  changedFiles?: readonly ParsedDiffFile[];
  trackedFiles?: readonly string[];
  documents?: Pick<DocumentReader, "text"> | null;
}

export interface AnchorInstance {
  anchorType: string;
  value: string;
  file: string;
  sourceKind: string;
  raw: string;
  line?: number;
  column?: number;
  captureGroup?: number;
}

export interface AnchorExtractionError {
  anchorType: string;
  sourceKind: string;
  sourceIndex: number;
  file: string;
  message: string;
}

export interface AnchorExtraction {
  instances: AnchorInstance[];
  byType: Record<string, AnchorInstance[]>;
  errors: AnchorExtractionError[];
}

function candidateAnchorFiles(options: AnchorExtractionOptions): string[] {
  const changed = (options.changedFiles || []).filter((file) => file.status !== "deleted").map((file) => file.path);
  return uniqueSorted([...(options.trackedFiles || []), ...changed].filter(Boolean));
}

function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  return starts;
}

function positionAt(starts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  const lineIndex = Math.max(0, high);
  return { line: lineIndex + 1, column: index - starts[lineIndex] + 1 };
}

function makeRegex(pattern: string): RegExp {
  const compiled = new RegExp(pattern);
  let flags = compiled.flags;
  for (const flag of ["g", "d"]) if (!flags.includes(flag)) flags += flag;
  return new RegExp(compiled.source, flags);
}

function extractRegexAnchors(anchorType: string, source: AnchorSource, file: string, content: string): AnchorInstance[] {
  const instances: AnchorInstance[] = [];
  const starts = buildLineStarts(content);
  for (const match of content.matchAll(makeRegex(source.pattern as string))) {
    let captureGroup = null;
    for (let i = 1; i < match.length; i++) if (match[i] !== undefined) { captureGroup = i; break; }
    const value = captureGroup ? match[captureGroup] : match[0];
    const index = captureGroup && match.indices?.[captureGroup] ? match.indices[captureGroup][0] : match.index!;
    const position = positionAt(starts, index);
    const instance: AnchorInstance = { anchorType, value: String(value), file, sourceKind: "regex", ...position, raw: match[0] };
    if (captureGroup) instance.captureGroup = captureGroup;
    instances.push(instance);
  }
  return instances;
}

function extractJsonFieldAnchor(anchorType: string, source: AnchorSource, file: string, content: string): AnchorInstance[] {
  let data: unknown;
  try {
    data = parseJson(content);
  } catch (error) {
    throw new Error(`invalid JSON: ${(error as Error).message}`);
  }
  if (data === null || Array.isArray(data) || typeof data !== "object") throw new Error("json_field extractor requires a top-level JSON object");
  if (!Object.hasOwn(data, source.field as string)) throw new Error(`field "${source.field}" not found`);
  const value = (data as Record<string, unknown>)[source.field as string];
  if (value === null || typeof value === "object") throw new Error(`field "${source.field}" must be a string, number, or boolean`);
  return [{ anchorType, value: String(value), file, sourceKind: "json_field", raw: String(value) }];
}

function compareInstances(a: AnchorInstance, b: AnchorInstance): number {
  return a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0) || (a.column || 0) - (b.column || 0) ||
    a.anchorType.localeCompare(b.anchorType) || a.value.localeCompare(b.value);
}

export function extractAnchors(policy: AnchorPolicyProjection, options: AnchorExtractionOptions = {}): AnchorExtraction {
  const anchorTypes = policy.anchors?.types || {};
  const files = candidateAnchorFiles(options);
  const instances: AnchorInstance[] = [];
  const errors: AnchorExtractionError[] = [];
  const text = (file: string): string => options.documents?.text(file) ?? readRepositoryTextFile(file, options);
  for (const [anchorType, config] of Object.entries(anchorTypes)) {
    for (const [sourceIndex, source] of (config.sources || []).entries()) {
      for (const file of files.filter((path) => matchesAny(path, [source.glob]))) {
        try {
          const content = text(file);
          if (source.kind === "regex") instances.push(...extractRegexAnchors(anchorType, source, file, content));
          else if (source.kind === "json_field") instances.push(...extractJsonFieldAnchor(anchorType, source, file, content));
          else throw new Error(`unsupported anchor source kind "${source.kind}"`);
        } catch (error) {
          errors.push({ anchorType, sourceKind: source.kind, sourceIndex, file, message: (error as Error).message });
        }
      }
    }
  }
  instances.sort(compareInstances);
  errors.sort((a, b) => (a.file || "").localeCompare(b.file || "") || a.anchorType.localeCompare(b.anchorType) || a.sourceIndex - b.sourceIndex || a.message.localeCompare(b.message));
  const byType: Record<string, AnchorInstance[]> = Object.fromEntries(Object.keys(anchorTypes).sort().map((type) => [type, []]));
  for (const instance of instances) (byType[instance.anchorType] ||= []).push(instance);
  return { instances, byType, errors };
}

export function formatAnchorExtractionError(error: AnchorExtractionError): string {
  return `[${error.anchorType} ${error.sourceKind} source ${error.sourceIndex}] ${error.file ? `${error.file}: ` : ""}${error.message}`;
}

export function checkAnchorExtraction(anchorExtraction: Pick<AnchorExtraction, "errors"> | null | undefined) {
  const errors = anchorExtraction?.errors || [];
  return { ok: errors.length === 0, message: errors.length ? "anchor extraction failed" : undefined, errors: errors.map(formatAnchorExtractionError) };
}
