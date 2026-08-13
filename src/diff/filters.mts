import type { ParsedDiffFile } from "./parser.mjs";
import { matchesAny } from "../utils/path-patterns.mjs";

export function filterOperationalPaths(
  files: readonly ParsedDiffFile[],
  operationalPaths: readonly string[] | null | undefined,
): readonly ParsedDiffFile[] {
  if (!operationalPaths || operationalPaths.length === 0) return files;
  return files.filter((file) => !matchesAny(file.path, operationalPaths));
}
