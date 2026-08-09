import { parseJson, parseMarkdown, parseYaml } from "./document-facts.mjs";

const FORMAT_LABELS = { "repo-guard-json": "JSON", "repo-guard-yaml": "YAML" };

function parseContractBlock(block) {
  try {
    return {
      ok: true,
      contract: block.language === "repo-guard-json" ? parseJson(block.content) : parseYaml(block.content),
    };
  } catch (error) {
    const format = FORMAT_LABELS[block.language];
    return {
      ok: false,
      error: `contract_malformed_${format.toLowerCase()}`,
      message: `Invalid ${format} in ${block.language} block: ${error.message}`,
    };
  }
}

export function extractContract(markdown) {
  if (!markdown || typeof markdown !== "string") return { ok: false, error: "contract_not_found", message: "No markdown text provided" };
  const parsed = parseMarkdown(markdown);
  const blocks = parsed.codeBlocks.filter((block) => FORMAT_LABELS[block.language]);
  if (blocks.length === 0) return { ok: false, error: "contract_not_found", message: "No repo-guard-json or repo-guard-yaml block found in markdown" };
  if (blocks.length > 1) return { ok: false, error: "multiple_contracts", message: `Found ${blocks.length} repo-guard contract blocks; expected exactly one` };
  return parseContractBlock(blocks[0]);
}

const ISSUE_LINK_RE = /(?:Fixes|Closes|Resolves)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
export function extractLinkedIssueNumbers(text) {
  if (!text || typeof text !== "string") return [];
  return [...new Set([...text.matchAll(ISSUE_LINK_RE)].map((match) => parseInt(match[1], 10)))];
}

export function resolveContract(prBody, issueBody) {
  const prResult = extractContract(prBody);
  if (prResult.ok || prResult.error !== "contract_not_found") return prResult;
  if (!issueBody) return { ok: false, error: "contract_not_found", message: "No contract in PR body and no linked issue body available" };
  const issueResult = extractContract(issueBody);
  if (issueResult.ok) return issueResult;
  return issueResult.error === "contract_not_found"
    ? { ok: false, error: "fallback_missing", message: "No contract found in PR body or linked issue body" }
    : issueResult;
}

const PRIVILEGED_AUTHORIZATION_FIELDS = ["authorized_governance_paths", "allow_policy_relaxation"];
const SCHEMA_UNKNOWN_PRIVILEGED_FIELDS = ["allow_policy_relaxation"];

export function extractIssueAuthorization(issueBody) {
  if (!issueBody) return null;
  const result = extractContract(issueBody);
  if (!result.ok) return null;
  const authorization = {};
  for (const field of PRIVILEGED_AUTHORIZATION_FIELDS) {
    if (Object.hasOwn(result.contract, field)) authorization[field] = result.contract[field];
  }
  return Object.keys(authorization).length ? authorization : null;
}

export function stripPrivilegedSchemaUnknownFields(contract) {
  if (!contract || typeof contract !== "object") return contract;
  let copy = null;
  for (const field of SCHEMA_UNKNOWN_PRIVILEGED_FIELDS) {
    if (!Object.hasOwn(contract, field)) continue;
    copy ||= { ...contract };
    delete copy[field];
  }
  return copy || contract;
}
