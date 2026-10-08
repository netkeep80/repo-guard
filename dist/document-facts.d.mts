import { type MarkdownDocument, type MarkdownLink } from "./markdown-parser.mjs";
import type { DiffFileStatus, ParsedDiffFile } from "./diff/parser.mjs";
import type { ImmutableSnapshotDocumentCache } from "./immutable-snapshot-cache.mjs";
export { parseMarkdown } from "./markdown-parser.mjs";
export type { MarkdownHeading, MarkdownCodeBlock, MarkdownProseLine, MarkdownLink, MarkdownParseError, MarkdownDocument } from "./markdown-parser.mjs";
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
export interface MarkdownOwnedBlockIdentityRegion {
    kind: "markdown_owned_block";
    anchor_id: string;
    block_id: string;
    begin_marker: string;
    end_marker: string;
}
export type DiffFactSelector = {
    kind: "changed_paths";
    patterns: readonly string[];
    mode?: "matching" | "outside";
    exclude_statuses?: readonly DiffFileStatus[];
    include_previous_paths?: boolean;
} | {
    kind: "metric";
    metric: "new_docs" | "new_files" | "net_added_lines" | "net_files";
    patterns?: readonly string[];
    exclude_paths?: readonly string[];
};
export type RepositoryFactSelector = {
    kind: "anchor_values";
    anchor_type: string;
} | {
    kind: "path_metric";
    patterns: readonly string[];
    exclude_paths?: readonly string[];
    population: "tracked" | "changed";
    metric: "lines" | "bytes" | "files";
    aggregate: "max" | "sum";
} | {
    kind: "content_identity";
    path: string;
    snapshot: FactSnapshot;
    algorithm: "sha256";
    region?: MarkdownOwnedBlockIdentityRegion;
} | {
    kind: "tracked_paths";
};
export type ChangeIntentFactSelector = {
    pointer: string;
    projection?: DocumentProjection;
};
export type DocumentFactErrorCode = "malformed_pointer" | "missing_pointer_segment" | "projection_type_mismatch" | "fact_type_mismatch" | "invalid_repository_path" | "document_read_error" | "unsupported_document_type";
export type FactRef = {
    source: "document";
    selector: {
        path: string;
        format: FactFormat;
        snapshot: FactSnapshot;
        pointer: string;
        projection?: DocumentProjection;
    };
    type: DocumentFactType;
} | {
    source: "diff";
    selector: DiffFactSelector;
    type: DocumentFactType;
} | {
    source: "repository";
    selector: RepositoryFactSelector;
    type: "string_set" | "repository_path_set" | "scalar";
} | {
    source: "change_intent";
    selector: ChangeIntentFactSelector;
    type: DocumentFactType;
};
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
export interface PathMetricFactProvenance {
    kind: "path_metric";
    matched_paths: string[];
    measurements: Array<{
        path: string;
        value: number;
    }>;
    aggregate: "max" | "sum";
    value: number;
}
export type FactProvenance = AnchorFactProvenance | PathMetricFactProvenance;
export interface FactReadContext {
    documents?: DocumentReader;
    baseRef?: string | null;
    headRef?: string | null;
    repositoryIdentity?: string | null;
    snapshotDocuments?: ImmutableSnapshotDocumentCache | null;
    readFileAtRef?: (ref: string, filePath: string) => unknown;
    readFile?: (filePath: string) => unknown;
    trackedFiles?: string[];
    diff?: {
        files?: {
            checked?: ParsedDiffFile[];
        };
    };
    anchors?: {
        byType?: Record<string, AnchorFactInputInstance[]>;
    };
    changeIntent?: unknown;
}
export interface DocumentFactError {
    code: DocumentFactErrorCode;
    pointer: string;
    segment?: string;
    message: string;
}
export type DocumentFactResult = {
    ok: true;
    value: NormalizedDocumentFact;
    provenance?: FactProvenance;
} | {
    ok: false;
    error: DocumentFactError;
};
export declare class DocumentFactFailure extends Error implements DocumentFactError {
    readonly code: DocumentFactErrorCode;
    readonly pointer: string;
    readonly segment?: string;
    constructor(code: DocumentFactErrorCode, message: string, pointer?: string, segment?: string);
}
export declare function parseYaml(content: string): unknown;
export declare function parseJson(content: string): unknown;
export declare function resolveJsonPointer(data: unknown, pointer: string): unknown;
export declare function projectDocumentValue(data: unknown, pointer: string): unknown;
export declare function projectDocumentValue(data: unknown, pointer: string, projection: "value"): unknown;
export declare function projectDocumentValue(data: unknown, pointer: string, projection: "array_items" | "object_values" | "object_keys"): unknown[];
export declare function projectDocumentValue(data: unknown, pointer: string, projection: DocumentProjection): unknown | unknown[];
export declare function normalizeDocumentFact(value: unknown, type: "scalar", pointer?: string): DocumentScalar;
export declare function normalizeDocumentFact(value: unknown, type: "string", pointer?: string): string;
export declare function normalizeDocumentFact(value: unknown, type: "boolean", pointer?: string): boolean;
export declare function normalizeDocumentFact(value: unknown, type: "string_set" | "repository_path_set", pointer?: string): string[];
export declare function normalizeDocumentFact(value: unknown, type: "repository_path", pointer?: string): string;
export declare function normalizeDocumentFact(value: unknown, type: DocumentFactType, pointer?: string): NormalizedDocumentFact;
export declare function readFact(context: FactReadContext, ref: FactRef): DocumentFactResult;
export declare function stripMarkdownInline(line: string): string;
export declare function markdownSection(markdown: MarkdownDocument, section: string): MarkdownSection;
export declare function createDocumentReader(options?: DocumentReaderOptions): DocumentReader;
