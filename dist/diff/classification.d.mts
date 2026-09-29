import type { DiffFileStatus, ParsedDiffFile } from "./parser.mjs";
type PathSelectorMap = Readonly<Record<string, readonly string[]>>;
interface PathSelectionOptions {
    statuses?: readonly DiffFileStatus[] | null;
    excludeStatuses?: readonly DiffFileStatus[];
}
export declare function selectPaths(files: readonly ParsedDiffFile[], patterns?: readonly string[] | null, options?: PathSelectionOptions): string[];
export declare function classifyPathSets(files: readonly ParsedDiffFile[], selectors?: PathSelectorMap | null, options?: PathSelectionOptions): {
    selected_paths: string[];
    touched_selectors: string[];
    files_by_selector: Record<string, string[]>;
    selectors_by_file: Record<string, string[]>;
    unclassified_files: string[];
};
export declare function detectTouchedSurfaces(files: readonly ParsedDiffFile[], surfaces?: PathSelectorMap | null): {
    touched_surfaces: string[];
    files_by_surface: Record<string, string[]>;
    unclassified_files: string[];
};
export declare function classifyNewFiles(files: readonly ParsedDiffFile[], classes?: PathSelectorMap | null): {
    new_files: string[];
    files_by_class: Record<string, string[]>;
    class_by_file: Record<string, string[]>;
    unclassified_files: string[];
};
export {};
