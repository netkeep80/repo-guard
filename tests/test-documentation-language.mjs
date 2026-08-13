import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { checkContentRules } from "../dist/checks/rules/content-rules.mjs";

const __dirname = new URL(".", import.meta.url).pathname;
const projectRoot = resolve(__dirname, "..");
const skippedDirectories = new Set([".git", "node_modules", "ci-logs", "experiments", "coverage", "dist"]);

function listMarkdownFiles(directory = projectRoot) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...listMarkdownFiles(absolutePath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(relative(projectRoot, absolutePath).replaceAll("\\", "/"));
  }
  return result.sort();
}

const policy = JSON.parse(readFileSync(resolve(projectRoot, "repo-policy.json"), "utf-8"));
const languageRule = policy.content_rules.find((rule) => rule.mode === "markdown_language" && rule.language === "ru");
assert.ok(languageRule, "repo-policy.json должен содержать правило русского языка Markdown");

const markdownFiles = listMarkdownFiles();
assert.ok(markdownFiles.length > 0, "в репозитории должны быть Markdown-файлы для самопроверки");
const violations = checkContentRules(markdownFiles.map((path) => ({ path, status: "modified", addedLines: [] })), [languageRule], { repoRoot: projectRoot });
assert.deepEqual(violations, [], `Найдена нерусская Markdown-проза:\n${violations.map((v) => `${v.file}:${v.line_number}: ${v.unapproved_words.join(", ")} — ${v.line}`).join("\n")}`);

const read = (path) => readFileSync(resolve(projectRoot, path), "utf-8");
const readme = read("README.md");
assert.doesNotMatch(readme, /Constraint IR|contract\.overrides/, "README не должен описывать переходную архитектуру");
for (const marker of ["Constraint Program", "repo-guard-grant", "GovernanceGrant", "schemas/governance-grant.schema.json"]) assert.match(readme, new RegExp(marker.replaceAll(".", "\\.")), `README должен содержать ${marker}`);
assert.match(read("templates/issue-change-intent-example.md"), /repo-guard-grant/, "issue example должен показывать отдельный GovernanceGrant");
assert.doesNotMatch(read("templates/pr-change-intent-example.md"), /```repo-guard-grant/, "PR example не должен выдавать GovernanceGrant");
assert.match(read(".github/workflows/ci.yml"), /--compare 94f702271f6fe27672102f5271046151b023f94c/, "CI должен измерять Compression 2.0 от его baseline");

console.log(`Проверено Markdown-файлов: ${markdownFiles.length}. Язык и архитектурные инварианты актуальны.`);
