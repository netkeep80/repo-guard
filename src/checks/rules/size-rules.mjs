import { uniqueSorted } from "../../utils/collections.mjs";
import {
  matchesAny,
  normalizePathEntry,
  normalizePathList,
} from "../../utils/path-patterns.mjs";
import { readRepositoryBufferFile } from "../../utils/repository-files.mjs";

function changedPaths(files, options = {}) {
  const includeDeleted = Boolean(options.includeDeleted);
  return normalizePathList(
    (files || [])
      .filter((file) => includeDeleted || file.status !== "deleted")
      .map((file) => file.path)
  );
}

function allKnownPaths(files, options = {}) {
  return normalizePathList([
    ...(options.trackedFiles || options.allFiles || []),
    ...changedPaths(files),
  ]);
}

function ignoredBySizeRule(path, rule, options = {}) {
  const ignored = [
    ...(options.ignorePatterns || []),
    ...(rule.ignore || []),
  ];
  return ignored.length > 0 && matchesAny(path, ignored);
}

function matchesSizeRule(path, rule, options = {}) {
  const glob = rule.glob || "**";
  return matchesAny(path, [glob]) && !ignoredBySizeRule(path, rule, options);
}

function matchingSizeRulePaths(paths, rule, options = {}) {
  return normalizePathList(paths).filter((path) => matchesSizeRule(path, rule, options));
}

function sizeRuleApplies(rule, options = {}) {
  const changeType = options.changeType || null;
  if (
    rule.applies_to_change_types &&
    !rule.applies_to_change_types.includes(changeType)
  ) {
    return false;
  }
  return true;
}

export function countTextLines(content) {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let lines = 1;
  for (const char of normalized) {
    if (char === "\n") lines++;
  }
  return normalized.endsWith("\n") ? lines - 1 : lines;
}

function measureSizeRuleFile(path, metric, options = {}) {
  if (metric === "files") return { skipped: false, actual: 1 };
  const content = readRepositoryBufferFile(path, options);
  if (content === null) return { skipped: true, actual: 0 };
  if (metric === "bytes") return { skipped: false, actual: content.length };
  return { skipped: false, actual: countTextLines(content.toString("utf-8")) };
}

function measureDirectory(paths, rule, options = {}) {
  if (rule.metric === "files") return paths.length;
  let actual = 0;
  for (const path of paths) {
    const measured = measureSizeRuleFile(path, rule.metric, options);
    if (!measured.skipped) actual += measured.actual;
  }
  return actual;
}

function directoryPathFromGlob(glob) {
  const normalized = normalizePathEntry(glob).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const stableParts = [];
  for (const part of parts) {
    if (/[*?[\]{}()]/.test(part)) break;
    stableParts.push(part);
  }
  return stableParts.length > 0 ? stableParts.join("/") : (normalized || ".");
}

function calculateGrowth(files, rule, options = {}) {
  if (rule.max_growth === undefined) return null;
  if (rule.scope !== "directory") {
    throw new Error("max_growth is supported only for directory size rules");
  }
  if (rule.metric === "bytes") {
    throw new Error("max_growth for bytes is not supported; use an absolute byte max together with line/file growth");
  }

  let delta = 0;
  for (const file of files || []) {
    if (!matchesSizeRule(file.path, rule, options)) continue;
    if (rule.metric === "files") {
      if (file.status === "added") delta += 1;
      else if (file.status === "deleted") delta -= 1;
      continue;
    }
    delta += (file.addedLines?.length || 0) - (file.deletedLines?.length || 0);
  }
  return delta;
}

function formatSizeViolation(violation) {
  if (violation.kind === "growth") {
    return `[${violation.ruleId}] ${violation.path} changed ${violation.metric}: ${violation.before} -> ${violation.after} (delta ${violation.delta}, max growth ${violation.maxGrowth})`;
  }
  return `[${violation.ruleId}] ${violation.path} has ${violation.actual} ${violation.metric} (max ${violation.max})`;
}

