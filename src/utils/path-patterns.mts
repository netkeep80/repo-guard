import { minimatch } from "minimatch";
import { uniqueSorted } from "./collections.mjs";

export function matchesAny(filePath: string, patterns: readonly string[] | null = []): boolean {
  return (patterns || []).some((pattern) => minimatch(filePath, pattern, { dot: true }));
}

export function normalizePathEntry(value: unknown): string {
  return String(value || "").trim().replace(/^\.\//, "");
}

export function normalizePathList(values: readonly unknown[] | null = []): string[] {
  return uniqueSorted((values || []).map(normalizePathEntry).filter(Boolean));
}
