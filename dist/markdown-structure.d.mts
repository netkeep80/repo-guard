import { type MarkdownHeading } from "./markdown-parser.mjs";
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
export declare function resolveMarkdownAnchor(source: string, anchorId: string): MarkdownAddress;
export declare function listMarkdownAnchorIds(source: string): string[];
export declare function readMarkdownNode(source: string, anchorId: string, options?: MarkdownStructureOptions): MarkdownNode;
export declare function listMarkdownChildren(source: string, parentAnchorId: string, options?: MarkdownStructureOptions): MarkdownNode[];
export declare function listMarkdownSections(source: string, options?: MarkdownStructureOptions): MarkdownSection[];
export declare function insertMarkdownChild(args: {
    source: string;
    mode: MarkdownDocumentMode;
    parentAnchorId: string;
    child: MarkdownChildSpec;
}): string;
export declare function readOwnedMarkdownBlock(source: string, block: MarkdownOwnedBlockSpec): MarkdownOwnedBlock | null;
export declare function replaceOwnedMarkdownBlock(args: {
    source: string;
    mode: MarkdownDocumentMode;
    anchorId: string;
    block: MarkdownOwnedBlockSpec;
    generatedContent: string;
}): string;
