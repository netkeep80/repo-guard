import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RepositoryFileOptions {
  repoRoot?: string;
  readFile?: (filePath: string) => unknown;
}

function readFromCallback(filePath: string, options: RepositoryFileOptions = {}): unknown {
  if (!options.readFile) return undefined;

  const content = options.readFile(filePath);
  if (content === undefined || content === null) {
    throw new Error(`cannot read ${filePath}`);
  }
  return content;
}

export function readRepositoryTextFile(filePath: string, options: RepositoryFileOptions = {}): string {
  const callbackContent = readFromCallback(filePath, options);
  if (callbackContent !== undefined) {
    return Buffer.isBuffer(callbackContent)
      ? callbackContent.toString("utf-8")
      : String(callbackContent);
  }

  return readFileSync(resolve(options.repoRoot || process.cwd(), filePath), "utf-8");
}

export function readRepositoryBufferFile(filePath: string, options: RepositoryFileOptions = {}): Buffer | null {
  const callbackContent = readFromCallback(filePath, options);
  if (callbackContent !== undefined) {
    return Buffer.isBuffer(callbackContent)
      ? callbackContent
      : Buffer.from(String(callbackContent));
  }

  const fullPath = resolve(options.repoRoot || process.cwd(), filePath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath);
}
