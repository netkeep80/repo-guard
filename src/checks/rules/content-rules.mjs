import { matchesAny } from "../../utils/path-patterns.mjs";
import { readRepositoryTextFile } from "../../utils/repository-files.mjs";

function checkRegexRule(files, rule) {
  const violations = [];
  const regexes = rule.forbid_regex.map((pattern) => new RegExp(pattern));
  const glob = rule.glob || "**";

  for (const file of files) {
    if (!matchesAny(file.path, [glob])) continue;
    for (const line of file.addedLines || []) {
      for (let i = 0; i < regexes.length; i++) {
        if (regexes[i].test(line)) {
          violations.push({
            kind: "regex",
            rule_id: rule.id,
            file: file.path,
            line: line.trim(),
            matched_regex: rule.forbid_regex[i],
          });
        }
      }
    }
  }
  return violations;
}

function stripMarkdownProse(line) {
  return line
    .replace(/`[^`]*`/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "");
}

function markdownLanguageViolations(file, rule, options = {}) {
  const content = readRepositoryTextFile(file.path, options);
  const allowed = new Set(rule.allow_words || []);
  const maxLatin = rule.max_unapproved_latin_words_per_line ?? 1;
  const violations = [];
  let inFence = false;

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const stripped = rawLine.trim();
    if (stripped.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = stripMarkdownProse(rawLine);
    const latin = [...line.matchAll(/(?<![\w])([A-Za-z][A-Za-z-]{2,})(?![\w])/g)]
      .map((match) => match[1])
      .filter((word) => !allowed.has(word));
    const hasCyrillic = /[А-Яа-яЁё]{3,}/.test(line);

    if (latin.length > maxLatin || (latin.length > 0 && !hasCyrillic)) {
      violations.push({
        kind: "language",
        rule_id: rule.id,
        file: file.path,
        line_number: index + 1,
        line: rawLine.trim(),
        language: rule.language,
        unapproved_words: latin,
      });
    }
  }
  return violations;
}

export function checkContentRules(files, rules = [], options = {}) {
  const violations = [];

  for (const rule of rules) {
    if (rule.mode === "added_lines" && rule.forbid_regex) {
      violations.push(...checkRegexRule(files, rule));
      continue;
    }

    if (rule.mode === "markdown_language") {
      const glob = rule.glob || "**/*.md";
      for (const file of files) {
        if (file.status === "deleted" || !matchesAny(file.path, [glob])) continue;
        violations.push(...markdownLanguageViolations(file, rule, options));
      }
    }
  }

  return violations;
}

function formatViolation(violation) {
  if (violation.kind === "language") {
    return `[${violation.rule_id}] ${violation.file}:${violation.line_number}: unapproved ${violation.language} prose words: ${violation.unapproved_words.join(", ")}`;
  }
  return `[${violation.rule_id}] ${violation.file}: "${violation.line}" matched /${violation.matched_regex}/`;
}

export const contentRuleFamily = {
  id: "content-rules",
  evaluate(facts) {
    const violations = checkContentRules(
      facts.diff.files.checked,
      facts.policy.content_rules,
      {
        repoRoot: facts.repositoryRoot,
        readFile: facts.readFile,
      }
    );
    if (violations.length > 0) {
      return {
        name: "content-rules",
        check: {
          ok: false,
          violations,
          details: violations.map(formatViolation),
        },
      };
    }

    return {
      name: "content-rules",
      check: { ok: true },
    };
  },
};
