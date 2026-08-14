import type { MarkdownCodeBlock } from "./document-facts.mjs";
import { parseJson, parseMarkdown, parseYaml } from "./document-facts.mjs";

const CHANGE_INTENT_FORMATS = { "repo-guard-json": "JSON", "repo-guard-yaml": "YAML" } as const;

type ExtractionFailure = { ok: false; error: string; message: string };
type ChangeIntentSuccess = { ok: true; changeIntent: unknown };
type GovernanceGrantSuccess = { ok: true; grant: unknown | null };
export type ChangeIntentExtraction = ChangeIntentSuccess | ExtractionFailure;
export type GovernanceGrantExtraction = GovernanceGrantSuccess | ExtractionFailure;

function parseBlock<Field extends string>(block: MarkdownCodeBlock, formats: Readonly<Record<string, string>>, field: Field, errorPrefix = field): ({ ok: true } & Record<Field, unknown>) | ExtractionFailure {
  try {
    const value = block.language.endsWith("json") ? parseJson(block.content) : parseYaml(block.content);
    return { ok: true, [field]: value } as { ok: true } & Record<Field, unknown>;
  } catch (error: unknown) {
    const format = formats[block.language] || "YAML";
    return { ok: false, error: `${errorPrefix}_malformed_${format.toLowerCase()}`, message: `Invalid ${format} in ${block.language} block: ${(error as Error).message}` };
  }
}

export function extractChangeIntent(markdown: unknown): ChangeIntentExtraction {
  if (!markdown || typeof markdown !== "string") return { ok: false, error: "change_intent_not_found", message: "No markdown text provided" };
  const blocks = parseMarkdown(markdown).codeBlocks.filter((block) => CHANGE_INTENT_FORMATS[block.language as keyof typeof CHANGE_INTENT_FORMATS]);
  if (!blocks.length) return { ok: false, error: "change_intent_not_found", message: "No repo-guard-json or repo-guard-yaml ChangeIntent block found in markdown" };
  if (blocks.length > 1) return { ok: false, error: "multiple_change_intents", message: `Found ${blocks.length} repo-guard ChangeIntent blocks; expected exactly one` };
  return parseBlock(blocks[0]!, CHANGE_INTENT_FORMATS, "changeIntent", "change_intent");
}

export function extractGovernanceGrant(markdown: unknown): GovernanceGrantExtraction {
  if (!markdown || typeof markdown !== "string") return { ok: true, grant: null };
  const blocks = parseMarkdown(markdown).codeBlocks.filter((block) => block.language === "repo-guard-grant");
  if (!blocks.length) return { ok: true, grant: null };
  if (blocks.length > 1) return { ok: false, error: "multiple_governance_grants", message: `Found ${blocks.length} repo-guard-grant blocks; expected at most one` };
  return parseBlock(blocks[0]!, { "repo-guard-grant": "YAML" }, "grant");
}

const ISSUE_LINK_RE = /(?:Fixes|Closes|Resolves)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
export function extractLinkedIssueNumbers(text: unknown): number[] {
  if (!text || typeof text !== "string") return [];
  return [...new Set([...text.matchAll(ISSUE_LINK_RE)].map((match) => Number(match[1])))];
}

export function resolveChangeIntent(prBody: unknown, issueBody: unknown): ChangeIntentExtraction {
  const direct = extractChangeIntent(prBody);
  if (direct.ok || direct.error !== "change_intent_not_found") return direct;
  if (!issueBody) return { ok: false, error: "change_intent_not_found", message: "No ChangeIntent in PR body and no linked issue body available" };
  const fallback = extractChangeIntent(issueBody);
  if (fallback.ok) return fallback;
  return fallback.error === "change_intent_not_found"
    ? { ok: false, error: "fallback_missing", message: "No ChangeIntent found in PR body or linked issue body" }
    : fallback;
}
