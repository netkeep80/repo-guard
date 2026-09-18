import type { ParsedDiffFile } from "./parser.mjs";

export function calculateDiffGrowth(files: readonly ParsedDiffFile[]) {
  const newFiles = files.filter((file) => file.status === "added").map((file) => file.path);
  let netAddedLines = 0;
  for (const file of files) {
    netAddedLines += file.addedLines.length - (file.deletedLines ? file.deletedLines.length : 0);
  }

  return {
    new_files: newFiles.length,
    new_files_list: newFiles,
    net_added_lines: netAddedLines,
  };
}
