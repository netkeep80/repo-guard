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

function statusFromGit(code: string): DiffFileStatus {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (["M", "R", "C", "T"].includes(code)) return "modified";
  throw new Error(`unsupported git diff status "${code}"`);
}

export function parseNameStatusZ(output: string): ParsedDiffFile[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: ParsedDiffFile[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    if (!rawStatus || !/^[ACDMRTXU][0-9]*$/.test(rawStatus)) {
      throw new Error(`malformed git --name-status -z record at field ${index - 1}`);
    }
    const code = rawStatus[0]!;
    if (code === "U" || code === "X") throw new Error(`unsupported git diff status "${rawStatus}"`);
    const firstPath = fields[index++];
    if (firstPath === undefined || firstPath === "") throw new Error(`missing path for git diff status "${rawStatus}"`);
    if (code === "R" || code === "C") {
      const secondPath = fields[index++];
      if (secondPath === undefined || secondPath === "") throw new Error(`missing destination path for git diff status "${rawStatus}"`);
      files.push({ path: secondPath, previousPath: firstPath, addedLines: [], deletedLines: [], status: statusFromGit(code) });
      continue;
    }
    files.push({ path: firstPath, ...(code === "T" ? { gitStatus: "T" as const } : {}), addedLines: [], deletedLines: [], status: statusFromGit(code) });
  }
  return files;
}
