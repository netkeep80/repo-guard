import { parseJson, parseMarkdown, parseYaml } from "./document-facts.mjs";

const CONTRACT_FORMATS = { "repo-guard-json": "JSON", "repo-guard-yaml": "YAML" };

function parseBlock(block, formats, field) {
  try {
    const value = block.language.endsWith("json") ? parseJson(block.content) : parseYaml(block.content);
    return { ok: true, [field]: value };
  } catch (error) {
    const format = formats[block.language] || "YAML";
    return { ok: false, error: `${field}_malformed_${format.toLowerCase()}`, message: `Invalid ${format} in ${block.language} block: ${error.message}` };
  }
}

export function extractContract(markdown) {
  if (!markdown || typeof markdown !== "string") return { ok: false, error: "contract_not_found", message: "No markdown text provided" };
  const blocks = parseMarkdown(markdown).codeBlocks.filter((block) => CONTRACT_FORMATS[block.language]);
  if (!blocks.length) return { ok: false, error: "contract_not_found", message: "No repo-guard-json or repo-guard-yaml block found in markdown" };
  if (blocks.length > 1) return { ok: false, error: "multiple_contracts", message: `Found ${blocks.length} repo-guard contract blocks; expected exactly one` };
  return parseBlock(blocks[0], CONTRACT_FORMATS, "contract");
}

export function extractGovernanceGrant(markdown) {
  if (!markdown || typeof markdown !== "string") return { ok: true, grant: null };
  const blocks = parseMarkdown(markdown).codeBlocks.filter((block) => block.language === "repo-guard-grant");
  if (!blocks.length) return { ok: true, grant: null };
  if (blocks.length > 1) return { ok: false, error: "multiple_governance_grants", message: `Found ${blocks.length} repo-guard-grant blocks; expected at most one` };
  return parseBlock(blocks[0], { "repo-guard-grant": "YAML" }, "grant");
}

const ISSUE_LINK_RE = /(?:Fixes|Closes|Resolves)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
export function extractLinkedIssueNumbers(text) {
  if (!text || typeof text !== "string") return [];
  return [...new Set([...text.matchAll(ISSUE_LINK_RE)].map((match) => Number(match[1])))];
}

export function resolveContract(prBody, issueBody) {
  const direct = extractContract(prBody);
  if (direct.ok || direct.error !== "contract_not_found") return direct;
  if (!issueBody) return { ok: false, error: "contract_not_found", message: "No contract in PR body and no linked issue body available" };
  const fallback = extractContract(issueBody);
  if (fallback.ok) return fallback;
  return fallback.error === "contract_not_found"
    ? { ok: false, error: "fallback_missing", message: "No contract found in PR body or linked issue body" }
    : fallback;
}
