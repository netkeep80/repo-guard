import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { checkContentRules } from "../dist/checks/rules/content-rules.mjs";
import { renderInitScaffold } from "../dist/init.mjs";

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
for (const marker of ["Constraint Program", "repo-guard-grant", "GovernanceGrant", "schemas/governance-grant.schema.json", "primitive_relation"]) assert.match(readme, new RegExp(marker.replaceAll(".", "\\.")), `README должен содержать ${marker}`);
for (const retired of ["validate-integration", "doctor --integration", "repo-policy.integration"]) assert.doesNotMatch(readme, new RegExp(retired.replaceAll(".", "\\.")), `README не должен содержать удалённую поверхность ${retired}`);
assert.equal(existsSync(resolve(projectRoot, "docs/removing-bespoke-validators.md")), false, "удалённое руководство по integration DSL не должно оставаться публичной документацией");
assert.doesNotMatch(read("RELEASING.md"), /parallel-migration|v2-migration|v2\.1\.0|параллельного выпуска/, "RELEASING не должен описывать удалённый v2/parallel rollout");
const scaffold = renderInitScaffold({ preset: "application", mode: "blocking", actionRef: "0123456789abcdef0123456789abcdef01234567" });
assert.match(scaffold[".github/ISSUE_TEMPLATE/change-intent.yml"], /repo-guard-grant/, "generated issue template должен показывать отдельный GovernanceGrant");
assert.doesNotMatch(scaffold[".github/PULL_REQUEST_TEMPLATE.md"], /```repo-guard-grant/, "generated PR template не должен выдавать GovernanceGrant");
assert.match(read(".github/workflows/ci.yml"), /--compare 92432809fcddc290080beb51ba151e13a5761869/, "CI должен измерять Compression 3.0 от канонического C3.0 baseline");

console.log(`Проверено Markdown-файлов: ${markdownFiles.length}. Язык и архитектурные инварианты актуальны.`);
