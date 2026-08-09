import { matchesAny } from "../../utils/path-patterns.mjs";

const expand = (pattern) => typeof pattern !== "string" || !pattern ? [] : [pattern.endsWith("/") ? `${pattern}**` : pattern];
export function expandGovernancePatterns(patterns = []) {
  return [...new Set(patterns.flatMap(expand))];
}
const trusted = (authorizer) => Boolean(authorizer && (
  authorizer.issue_author_permission_trusted || authorizer.governance_approved_label || authorizer.codeowner_approved || authorizer.trusted_team_approval
));

export function checkGovernanceChangeAuthorization({ files, governancePaths, governanceGrant, trustedAuthorizer }) {
  if (!governancePaths?.length) return { ok: true };
  const touched = files.filter((file) => governancePaths.some((pattern) => matchesAny(file.path, expand(pattern)))).map((file) => file.path);
  if (!touched.length) return { ok: true, touched_governance_paths: [] };

  const declared = Array.isArray(governanceGrant?.authorized_governance_paths) ? governanceGrant.authorized_governance_paths : [];
  const sourceTrusted = trusted(trustedAuthorizer);
  const authorized = sourceTrusted ? declared : [];
  const unauthorized = touched.filter((path) => !matchesAny(path, expandGovernancePatterns(authorized)));
  const details = unauthorized.map((path) => `governance path ${path} changed without matching GovernanceGrant authorization`);
  if (declared.length && !sourceTrusted) details.push("GovernanceGrant is ignored because no trusted authorizer was detected");
  const ok = !unauthorized.length;
  return {
    ok,
    message: ok ? undefined : "governance paths changed without trusted GovernanceGrant",
    touched_governance_paths: touched,
    trusted_authorized_governance_paths: authorized,
    unauthorized_paths: unauthorized,
    untrusted_governance_grant_ignored: declared.length > 0 && !sourceTrusted,
    details,
    hint: ok ? undefined : "Add a repo-guard-grant block to the linked issue and have that issue sanctioned by a trusted maintainer or governance approval source.",
  };
}

export const governancePathsRuleFamily = {
  id: "governance-paths",
  applies(facts) {
    const paths = Array.isArray(facts.trustedGovernancePaths) ? facts.trustedGovernancePaths : facts.policy.paths?.governance_paths;
    return Boolean(paths?.length);
  },
  evaluate(facts) {
    const governancePaths = Array.isArray(facts.trustedGovernancePaths) ? facts.trustedGovernancePaths : facts.policy.paths?.governance_paths;
    return { name: "governance-change-authorization", check: checkGovernanceChangeAuthorization({
      files: facts.diff.files.checked, governancePaths, governanceGrant: facts.governanceGrant, trustedAuthorizer: facts.trustedAuthorizer,
    }) };
  },
};
