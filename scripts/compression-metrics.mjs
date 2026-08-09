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
  return git(["ls-tree", "-r", "--name-only", targetRef, "--", ...roots]).split(/\r?\n/).filter(Boolean).sort();
}
const textAt = (targetRef, path) => git(["show", `${targetRef}:${path}`]);
function countLines(text) {
  if (!text.length) return 0;
  return (text.match(/\n/g) || []).length + (text.endsWith("\n") ? 0 : 1);
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
const jsonAt = (targetRef, path) => JSON.parse(textAt(targetRef, path));

function ruleFamilyCount(targetRef) {
  const text = textAt(targetRef, "src/checks/default-rule-families.mjs");
  const match = text.match(/defaultRuleFamilies\s*=\s*\[([\s\S]*?)\]/);
  return match ? (match[1].match(/\b[A-Za-z][A-Za-z0-9]*RuleFamily\b/g) || []).length : 0;
}

function markdownParserFiles(targetRef) {
  const markers = [
    "function parseMarkdown(",
    "const FENCE_RE",
    "function extractMarkdownSection(",
    "let inFence = false",
  ];
  return pathsAt(targetRef, ["src"]).filter((path) => {
    if (!/\.(?:mjs|js)$/.test(path)) return false;
    const content = textAt(targetRef, path);
    return markers.some((marker) => content.includes(marker));
  });
}

function architectureMetrics(targetRef) {
  const policy = jsonAt(targetRef, "repo-policy.json");
  const pkg = jsonAt(targetRef, "package.json");
  const coverage = jsonAt(targetRef, "docs/self-hosting-coverage.json");
  const parserFiles = markdownParserFiles(targetRef);
  const testCommand = pkg.scripts?.test || "";
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
      manual_test_script_entries: (testCommand.match(/node\s+tests\/(?:test-|validate-schemas)/g) || []).length,
      self_hosting_status_entries: (JSON.stringify(coverage).match(/"status":/g) || []).length,
      self_hosting_exceptions: Object.keys(coverage.exceptions || {}).length,
    },
  };
}

function subtract(after, before) {
  if (typeof after === "number" && typeof before === "number") return after - before;
  if (after && before && typeof after === "object" && typeof before === "object" && !Array.isArray(after) && !Array.isArray(before)) {
    return Object.fromEntries(Object.keys(after).filter((key) => Object.hasOwn(before, key)).map((key) => [key, subtract(after[key], before[key])]));
  }
  return undefined;
}

const current = architectureMetrics(ref);
if (!compareRef) console.log(JSON.stringify(current, null, 2));
else {
  const baseline = architectureMetrics(compareRef);
  console.log(JSON.stringify({ baseline, current, delta: subtract(current, baseline) }, null, 2));
}
