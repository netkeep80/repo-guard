import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";
import type { RuleFamily } from "../rule-registry.mjs";

interface GovernanceGrantProjection {
  authorized_governance_paths?: unknown;
  allow_atomic_governance_cutover?: unknown;
}

interface TrustedAuthorizerProjection {
  issue_author_permission_trusted?: unknown;
  governance_approved_label?: unknown;
  codeowner_approved?: unknown;
  trusted_team_approval?: unknown;
}

interface GovernanceCheckInput {
  files: ParsedDiffFile[];
  governancePaths?: string[] | null;
  governanceGrant?: GovernanceGrantProjection | null;
  trustedAuthorizer?: TrustedAuthorizerProjection | null;
  changeIntentType?: string | null;
}

interface GovernanceCheckResult {
  ok: boolean;
  message?: string;
  touched_governance_paths?: string[];
  non_governance_paths?: string[];
  trusted_authorized_governance_paths?: string[];
  unauthorized_paths?: string[];
  untrusted_governance_grant_ignored?: boolean;
  atomic_governance_cutover?: boolean;
  details?: string[];
  hint?: string;
}

interface GovernanceRuleFacts {
  trustedGovernancePaths?: unknown;
  policy: { paths?: { governance_paths?: string[] } };
  changeIntent?: { change_type?: string } | null;
  diff: { files: { checked: ParsedDiffFile[] } };
  governanceGrant?: GovernanceGrantProjection | null;
  trustedAuthorizer?: TrustedAuthorizerProjection | null;
}

const expand = (pattern: unknown): string[] => typeof pattern !== "string" || !pattern ? [] : [pattern.endsWith("/") ? `${pattern}**` : pattern];
export function expandGovernancePatterns(patterns: unknown[] = []): string[] {
  return [...new Set(patterns.flatMap(expand))];
}
const trusted = (authorizer: TrustedAuthorizerProjection | null | undefined): boolean => Boolean(authorizer && (
  authorizer.issue_author_permission_trusted || authorizer.governance_approved_label || authorizer.codeowner_approved || authorizer.trusted_team_approval
));

export function checkGovernanceChangeAuthorization({ files, governancePaths, governanceGrant, trustedAuthorizer, changeIntentType = null }: GovernanceCheckInput): GovernanceCheckResult {
  const patterns = expandGovernancePatterns(governancePaths || []), governanceChange = changeIntentType === "governance";
  const matchesBoundary = (path: string): boolean => matchesAny(path, patterns);
  if (!patterns.length && !governanceChange) return { ok: true };

  const touched = files.filter((file) => matchesBoundary(file.path)).map((file) => file.path);
  const declared = Array.isArray(governanceGrant?.authorized_governance_paths) ? governanceGrant.authorized_governance_paths as string[] : [];
  const sourceTrusted = trusted(trustedAuthorizer), authorized = sourceTrusted ? declared : [];
  // Mixed files are allowed only for an explicitly trusted atomic cutover.
  // This does not authorize governance files themselves: those still require
  // matching authorized_governance_paths below, and ordinary scope/must-not
  // rules remain independent vetoes.
  const atomicGovernanceCutover = governanceChange
    && governanceGrant?.allow_atomic_governance_cutover === true
    && sourceTrusted;
  const nonGovernance = governanceChange && !atomicGovernanceCutover
    ? files.filter((file) => !matchesBoundary(file.path)).map((file) => file.path)
    : [];
  if (!governanceChange && !touched.length) return { ok: true, touched_governance_paths: [] };

  const unauthorized = touched.filter((path) => !matchesAny(path, expandGovernancePatterns(authorized)));
  const details = [
    ...nonGovernance.map((path) => `governance ChangeIntent cannot change non-governance path ${path}`),
    ...unauthorized.map((path) => `governance path ${path} changed without matching GovernanceGrant authorization`),
  ];
  if (atomicGovernanceCutover) details.push("Trusted atomic governance cutover permits scoped non-governance files");
  if (declared.length && !sourceTrusted) details.push("GovernanceGrant is ignored because no trusted authorizer was detected");
  const ok = !nonGovernance.length && !unauthorized.length;
  return {
    ok,
    message: ok ? undefined : governanceChange && nonGovernance.length
      ? "governance ChangeIntent includes files outside trusted governance paths"
      : "governance paths changed without trusted GovernanceGrant",
    touched_governance_paths: touched,
    non_governance_paths: nonGovernance,
    trusted_authorized_governance_paths: authorized,
    unauthorized_paths: unauthorized,
    untrusted_governance_grant_ignored: declared.length > 0 && !sourceTrusted,
    atomic_governance_cutover: atomicGovernanceCutover,
    details,
    hint: ok ? undefined : "Use a dedicated governance-only diff, or a trusted atomic governance cutover, and authorize every touched governance path from a trusted linked-issue GovernanceGrant.",
  };
}

export const governancePathsRuleFamily: RuleFamily = {
  id: "governance-paths",
  applies(facts) {
    const paths = Array.isArray((facts as GovernanceRuleFacts).trustedGovernancePaths) ? (facts as GovernanceRuleFacts).trustedGovernancePaths as string[] : (facts as GovernanceRuleFacts).policy.paths?.governance_paths;
    return Boolean(paths?.length) || (facts as GovernanceRuleFacts).changeIntent?.change_type === "governance";
  },
  evaluate(facts) {
    const governancePaths = Array.isArray((facts as GovernanceRuleFacts).trustedGovernancePaths) ? (facts as GovernanceRuleFacts).trustedGovernancePaths as string[] : (facts as GovernanceRuleFacts).policy.paths?.governance_paths;
    return { name: "governance-change-authorization", check: checkGovernanceChangeAuthorization({
      files: (facts as GovernanceRuleFacts).diff.files.checked, governancePaths, governanceGrant: (facts as GovernanceRuleFacts).governanceGrant, trustedAuthorizer: (facts as GovernanceRuleFacts).trustedAuthorizer,
      changeIntentType: (facts as GovernanceRuleFacts).changeIntent?.change_type,
    }) };
  },
};
