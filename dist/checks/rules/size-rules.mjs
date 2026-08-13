import { uniqueSorted } from "../../utils/collections.mjs";
import { matchesAny, normalizePathEntry, normalizePathList } from "../../utils/path-patterns.mjs";
import { readRepositoryBufferFile } from "../../utils/repository-files.mjs";
import { maxBound } from "../relation-kernel.mjs";
const changedPaths = (files, { includeDeleted = false } = {}) => normalizePathList((files || []).filter((file) => includeDeleted || file.status !== "deleted").map((file) => file.path));
const allKnownPaths = (files, options = {}) => normalizePathList([...(options.trackedFiles || options.allFiles || []), ...changedPaths(files)]);
function matchesRule(path, rule, options = {}) {
    const ignored = [...(options.ignorePatterns || []), ...(rule.ignore || [])];
    return matchesAny(path, [rule.glob || "**"]) && !(ignored.length && matchesAny(path, ignored));
}
const matchingPaths = (paths, rule, options) => normalizePathList(paths).filter((path) => matchesRule(path, rule, options));
const applies = (rule, options) => !rule.applies_to_change_types || rule.applies_to_change_types.includes(options.changeType || null);
export function countTextLines(content) {
    if (!content.length)
        return 0;
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = (normalized.match(/\n/g) || []).length + 1;
    return normalized.endsWith("\n") ? lines - 1 : lines;
}
function measureFile(path, metric, options) {
    if (metric === "files")
        return { skipped: false, actual: 1 };
    const content = readRepositoryBufferFile(path, options);
    if (content === null)
        return { skipped: true, actual: 0 };
    return { skipped: false, actual: metric === "bytes" ? content.length : countTextLines(content.toString("utf-8")) };
}
function measureDirectory(paths, rule, options) {
    if (rule.metric === "files")
        return paths.length;
    return paths.reduce((sum, path) => { const measured = measureFile(path, rule.metric, options); return sum + (measured.skipped ? 0 : measured.actual); }, 0);
}
function directoryPath(glob) {
    const normalized = normalizePathEntry(glob).replace(/\\/g, "/"), stable = [];
    for (const part of normalized.split("/").filter(Boolean)) {
        if (/[*?[\]{}()]/.test(part))
            break;
        stable.push(part);
    }
    return stable.length ? stable.join("/") : (normalized || ".");
}
function growth(files, rule, options) {
    if (rule.max_growth === undefined)
        return null;
    if (rule.scope !== "directory")
        throw new Error("max_growth is supported only for directory size rules");
    if (rule.metric === "bytes")
        throw new Error("max_growth for bytes is not supported; use an absolute byte max together with line/file growth");
    return (files || []).reduce((delta, file) => {
        if (!matchesRule(file.path, rule, options))
            return delta;
        if (rule.metric === "files")
            return delta + (file.status === "added" ? 1 : file.status === "deleted" ? -1 : 0);
        return delta + (file.addedLines?.length || 0) - (file.deletedLines?.length || 0);
    }, 0);
}
function formatViolation(v) {
    return v.kind === "growth"
        ? `[${v.ruleId}] ${v.path} changed ${v.metric}: ${v.before} -> ${v.after} (delta ${v.delta}, max growth ${v.maxGrowth})`
        : `[${v.ruleId}] ${v.path} has ${v.actual} ${v.metric} (max ${v.max})`;
}
export function checkSizeRules(files, rules = [], options = {}) {
    const blocking = [], advisory = [], errors = [], growthReports = [];
    const allPaths = allKnownPaths(files, options), changed = changedPaths(files), changedAll = changedPaths(files, { includeDeleted: true });
    for (const rule of rules || []) {
        if (!applies(rule, options))
            continue;
        const count = rule.count || "all_tracked", level = rule.level || "blocking";
        const fail = (violation) => (level === "advisory" ? advisory : blocking).push(violation);
        try {
            if (rule.scope === "file") {
                if (rule.metric === "files")
                    throw new Error("metric=files is supported only for directory size rules");
                for (const path of matchingPaths(count === "changed_only" ? changed : allPaths, rule, options)) {
                    const measured = measureFile(path, rule.metric, options);
                    if (!measured.skipped && !maxBound(measured.actual, rule.max))
                        fail({ ruleId: rule.id, rule_id: rule.id, kind: "absolute", scope: "file", path, metric: rule.metric, actual: measured.actual, max: rule.max, count, level });
                }
            }
            else if (rule.scope === "directory") {
                if (count === "changed_only" && !matchingPaths(changedAll, rule, options).length)
                    continue;
                const paths = matchingPaths(allPaths, rule, options), actual = measureDirectory(paths, rule, options), path = directoryPath(rule.glob);
                if (!maxBound(actual, rule.max))
                    fail({ ruleId: rule.id, rule_id: rule.id, kind: "absolute", scope: "directory", path, metric: rule.metric, actual, max: rule.max, count, level, files: paths });
                const delta = growth(files, rule, options);
                if (delta !== null) {
                    const report = { ruleId: rule.id, rule_id: rule.id, scope: "directory", path, metric: rule.metric, before: actual - delta, after: actual, delta, maxGrowth: rule.max_growth, max_growth: rule.max_growth, level };
                    growthReports.push(report);
                    if (!maxBound(delta, rule.max_growth))
                        fail({ ...report, kind: "growth" });
                }
            }
        }
        catch (error) {
            errors.push(`[${rule.id}] ${error.message}`);
        }
    }
    const failedRules = uniqueSorted([...blocking.map((v) => v.ruleId), ...(errors.length ? ["read-errors"] : [])]);
    return { ok: !blocking.length && !errors.length, size_violations: blocking, advisory_violations: advisory, failed_rules: failedRules,
        details: blocking.map(formatViolation), advisory_details: advisory.map(formatViolation), errors, growth: growthReports };
}
