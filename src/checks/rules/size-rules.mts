import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { uniqueSorted } from "../../utils/collections.mjs";
import { matchesAny, normalizePathEntry, normalizePathList } from "../../utils/path-patterns.mjs";
import { readRepositoryBufferFile } from "../../utils/repository-files.mjs";
import type { RepositoryFileOptions } from "../../utils/repository-files.mjs";
import { maxBound } from "../relation-kernel.mjs";

export type SizeMetric = "files" | "bytes" | "lines";
export type SizeScope = "file" | "directory";
export type SizeCount = "all_tracked" | "changed_only";
export type SizeLevel = "blocking" | "advisory";

export interface SizeRule {
  id: string;
  glob?: string;
  ignore?: string[];
  metric: SizeMetric;
  scope: SizeScope;
  max?: number;
  max_growth?: number;
  count?: SizeCount;
  level?: SizeLevel;
  applies_to_change_types?: Array<string | null>;
}

export interface SizeRuleOptions extends RepositoryFileOptions {
  trackedFiles?: string[];
  allFiles?: string[];
  ignorePatterns?: string[];
  changeType?: string | null;
}

interface ChangedPathOptions {
  includeDeleted?: boolean;
}

interface FileMeasurement {
  skipped: boolean;
  actual: number;
}

interface SizeAbsoluteViolation {
  ruleId: string;
  rule_id: string;
  kind: "absolute";
  scope: SizeScope;
  path: string;
  metric: SizeMetric;
  actual: number;
  max: number | undefined;
  count: SizeCount;
  level: SizeLevel;
  files?: string[];
}

export interface SizeGrowthReport {
  ruleId: string;
  rule_id: string;
  scope: "directory";
  path: string;
  metric: SizeMetric;
  before: number;
  after: number;
  delta: number;
  maxGrowth: number | undefined;
  max_growth: number | undefined;
  level: SizeLevel;
}

interface SizeGrowthViolation extends SizeGrowthReport {
  kind: "growth";
}

type SizeViolation = SizeAbsoluteViolation | SizeGrowthViolation;

export interface SizeRuleCheckResult {
  ok: boolean;
  size_violations: SizeViolation[];
  advisory_violations: SizeViolation[];
  failed_rules: string[];
  details: string[];
  advisory_details: string[];
  errors: string[];
  growth: SizeGrowthReport[];
}

const changedPaths = (files: ParsedDiffFile[], { includeDeleted = false }: ChangedPathOptions = {}): string[] => normalizePathList((files || []).filter((file) => includeDeleted || file.status !== "deleted").map((file) => file.path));
const allKnownPaths = (files: ParsedDiffFile[], options: SizeRuleOptions = {}): string[] => normalizePathList([...(options.trackedFiles || options.allFiles || []), ...changedPaths(files)]);
function matchesRule(path: string, rule: SizeRule, options: SizeRuleOptions = {}): boolean {
  const ignored = [...(options.ignorePatterns || []), ...(rule.ignore || [])];
  return matchesAny(path, [rule.glob || "**"]) && !(ignored.length && matchesAny(path, ignored));
}
const matchingPaths = (paths: string[], rule: SizeRule, options: SizeRuleOptions): string[] => normalizePathList(paths).filter((path) => matchesRule(path, rule, options));
const applies = (rule: SizeRule, options: SizeRuleOptions): boolean => !rule.applies_to_change_types || rule.applies_to_change_types.includes(options.changeType || null);

