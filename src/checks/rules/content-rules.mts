import type { DocumentReader, DocumentReaderOptions } from "../../document-facts.mjs";
import { createDocumentReader, stripMarkdownInline } from "../../document-facts.mjs";
import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";
import type { RuleFamily } from "../rule-registry.mjs";

interface RegexContentRule {
  id: string;
  mode: "added_lines";
  glob?: string;
  forbid_regex: string[];
}

interface MarkdownLanguageRule {
  id: string;
  mode: "markdown_language";
  glob?: string;
  language: string;
  allow_words?: string[];
  max_unapproved_latin_words_per_line?: number;
}

type ContentRule = RegexContentRule | MarkdownLanguageRule | { id?: string; mode?: string; [key: string]: unknown };

interface RegexViolation {
  kind: "regex";
  rule_id: string;
  file: string;
  line: string;
  matched_regex: string;
}

interface LanguageViolation {
  kind: "language";
  rule_id: string;
  file: string;
  line_number: number;
  line: string;
  language: string;
  unapproved_words: string[];
}

type ContentViolation = RegexViolation | LanguageViolation;

interface ContentRuleOptions extends DocumentReaderOptions {
  documents?: DocumentReader;
}

interface ContentRuleFacts {
  diff: { files: { checked: ParsedDiffFile[] } };
  policy: { content_rules: ContentRule[] };
  repositoryRoot?: string;
  readFile?: DocumentReaderOptions["readFile"];
  documents: DocumentReader;
}

function checkRegexRule(files: ParsedDiffFile[], rule: RegexContentRule): RegexViolation[] {
  const violations: RegexViolation[] = [];
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

function markdownLanguageViolations(file: ParsedDiffFile, rule: MarkdownLanguageRule, documents: DocumentReader): LanguageViolation[] {
  const allowed = new Set(rule.allow_words || []);
  const maxLatin = rule.max_unapproved_latin_words_per_line ?? 1;
  const violations: LanguageViolation[] = [];
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

export function checkContentRules(files: ParsedDiffFile[], rules: ContentRule[] = [], options: ContentRuleOptions = {}): ContentViolation[] {
  const violations: ContentViolation[] = [];
  const documents = options.documents || createDocumentReader(options);
  for (const rule of rules) {
    if (rule.mode === "added_lines" && "forbid_regex" in rule && Array.isArray(rule.forbid_regex)) violations.push(...checkRegexRule(files, rule as RegexContentRule));
    else if (rule.mode === "markdown_language") {
      for (const file of files) {
        if (file.status !== "deleted" && matchesAny(file.path, [(rule as MarkdownLanguageRule).glob || "**/*.md"])) {
          violations.push(...markdownLanguageViolations(file, rule as MarkdownLanguageRule, documents));
        }
      }
    }
  }
  return violations;
}

function formatViolation(violation: ContentViolation): string {
  return violation.kind === "language"
    ? `[${violation.rule_id}] ${violation.file}:${violation.line_number}: unapproved ${violation.language} prose words: ${violation.unapproved_words.join(", ")}`
    : `[${violation.rule_id}] ${violation.file}: "${violation.line}" matched /${violation.matched_regex}/`;
}

export const contentRuleFamily: RuleFamily = {
  id: "content-rules",
  evaluate(facts) {
    const typedFacts = facts as ContentRuleFacts;
    const violations = checkContentRules(typedFacts.diff.files.checked, typedFacts.policy.content_rules, {
      repoRoot: typedFacts.repositoryRoot, readFile: typedFacts.readFile, documents: typedFacts.documents,
    });
    return violations.length
      ? { name: "content-rules", check: { ok: false, violations, details: violations.map(formatViolation) } }
      : { name: "content-rules", check: { ok: true } };
  },
};
