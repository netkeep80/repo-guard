import { matchesAny } from "../../utils/path-patterns.mjs";

const expand = (pattern) => typeof pattern !== "string" || !pattern ? [] : [pattern.endsWith("/") ? `${pattern}**` : pattern];
export function expandGovernancePatterns(patterns = []) {
  return [...new Set(patterns.flatMap(expand))];
}
const trusted = (authorizer) => Boolean(authorizer && (
  authorizer.issue_author_permission_trusted || authorizer.governance_approved_label || authorizer.codeowner_approved || authorizer.trusted_team_approval
));

export function checkGovernanceChangeAuthorization({ files, governancePaths, governanceGrant, trustedAuthorizer, changeIntentType = null }) {
  const patterns = expandGovernancePatterns(governancePaths || []), governanceChange = changeIntentType === "governance";
  const matchesBoundary = (path) => patterns.some((pattern) => matchesAny(path, pattern));
  if (!patterns.length && !governanceChange) return { ok: true };

  const touched = files.filter((file) => matchesBoundary(file.path)).map((file) => file.path);
  const nonGovernance = governanceChange ? files.filter((file) => !matchesBoundary(file.path)).map((file) => file.path) : [];
  const declared = Array.isArray(governanceGrant?.authorized_governance_paths) ? governanceGrant.authorized_governance_paths : [];
  const sourceTrusted = trusted(trustedAuthorizer), authorized = sourceTrusted ? declared : [];
  const unauthorized = touched.filter((path) => !matchesAny(path, expandGovernancePatterns(authorized)));
  const details = [
    ...nonGovernance.map((path) => `governance ChangeIntent cannot change non-governance path ${path}`),
    ...unauthorized.map((path) => `governance path ${path} changed without matching GovernanceGrant authorization`),
  ];
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
    details,
    hint: ok ? undefined : "Use a dedicated governance-only diff and authorize every touched governance path from a trusted linked-issue GovernanceGrant.",
  };
}

export const governancePathsRuleFamily = {
  id: "governance-paths",
  applies(facts) {
    const paths = Array.isArray(facts.trustedGovernancePaths) ? facts.trustedGovernancePaths : facts.policy.paths?.governance_paths;
    return Boolean(paths?.length) || facts.changeIntent?.change_type === "governance";
  },
  evaluate(facts) {
    const governancePaths = Array.isArray(facts.trustedGovernancePaths) ? facts.trustedGovernancePaths : facts.policy.paths?.governance_paths;
    return { name: "governance-change-authorization", check: checkGovernanceChangeAuthorization({
      files: facts.diff.files.checked, governancePaths, governanceGrant: facts.governanceGrant, trustedAuthorizer: facts.trustedAuthorizer,
      changeIntentType: facts.changeIntent?.change_type,
    }) };
  },
};
