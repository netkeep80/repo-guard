import { createDocumentReader, stripMarkdownInline } from "../../document-facts.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";

function checkRegexRule(files, rule) {
  const violations = [];
  const regexes = rule.forbid_regex.map((pattern) => new RegExp(pattern));
  for (const file of files) {
    if (!matchesAny(file.path, [rule.glob || "**"])) continue;
    for (const line of file.addedLines || []) {
      regexes.forEach((regex, index) => {
        if (regex.test(line)) violations.push({
          kind: "regex", rule_id: rule.id, file: file.path, line: line.trim(), matched_regex: rule.forbid_regex[index],
        });
      });
    }
  }
  return violations;
}

function markdownLanguageViolations(file, rule, documents) {
  const allowed = new Set(rule.allow_words || []);
  const maxLatin = rule.max_unapproved_latin_words_per_line ?? 1;
  const violations = [];
  for (const prose of documents.markdown(file.path).proseLines) {
    const line = stripMarkdownInline(prose.text);
    const latin = [...line.matchAll(/(?<![\w])([A-Za-z][A-Za-z-]{2,})(?![\w])/g)]
      .map((match) => match[1]).filter((word) => !allowed.has(word));
    const hasCyrillic = /[А-Яа-яЁё]{3,}/.test(line);
    if (latin.length > maxLatin || (latin.length > 0 && !hasCyrillic)) {
      violations.push({
        kind: "language", rule_id: rule.id, file: file.path, line_number: prose.line,
        line: prose.text.trim(), language: rule.language, unapproved_words: latin,
      });
    }
  }
  return violations;
}

export function checkContentRules(files, rules = [], options = {}) {
  const violations = [];
  const documents = options.documents || createDocumentReader(options);
  for (const rule of rules) {
    if (rule.mode === "added_lines" && rule.forbid_regex) violations.push(...checkRegexRule(files, rule));
    else if (rule.mode === "markdown_language") {
      for (const file of files) {
        if (file.status !== "deleted" && matchesAny(file.path, [rule.glob || "**/*.md"])) {
          violations.push(...markdownLanguageViolations(file, rule, documents));
        }
      }
    }
  }
  return violations;
}

function formatViolation(violation) {
  return violation.kind === "language"
    ? `[${violation.rule_id}] ${violation.file}:${violation.line_number}: unapproved ${violation.language} prose words: ${violation.unapproved_words.join(", ")}`
    : `[${violation.rule_id}] ${violation.file}: "${violation.line}" matched /${violation.matched_regex}/`;
}

export const contentRuleFamily = {
  id: "content-rules",
  evaluate(facts) {
    const violations = checkContentRules(facts.diff.files.checked, facts.policy.content_rules, {
      repoRoot: facts.repositoryRoot, readFile: facts.readFile, documents: facts.documents,
    });
    return violations.length
      ? { name: "content-rules", check: { ok: false, violations, details: violations.map(formatViolation) } }
      : { name: "content-rules", check: { ok: true } };
  },
};
