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