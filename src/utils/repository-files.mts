import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

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

export function decodeUtf8Strict(content: Uint8Array, label = "text content"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export function readRepositoryTextFile(filePath: string, options: RepositoryFileOptions = {}): string {
  const callbackContent = readFromCallback(filePath, options);
  if (callbackContent !== undefined) {
    return callbackContent instanceof Uint8Array
      ? decodeUtf8Strict(callbackContent, `repository text "${filePath}"`)
      : String(callbackContent);
  }

  return decodeUtf8Strict(
    readFileSync(resolve(options.repoRoot || process.cwd(), filePath)),
    `repository text "${filePath}"`,
  );
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