export function checkSizeRules(files, rules = [], options = {}) {
  if (!rules || rules.length === 0) {
    return {
      ok: true,
      size_violations: [],
      advisory_violations: [],
      failed_rules: [],
      details: [],
      growth: [],
    };
  }

  const blockingViolations = [];
  const advisoryViolations = [];
  const errors = [];
  const growthReports = [];
  const allPaths = allKnownPaths(files, options);
  const changedNonDeletedPaths = changedPaths(files);
  const changedIncludingDeletedPaths = changedPaths(files, { includeDeleted: true });

  for (const rule of rules) {
    if (!sizeRuleApplies(rule, options)) continue;

    const count = rule.count || "all_tracked";
    const level = rule.level || "blocking";
    const addViolation = (violation) => {
      if (level === "advisory") advisoryViolations.push(violation);
      else blockingViolations.push(violation);
    };

    try {
      if (rule.scope === "file") {
        if (rule.metric === "files") {
          throw new Error("metric=files is supported only for directory size rules");
        }
        const sourcePaths = count === "changed_only" ? changedNonDeletedPaths : allPaths;
        const paths = matchingSizeRulePaths(sourcePaths, rule, options);
        for (const path of paths) {
          const measured = measureSizeRuleFile(path, rule.metric, options);
          if (measured.skipped || measured.actual <= rule.max) continue;
          addViolation({
            ruleId: rule.id,
            rule_id: rule.id,
            kind: "absolute",
            scope: "file",
            path,
            metric: rule.metric,
            actual: measured.actual,
            max: rule.max,
            count,
            level,
          });
        }
      } else if (rule.scope === "directory") {
        const changedMatches = matchingSizeRulePaths(changedIncludingDeletedPaths, rule, options);
        if (count === "changed_only" && changedMatches.length === 0) continue;

        const paths = matchingSizeRulePaths(allPaths, rule, options);
        const actual = measureDirectory(paths, rule, options);
        if (actual > rule.max) {
          addViolation({
            ruleId: rule.id,
            rule_id: rule.id,
            kind: "absolute",
            scope: "directory",
            path: directoryPathFromGlob(rule.glob),
            metric: rule.metric,
            actual,
            max: rule.max,
            count,
            level,
            files: paths,
          });
        }

        const delta = calculateGrowth(files, rule, options);
        if (delta !== null) {
          const report = {
            ruleId: rule.id,
            rule_id: rule.id,
            scope: "directory",
            path: directoryPathFromGlob(rule.glob),
            metric: rule.metric,
            before: actual - delta,
            after: actual,
            delta,
            maxGrowth: rule.max_growth,
            max_growth: rule.max_growth,
            level,
          };
          growthReports.push(report);
          if (delta > rule.max_growth) {
            addViolation({ ...report, kind: "growth" });
          }
        }
      }
    } catch (error) {
      errors.push(`[${rule.id}] ${error.message}`);
    }
  }

  const failedRules = uniqueSorted([
    ...blockingViolations.map((violation) => violation.ruleId),
    ...(errors.length > 0 ? ["read-errors"] : []),
  ]);

  return {
    ok: blockingViolations.length === 0 && errors.length === 0,
    size_violations: blockingViolations,
    advisory_violations: advisoryViolations,
    failed_rules: failedRules,
    details: blockingViolations.map(formatSizeViolation),
    advisory_details: advisoryViolations.map(formatSizeViolation),
    errors,
    growth: growthReports,
  };
}

export const sizeRuleFamily = {
  id: "size-rules",
  evaluate(facts) {
    const result = checkSizeRules(facts.diff.files.checked, facts.policy.size_rules, {
      repoRoot: facts.repositoryRoot,
      trackedFiles: facts.trackedFiles,
      readFile: facts.readFile,
      ignorePatterns: facts.policy.paths.operational_paths,
      changeType: facts.contract?.change_type,
    });
    const entries = [
      {
        name: "size-rules",
        check: result,
      },
    ];

    if (result.advisory_violations.length > 0) {
      entries.push({
        name: "size-rules-advisory",
        check: {
          ok: false,
          advisory: true,
          size_violations: result.advisory_violations,
          details: result.advisory_details,
          growth: result.growth,
        },
      });
    }

    return entries;
  },
};
