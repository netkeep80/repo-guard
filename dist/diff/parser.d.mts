export type DiffFileStatus = "modified" | "added" | "deleted";
export interface ParsedDiffFile {
    path: string;
    previousPath?: string;
    addedLines: string[];
    deletedLines: string[];
    status: DiffFileStatus;
}
export declare function parseNameStatusZ(output: string): ParsedDiffFile[];
export declare function parseDiff(diffText: string): ParsedDiffFile[];
export declare function mergeDiffIdentity(diffText: string, identity: readonly ParsedDiffFile[]): ParsedDiffFile[];
export declare function parseMachineDiff(diffText: string, nameStatusZ: string): ParsedDiffFile[];
