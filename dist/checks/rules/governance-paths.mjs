import { diffFilePathIdentities } from "../../diff/filters.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";
const expand = (pattern) => typeof pattern !== "string" || !pattern ? [] : [pattern.endsWith("/") ? `${pattern}**` : pattern];
export function expandGovernancePatterns(patterns = []) {
    return [...new Set(patterns.flatMap(expand))];
}
const trusted = (authorizer) => authorizer?.trusted === true && authorizer.source === "repository_permission";
const uniqueSorted = (paths) => [...new Set(paths)].sort();
export function checkGovernanceChangeAuthorization({ files, governancePaths, governanceGrant, trustedAuthorizer, changeIntentType = null }) {
    const patterns = expandGovernancePatterns(governancePaths || []), governanceChange = changeIntentType === "governance";
    const matchesBoundary = (path) => matchesAny(path, patterns);
    if (!patterns.length && !governanceChange)
        return { ok: true };
    const identities = files.flatMap(diffFilePathIdentities);
    const touched = uniqueSorted(identities.filter(matchesBoundary));
    const declared = Array.isArray(governanceGrant?.authorized_governance_paths) ? governanceGrant.authorized_governance_paths : [];
    const sourceTrusted = trusted(trustedAuthorizer), authorized = sourceTrusted ? declared : [];
    const atomicGovernanceCutover = governanceChange
        && governanceGrant?.allow_atomic_governance_cutover === true
        && sourceTrusted;
    const nonGovernance = governanceChange && !atomicGovernanceCutover
        ? uniqueSorted(identities.filter((path) => !matchesBoundary(path)))
        : [];
    if (!governanceChange && !touched.length)
        return { ok: true, touched_governance_paths: [] };
    const unauthorized = touched.filter((path) => !matchesAny(path, expandGovernancePatterns(authorized)));
    const details = [
        ...nonGovernance.map((path) => `governance ChangeIntent cannot change non-governance path ${path}`),
        ...unauthorized.map((path) => `governance path ${path} changed without matching GovernanceGrant authorization`),
    ];
    if (atomicGovernanceCutover)
        details.push("Trusted atomic governance cutover permits scoped non-governance files");
    if (declared.length && !sourceTrusted)
        details.push("GovernanceGrant is ignored because positive repository permission authority was not established");
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
        hint: ok ? undefined : "Use a dedicated governance-only diff, or a trusted atomic governance cutover, and authorize every touched governance path from a linked-issue GovernanceGrant whose human author has positive write/maintain/admin repository permission.",
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
                files: facts.diff.files.all, governancePaths, governanceGrant: facts.governanceGrant, trustedAuthorizer: facts.trustedAuthorizer,
                changeIntentType: facts.changeIntent?.change_type,
            }) };
    },
};
