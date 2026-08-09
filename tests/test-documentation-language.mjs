import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { checkContentRules } from "../src/checks/rules/content-rules.mjs";

const __dirname = new URL(".", import.meta.url).pathname;
const projectRoot = resolve(__dirname, "..");
const skippedDirectories = new Set([
  ".git",
  "node_modules",
  "ci-logs",
  "experiments",
  "coverage",
  "dist",
]);

function listMarkdownFiles(directory = projectRoot) {
  const result = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;

    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...listMarkdownFiles(absolutePath));
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    result.push(relative(projectRoot, absolutePath).replaceAll("\\", "/"));
  }

  return result.sort();
}

const policy = JSON.parse(readFileSync(resolve(projectRoot, "repo-policy.json"), "utf-8"));
const languageRule = policy.content_rules.find(
  (rule) => rule.mode === "markdown_language" && rule.language === "ru",
);

assert.ok(languageRule, "repo-policy.json должен содержать правило русского языка Markdown");

const markdownFiles = listMarkdownFiles();
assert.ok(markdownFiles.length > 0, "в репозитории должны быть Markdown-файлы для самопроверки");

const violations = checkContentRules(
  markdownFiles.map((path) => ({ path, status: "modified", addedLines: [] })),
  [languageRule],
  { repoRoot: projectRoot },
);

assert.deepEqual(
  violations,
  [],
  `Найдена нерусская Markdown-проза:\n${violations
    .map(
      (violation) =>
        `${violation.file}:${violation.line_number}: ${violation.unapproved_words.join(", ")} — ${violation.line}`,
    )
    .join("\n")}`,
);

console.log(`Проверено Markdown-файлов: ${markdownFiles.length}. Нарушений языка нет.`);
