#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const ref = argValue("--ref", "HEAD");
const compareRef = argValue("--compare");

function git(arguments_) {
  return execFileSync("git", arguments_, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function pathsAt(targetRef, roots) {
  const output = git(["ls-tree", "-r", "--name-only", targetRef, "--", ...roots]);
  return output.split(/\r?\n/).filter(Boolean).sort();
}

function textAt(targetRef, path) {
  return git(["show", `${targetRef}:${path}`]);
}

function countLines(text) {
  if (text.length === 0) return 0;
  const newlines = (text.match(/\n/g) || []).length;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

function physicalMetrics(targetRef, roots) {
  const files = pathsAt(targetRef, roots);
  let lines = 0;
  let bytes = 0;
  for (const path of files) {
    const content = textAt(targetRef, path);
    lines += countLines(content);
    bytes += Buffer.byteLength(content);
  }
  return { files: files.length, lines, bytes };
}

function jsonAt(targetRef, path) {
  return JSON.parse(textAt(targetRef, path));
}

function ruleFamilyCount(targetRef) {
  const text = textAt(targetRef, "src/checks/default-rule-families.mjs");
  const match = text.match(/defaultRuleFamilies\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return 0;
  return (match[1].match(/\b[A-Za-z][A-Za-z0-9]*RuleFamily\b/g) || []).length;
}

function markdownParserFiles(targetRef) {
  const markers = [
    "parseMarkdown(",
    "FENCE_RE",
    "markdownHeadingLevel(",
    "stripMarkdownProse(",
  ];
  const files = pathsAt(targetRef, ["src"]);
  return files.filter((path) => {
    if (!/\.(?:mjs|js)$/.test(path)) return false;
    const content = textAt(targetRef, path);
    return markers.some((marker) => content.includes(marker));
  });
}

function architectureMetrics(targetRef) {
  const policy = jsonAt(targetRef, "repo-policy.json");
  const pkg = jsonAt(targetRef, "package.json");
  const coverage = jsonAt(targetRef, "docs/self-hosting-coverage.json");
  const coverageText = JSON.stringify(coverage);
  const testCommand = pkg.scripts?.test || "";
  const parserFiles = markdownParserFiles(targetRef);

  return {
    ref: targetRef,
    physical: {
      src: physicalMetrics(targetRef, ["src"]),
      schemas: physicalMetrics(targetRef, ["schemas"]),
      tests: physicalMetrics(targetRef, ["tests"]),
    },
    architecture: {
      rule_families: ruleFamilyCount(targetRef),
      declared_surfaces: Object.keys(policy.surfaces || {}).length,
      declared_new_file_classes: Object.keys(policy.new_file_classes || {}).length,
      markdown_parser_files: parserFiles.length,
      markdown_parser_paths: parserFiles,
      manual_test_script_entries: (testCommand.match(/node\s+tests\//g) || []).length,
      self_hosting_status_entries: (coverageText.match(/"status":/g) || []).length,
    },
  };
}

function subtract(after, before) {
  if (typeof after === "number" && typeof before === "number") return after - before;
  if (after && before && typeof after === "object" && typeof before === "object" && !Array.isArray(after) && !Array.isArray(before)) {
    const result = {};
    for (const key of Object.keys(after)) {
      if (Object.hasOwn(before, key)) result[key] = subtract(after[key], before[key]);
    }
    return result;
  }
  return undefined;
}

const current = architectureMetrics(ref);
if (!compareRef) {
  console.log(JSON.stringify(current, null, 2));
} else {
  const baseline = architectureMetrics(compareRef);
  console.log(JSON.stringify({ baseline, current, delta: subtract(current, baseline) }, null, 2));
}
