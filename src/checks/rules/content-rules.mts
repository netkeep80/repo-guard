import type { DocumentReader, DocumentReaderOptions } from "../../document-facts.mjs";
import { createDocumentReader, stripMarkdownInline } from "../../document-facts.mjs";
import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";
import type { RuleFamily } from "../rule-registry.mjs";

interface ContentRule {
  id: string;
  mode: string;
  glob?: string;
  forbid_regex?: string[];
  require_regex?: string[];
  language?: string;
  allow_words?: string[];
  max_unapproved_latin_words_per_line?: number;
}

interface RegexViolation {
  kind: "regex";
  rule_id: string;
  file: string;
  line: string;
  matched_regex: string | undefined;
}

interface RequiredRegexViolation {
  kind: "required_regex";
  rule_id: string;
  file: string;
  required_regex?: string;
  reason: "missing_target" | "missing_pattern" | "read_error";
}

interface LanguageViolation {
  kind: "language";
  rule_id: string;
  file: string;
  line_number: number;
  line: string;
  language: string | undefined;
  unapproved_words: string[];
}

type ContentViolation = RegexViolation | RequiredRegexViolation | LanguageViolation;

interface ContentRuleOptions extends DocumentReaderOptions {
  documents?: DocumentReader;
  trackedFiles?: readonly string[];
}

interface ContentRuleFacts {
  diff: { files: { checked: ParsedDiffFile[] } };
  policy: { content_rules: ContentRule[] };
  repositoryRoot?: string;
  readFile?: DocumentReaderOptions["readFile"];
  documents: DocumentReader;
  trackedFiles?: string[];
}

function checkRegexRule(files: ParsedDiffFile[], rule: ContentRule): RegexViolation[] {
  const violations: RegexViolation[] = [];
  const regexes = rule.forbid_regex!.map((pattern) => new RegExp(pattern));
  for (const file of files) {
    if (!matchesAny(file.path, [rule.glob || "**"])) continue;
    for (const line of file.addedLines || []) {
      regexes.forEach((regex, index) => {
        if (regex.test(line)) violations.push({
          kind: "regex", rule_id: rule.id, file: file.path, line: line.trim(), matched_regex: rule.forbid_regex![index],
        });
      });
    }
  }
  return violations;
}

function currentRepositoryPaths(files: ParsedDiffFile[], trackedFiles: readonly string[] = []): string[] {
  const deleted = new Set(files.filter((file) => file.status === "deleted").map((file) => file.path));
  return [...new Set([
    ...trackedFiles,
    ...files.filter((file) => file.status !== "deleted").map((file) => file.path),
  ])].filter((path) => !deleted.has(path)).sort();
}

function checkRequiredRegexRule(
  files: ParsedDiffFile[],
  rule: ContentRule,
  documents: DocumentReader,
  trackedFiles: readonly string[] = [],
): RequiredRegexViolation[] {
  const patterns = rule.require_regex || [];
  const candidates = currentRepositoryPaths(files, trackedFiles)
    .filter((path) => matchesAny(path, [rule.glob || "**"]));

  if (candidates.length === 0) {
    return [{
      kind: "required_regex",
      rule_id: rule.id,
      file: rule.glob || "**",
      reason: "missing_target",
    }];
  }

  const violations: RequiredRegexViolation[] = [];
  for (const path of candidates) {
    let content: string;
    try {
      content = documents.text(path);
    } catch {
      violations.push({
        kind: "required_regex",
        rule_id: rule.id,
        file: path,
        reason: "read_error",
      });
      continue;
    }

    patterns.forEach((pattern) => {
      if (!new RegExp(pattern).test(content)) {
        violations.push({
          kind: "required_regex",
          rule_id: rule.id,
          file: path,
          required_regex: pattern,
          reason: "missing_pattern",
        });
      }
    });
  }
  return violations;
}

function markdownLanguageViolations(file: ParsedDiffFile, rule: ContentRule, documents: DocumentReader): LanguageViolation[] {
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
    if (rule.mode === "added_lines" && rule.forbid_regex) violations.push(...checkRegexRule(files, rule));
    else if (rule.mode === "required_regex" && rule.require_regex) {
      violations.push(...checkRequiredRegexRule(files, rule, documents, options.trackedFiles));
    } else if (rule.mode === "markdown_language") {
      for (const file of files) {
        if (file.status !== "deleted" && matchesAny(file.path, [rule.glob || "**/*.md"])) {
          violations.push(...markdownLanguageViolations(file, rule, documents));
        }
      }
    }
  }
  return violations;
}

function formatViolation(violation: ContentViolation): string {
  if (violation.kind === "language") {
    return `[${violation.rule_id}] ${violation.file}:${violation.line_number}: unapproved ${violation.language} prose words: ${violation.unapproved_words.join(", ")}`;
  }
  if (violation.kind === "required_regex") {
    return violation.reason === "missing_pattern"
      ? `[${violation.rule_id}] ${violation.file}: required pattern /${violation.required_regex}/ is absent`
      : `[${violation.rule_id}] ${violation.file}: required content target is ${violation.reason === "missing_target" ? "missing" : "unreadable"}`;
  }
  return `[${violation.rule_id}] ${violation.file}: "${violation.line}" matched /${violation.matched_regex}/`;
}

export const contentRuleFamily: RuleFamily = {
  id: "content-rules",
  evaluate(facts) {
    const violations = checkContentRules((facts as ContentRuleFacts).diff.files.checked, (facts as ContentRuleFacts).policy.content_rules, {
      repoRoot: (facts as ContentRuleFacts).repositoryRoot, readFile: (facts as ContentRuleFacts).readFile, documents: (facts as ContentRuleFacts).documents,
      trackedFiles: (facts as ContentRuleFacts).trackedFiles,
    });
    return violations.length
      ? { name: "content-rules", check: { ok: false, violations, details: violations.map(formatViolation) } }
      : { name: "content-rules", check: { ok: true } };
  },
};
