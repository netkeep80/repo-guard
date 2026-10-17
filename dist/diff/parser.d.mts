export type DiffFileStatus = "modified" | "added" | "deleted";
export interface ParsedDiffFile {
    path: string;
    previousPath?: string;
    /** Exact machine identity needed only when generic status would lose a Git type-change fact. */
    gitStatus?: "T";
    addedLines: string[];
    deletedLines: string[];
    status: DiffFileStatus;
}
export declare function parseNameStatusZ(output: string): ParsedDiffFile[];
export declare function parseDiff(diffText: string): ParsedDiffFile[];
export declare function mergeDiffIdentity(diffText: string, identity: readonly ParsedDiffFile[]): ParsedDiffFile[];
export declare function parseMachineDiff(diffText: string, nameStatusZ: string): ParsedDiffFile[];
