import type { DiffFileStatus, ParsedDiffFile } from "./parser.mjs";
import { uniqueSorted } from "../utils/collections.mjs";
import { matchesAny } from "../utils/path-patterns.mjs";

type PathSelectorMap = Readonly<Record<string, readonly string[]>>;

interface PathSelectionOptions {
  statuses?: readonly DiffFileStatus[] | null;
  excludeStatuses?: readonly DiffFileStatus[];
}

function statusAllowed(file: ParsedDiffFile, statuses: readonly DiffFileStatus[] | null | undefined): boolean {
  return !statuses || statuses.includes(file.status);
}

export function selectPaths(files: readonly ParsedDiffFile[], patterns: readonly string[] | null = [], options: PathSelectionOptions = {}): string[] {
  const { statuses = null, excludeStatuses = [] } = options;
  return uniqueSorted(files
    .filter((file) => statusAllowed(file, statuses) && !excludeStatuses.includes(file.status))
    .filter((file) => matchesAny(file.path, patterns || []))
    .map((file) => file.path));
}

export function classifyPathSets(files: readonly ParsedDiffFile[], selectors: PathSelectorMap | null = {}, options: PathSelectionOptions = {}) {
  const candidates = files.filter((file) =>
    statusAllowed(file, options.statuses || null) && !(options.excludeStatuses || []).includes(file.status));
  const selectedPaths = uniqueSorted(candidates.map((file) => file.path));
  const filesBySelector: Record<string, string[]> = {};
  const selectorsByFile: Record<string, string[]> = {};

  for (const [name, patterns] of Object.entries(selectors || {})) {
    const matched = selectPaths(candidates, patterns);
    if (matched.length === 0) continue;
    filesBySelector[name] = matched;
    for (const path of matched) (selectorsByFile[path] ||= []).push(name);
  }
  for (const names of Object.values(selectorsByFile)) names.sort();

  return {
    selected_paths: selectedPaths,
    touched_selectors: Object.keys(filesBySelector).sort(),
    files_by_selector: filesBySelector,
    selectors_by_file: selectorsByFile,
    unclassified_files: selectedPaths.filter((path) => !selectorsByFile[path]),
  };
}

export function detectTouchedSurfaces(files: readonly ParsedDiffFile[], surfaces: PathSelectorMap | null = {}) {
  const selected = classifyPathSets(files, surfaces);
  return {
    touched_surfaces: selected.touched_selectors,
    files_by_surface: selected.files_by_selector,
    unclassified_files: selected.unclassified_files,
  };
}

export function classifyNewFiles(files: readonly ParsedDiffFile[], classes: PathSelectorMap | null = {}) {
  const selected = classifyPathSets(files, classes, { statuses: ["added"] });
  return {
    new_files: selected.selected_paths,
    files_by_class: selected.files_by_selector,
    class_by_file: selected.selectors_by_file,
    unclassified_files: selected.unclassified_files,
  };
}
