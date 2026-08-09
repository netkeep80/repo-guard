#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ref = arg("--ref", "HEAD");
const compareRef = arg("--compare");
const git = (argv) => execFileSync("git", argv, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
const pathsAt = (target, roots) => git(["ls-tree", "-r", "--name-only", target, "--", ...roots]).split(/\r?\n/).filter(Boolean).sort();
const textAt = (target, path) => git(["show", `${target}:${path}`]);
const jsonAt = (target, path) => JSON.parse(textAt(target, path));
const lines = (text) => text ? (text.match(/\n/g) || []).length + (text.endsWith("\n") ? 0 : 1) : 0;

function physical(target, roots) {
  const files = pathsAt(target, roots);
  return files.reduce((out, path) => {
    const content = textAt(target, path);
    out.lines += lines(content);
    out.bytes += Buffer.byteLength(content);
    return out;
  }, { files: files.length, lines: 0, bytes: 0 });
}

function sourceCorpus(target) {
  return pathsAt(target, ["src"]).filter((path) => /\.(?:mjs|js)$/.test(path)).map((path) => textAt(target, path)).join("\n");
}

function architecture(target) {
  const policy = jsonAt(target, "repo-policy.json");
  const pkg = jsonAt(target, "package.json");
  const coverage = jsonAt(target, "docs/self-hosting-coverage.json");
  const defaults = textAt(target, "src/checks/default-rule-families.mjs");
  const corpus = sourceCorpus(target);
  const parserFiles = pathsAt(target, ["src"]).filter((path) => /\.(?:mjs|js)$/.test(path) && /function parseMarkdown\(|const FENCE_RE|function extractMarkdownSection\(|let inFence = false/.test(textAt(target, path)));
  const metric = {
    rule_families: (defaults.match(/\b[A-Za-z][A-Za-z0-9]*RuleFamily\b/g) || []).length,
    declared_surfaces: Object.keys(policy.surfaces || {}).length,
    declared_new_file_classes: Object.keys(policy.new_file_classes || {}).length,
    markdown_parser_files: parserFiles.length,
    manual_test_script_entries: ((pkg.scripts?.test || "").match(/node\s+tests\/(?:test-|validate-schemas)/g) || []).length,
    self_hosting_status_entries: (JSON.stringify(coverage).match(/"status":/g) || []).length,
    self_hosting_exceptions: Object.keys(coverage.exceptions || {}).length,
    runtime_ir_compilers: (corpus.match(/function compileConstraintIR\b/g) || []).length,
    strictness_ir_compilers: (corpus.match(/function compilePolicyStrictnessIR\b/g) || []).length,
    command_dispatch_branches: (corpus.match(/command ===/g) || []).length,
    bespoke_integration_validator: pathsAt(target, ["src/integration-validator.mjs"]).length,
    privileged_field_workarounds: (corpus.match(/stripPrivilegedSchemaUnknownFields|SCHEMA_UNKNOWN_PRIVILEGED_FIELDS/g) || []).length,
  };
  metric.semantic_edit_sites = metric.rule_families + metric.runtime_ir_compilers + metric.strictness_ir_compilers + metric.bespoke_integration_validator + metric.command_dispatch_branches;
  return { ref: target, physical: { src: physical(target, ["src"]), schemas: physical(target, ["schemas"]), tests: physical(target, ["tests"]) }, architecture: metric };
}

function subtract(after, before) {
  if (typeof after === "number" && typeof before === "number") return after - before;
  if (!after || !before || typeof after !== "object" || typeof before !== "object" || Array.isArray(after) || Array.isArray(before)) return undefined;
  return Object.fromEntries(Object.keys(after).filter((key) => Object.hasOwn(before, key)).map((key) => [key, subtract(after[key], before[key])]));
}

const current = architecture(ref);
if (!compareRef) console.log(JSON.stringify(current, null, 2));
else {
  const baseline = architecture(compareRef);
  console.log(JSON.stringify({ baseline, current, delta: subtract(current, baseline) }, null, 2));
}
