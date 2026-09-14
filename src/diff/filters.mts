import type { ParsedDiffFile } from "./parser.mjs";
import { matchesAny } from "../utils/path-patterns.mjs";

export function diffFilePathIdentities(file: ParsedDiffFile): string[] {
  return file.previousPath ? [file.previousPath, file.path] : [file.path];
}

export function filterOperationalPaths(
  files: readonly ParsedDiffFile[],
  operationalPaths: readonly string[] | null | undefined,
  preservedPaths: readonly string[] | null | undefined = [],
): readonly ParsedDiffFile[] {
  if (!operationalPaths || operationalPaths.length === 0) return files;
  return files.filter((file) => {
    const identities = diffFilePathIdentities(file);
    if (preservedPaths?.length && identities.some((path) => matchesAny(path, preservedPaths))) return true;
    return !identities.every((path) => matchesAny(path, operationalPaths));
  });
}
