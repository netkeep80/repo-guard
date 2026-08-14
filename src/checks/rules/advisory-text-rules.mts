import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { uniqueSorted } from "../../utils/collections.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";
import { readRepositoryTextFile } from "../../utils/repository-files.mjs";
import type { RepositoryFileOptions } from "../../utils/repository-files.mjs";
import type { RuleFamily } from "../rule-registry.mjs";

export interface AdvisoryTextRules {
  canonical_files?: string[];
  warn_on_similarity_above?: number;
  max_reported_matches?: number;
}

interface AdvisoryTextOptions extends RepositoryFileOptions {
  allFiles?: string[];
}

interface MarkdownHeading {
  level: number;
  title: string;
  normalized: string;
}

export interface AdvisoryTextMatch {
  changed_file: string;
  canonical_file: string;
  score: number;
  threshold: number;
  duplicate_section_titles: string[];
  reason: "text_similarity" | "duplicate_section_title";
}

export interface AdvisoryTextCheckResult {
  ok: boolean;
  advisory?: true;
  message?: string;
  matches: AdvisoryTextMatch[];
  details?: string[];
  hint?: string;
}

interface AdvisoryRuleFacts {
  diff: { files: { checked: ParsedDiffFile[] } };
  policy: { advisory_text_rules?: AdvisoryTextRules | null };
  repositoryRoot?: string;
  trackedFiles?: string[];
  readFile?: (filePath: string) => unknown;
}

function stripMarkdownNoise(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ");
}

function markdownTokens(content: string): string[] {
  const normalized = stripMarkdownNoise(content)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  return normalized.split(/\s+/).filter((token) => token.length >= 3);
}

function tokenSet(content: string): Set<string> {
  return new Set(markdownTokens(content));
}

function jaccardScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function markdownHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      headings.push({
        level: match[1].length,
        title: match[2].trim(),
        normalized: match[2].trim().toLowerCase().replace(/\s+/g, " "),
      });
    }
  }
  return headings;
}

export function checkAdvisoryTextRules(files: ParsedDiffFile[], rules: AdvisoryTextRules | null | undefined, options: AdvisoryTextOptions = {}): AdvisoryTextCheckResult {
  if (!rules) return { ok: true, matches: [] };

  const canonicalPatterns = rules.canonical_files || [];
  const changedMarkdown = files.filter(
    (file) => file.status !== "deleted" && file.path.match(/\.md$/i)
  );
  if (changedMarkdown.length === 0 || canonicalPatterns.length === 0) {
    return { ok: true, matches: [] };
  }

  const threshold = rules.warn_on_similarity_above ?? 0.7;
  const maxReported = rules.max_reported_matches ?? 3;
  const canonicalFiles = uniqueSorted(options.allFiles || []);
  const results: AdvisoryTextMatch[] = [];
  const readErrors: string[] = [];

  for (const changed of changedMarkdown) {
    let changedContent: string;
    try {
      changedContent = readRepositoryTextFile(changed.path, options);
    } catch (error) {
      readErrors.push(`${changed.path}: ${(error as Error).message}`);
      continue;
    }

    const changedTokens = tokenSet(changedContent);
    const changedHeadings = markdownHeadings(changedContent);
    const changedHeadingSet = new Set(changedHeadings.map((heading) => heading.normalized));

    for (const canonicalPath of canonicalFiles) {
      if (canonicalPath === changed.path) continue;
      if (!canonicalPath.match(/\.md$/i)) continue;
      if (!matchesAny(canonicalPath, canonicalPatterns)) continue;

      let canonicalContent: string;
      try {
        canonicalContent = readRepositoryTextFile(canonicalPath, options);
      } catch (error) {
        readErrors.push(`${canonicalPath}: ${(error as Error).message}`);
        continue;
      }

      const score = jaccardScore(changedTokens, tokenSet(canonicalContent));
      const canonicalHeadings = markdownHeadings(canonicalContent);
      const duplicateHeadings = uniqueSorted(
        canonicalHeadings
          .filter((heading) => changedHeadingSet.has(heading.normalized))
          .map((heading) => heading.title)
      );

      if (score >= threshold || duplicateHeadings.length > 0) {
        results.push({
          changed_file: changed.path,
          canonical_file: canonicalPath,
          score: Number(score.toFixed(3)),
          threshold,
          duplicate_section_titles: duplicateHeadings,
          reason: score >= threshold ? "text_similarity" : "duplicate_section_title",
        });
      }
    }
  }

  results.sort((left, right) =>
    right.score - left.score ||
    left.changed_file.localeCompare(right.changed_file) ||
    left.canonical_file.localeCompare(right.canonical_file)
  );

  const matches = results.slice(0, maxReported);
  const details = matches.map((match) => {
    const sections = match.duplicate_section_titles.length > 0
      ? `; duplicate sections: ${match.duplicate_section_titles.join(", ")}`
      : "";
    return `${match.changed_file} overlaps ${match.canonical_file} (score ${match.score}, threshold ${match.threshold}${sections})`;
  });

  return {
    ok: matches.length === 0,
    advisory: true,
    message: matches.length > 0 ? "heuristic markdown duplication advisory" : undefined,
    matches,
    details: [...details, ...readErrors.map((error) => `read warning: ${error}`)],
    hint: matches.length > 0
      ? "Review whether the changed markdown should update the canonical source instead of duplicating policy prose."
      : undefined,
  };
}

export const advisoryTextRuleFamily: RuleFamily = {
  id: "advisory-text-rules",
  evaluate(facts) {
    return {
      name: "advisory-text-rules",
      check: checkAdvisoryTextRules((facts as AdvisoryRuleFacts).diff.files.checked, (facts as AdvisoryRuleFacts).policy.advisory_text_rules, {
        repoRoot: (facts as AdvisoryRuleFacts).repositoryRoot,
        allFiles: (facts as AdvisoryRuleFacts).trackedFiles,
        readFile: (facts as AdvisoryRuleFacts).readFile,
      }),
    };
  },
};
