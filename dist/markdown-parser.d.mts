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
export declare function parseMarkdown(content: unknown): MarkdownDocument;