export function countTextLines(content: string): number {
  if (!content.length) return 0;
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = (normalized.match(/\n/g) || []).length + 1;
  return normalized.endsWith("\n") ? lines - 1 : lines;
}
function measureFile(path: string, metric: SizeMetric, options: SizeRuleOptions): FileMeasurement {
  if (metric === "files") return { skipped: false, actual: 1 };
  const content = readRepositoryBufferFile(path, options);
  if (content === null) return { skipped: true, actual: 0 };
  return { skipped: false, actual: metric === "bytes" ? content.length : countTextLines(content.toString("utf-8")) };
}
function measureDirectory(paths: string[], rule: SizeRule, options: SizeRuleOptions): number {
  if (rule.metric === "files") return paths.length;
  return paths.reduce((sum, path) => { const measured = measureFile(path, rule.metric, options); return sum + (measured.skipped ? 0 : measured.actual); }, 0);
}
function directoryPath(glob: string | undefined): string {
  const normalized = normalizePathEntry(glob).replace(/\\/g, "/"), stable: string[] = [];
  for (const part of normalized.split("/").filter(Boolean)) { if (/[*?[\]{}()]/.test(part)) break; stable.push(part); }
  return stable.length ? stable.join("/") : (normalized || ".");
}
function growth(files: ParsedDiffFile[], rule: SizeRule, options: SizeRuleOptions): number | null {
  if (rule.max_growth === undefined) return null;
  if (rule.scope !== "directory") throw new Error("max_growth is supported only for directory size rules");
  if (rule.metric === "bytes") throw new Error("max_growth for bytes is not supported; use an absolute byte max together with line/file growth");
  return (files || []).reduce((delta, file) => {
    if (!matchesRule(file.path, rule, options)) return delta;
    if (rule.metric === "files") return delta + (file.status === "added" ? 1 : file.status === "deleted" ? -1 : 0);
    return delta + (file.addedLines?.length || 0) - (file.deletedLines?.length || 0);
  }, 0);
}
function formatViolation(v: SizeViolation): string {
  return v.kind === "growth"
    ? `[${v.ruleId}] ${v.path} changed ${v.metric}: ${v.before} -> ${v.after} (delta ${v.delta}, max growth ${v.maxGrowth})`
    : `[${v.ruleId}] ${v.path} has ${v.actual} ${v.metric} (max ${v.max})`;
}

export function checkSizeRules(files: ParsedDiffFile[], rules: SizeRule[] = [], options: SizeRuleOptions = {}): SizeRuleCheckResult {
  const blocking: SizeViolation[] = [], advisory: SizeViolation[] = [], errors: string[] = [], growthReports: SizeGrowthReport[] = [];
  const allPaths = allKnownPaths(files, options), changed = changedPaths(files), changedAll = changedPaths(files, { includeDeleted: true });
  for (const rule of rules || []) {
    if (!applies(rule, options)) continue;
    const count = rule.count || "all_tracked", level = rule.level || "blocking";
    const fail = (violation: SizeViolation): number => (level === "advisory" ? advisory : blocking).push(violation);
    try {
      if (rule.scope === "file") {
        if (rule.metric === "files") throw new Error("metric=files is supported only for directory size rules");
        for (const path of matchingPaths(count === "changed_only" ? changed : allPaths, rule, options)) {
          const measured = measureFile(path, rule.metric, options);
          if (!measured.skipped && !maxBound(measured.actual, rule.max)) fail({ ruleId: rule.id, rule_id: rule.id, kind: "absolute", scope: "file", path, metric: rule.metric, actual: measured.actual, max: rule.max, count, level });
        }
      } else if (rule.scope === "directory") {
        if (count === "changed_only" && !matchingPaths(changedAll, rule, options).length) continue;
        const paths = matchingPaths(allPaths, rule, options), actual = measureDirectory(paths, rule, options), path = directoryPath(rule.glob);
        if (!maxBound(actual, rule.max)) fail({ ruleId: rule.id, rule_id: rule.id, kind: "absolute", scope: "directory", path, metric: rule.metric, actual, max: rule.max, count, level, files: paths });
        const delta = growth(files, rule, options);
        if (delta !== null) {
          const report: SizeGrowthReport = { ruleId: rule.id, rule_id: rule.id, scope: "directory", path, metric: rule.metric, before: actual - delta, after: actual, delta, maxGrowth: rule.max_growth, max_growth: rule.max_growth, level };
          growthReports.push(report);
          if (!maxBound(delta, rule.max_growth)) fail({ ...report, kind: "growth" });
        }
      }
    } catch (error) { errors.push(`[${rule.id}] ${(error as Error).message}`); }
  }
  const failedRules = uniqueSorted([...blocking.map((v) => v.ruleId), ...(errors.length ? ["read-errors"] : [])]);
  return { ok: !blocking.length && !errors.length, size_violations: blocking, advisory_violations: advisory, failed_rules: failedRules,
    details: blocking.map(formatViolation), advisory_details: advisory.map(formatViolation), errors, growth: growthReports };
}
