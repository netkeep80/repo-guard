import { matchesAny } from "../../utils/path-patterns.mjs";
import { compareConstraintPrograms } from "../constraint-program.mjs";
import { expandGovernancePatterns } from "./governance-paths.mjs";

const array = (value) => Array.isArray(value) ? value : [];
export const comparePolicyStrictness = compareConstraintPrograms;
export function computePolicyDelta(basePolicy, headPolicy) {
  if (!basePolicy || !headPolicy) return { relaxations: [] };
  const compared = compareConstraintPrograms(basePolicy, headPolicy);
  return { relaxations: [...compared.relaxations, ...compared.incomparable] };
}

const DEFAULT_PROTECTED_SURFACES = ["source", "tests", "schemas"];
function protectedPatterns(policy, configured) {
  return [...new Set((configured?.length ? configured : DEFAULT_PROTECTED_SURFACES).flatMap((name) => array(policy?.surfaces?.[name])))];
}
const governanceFile = (path, policy) => path === "repo-policy.json" || matchesAny(path, expandGovernancePatterns(array(policy?.paths?.governance_paths)));
export function classifyChangedFiles(files, basePolicy, configured = null) {
  const patterns = protectedPatterns(basePolicy, configured), protectedFiles = [], governanceFiles = [], otherFiles = [];
  for (const file of files) {
    if (governanceFile(file.path, basePolicy)) governanceFiles.push(file.path);
    else if (patterns.length && matchesAny(file.path, patterns)) protectedFiles.push(file.path);
    else otherFiles.push(file.path);
  }
  return { protectedFiles, governanceFiles, otherFiles, protectedPatterns: patterns };
}

function pointerCovers(grant, delta) {
  if (typeof grant !== "string" || typeof delta !== "string") return false;
  if (grant === delta || delta.startsWith(`${grant}/`)) return true;
  if (!grant.endsWith("/*")) return false;
  const prefix = grant.slice(0, -2), remainder = delta.startsWith(`${prefix}/`) ? delta.slice(prefix.length + 1) : null;
  return remainder !== null && remainder.split("/").length <= 2;
}
function grantCoversRelaxation(governanceGrant, relaxations) {
  if (!governanceGrant) return { ok: false, reason: "governance_grant_missing" };
  const allowed = array(governanceGrant.allow_policy_relaxation);
  if (!allowed.length) return { ok: false, reason: "governance_grant_missing_allow_policy_relaxation" };
  const uncovered = relaxations.map((item) => item.pointer).filter((pointer) => !allowed.some((entry) => pointerCovers(entry, pointer)));
  return uncovered.length
    ? { ok: false, reason: "governance_grant_does_not_cover_all_relaxations", uncovered_pointers: uncovered, allowed_pointers: allowed }
    : { ok: true, allowed_pointers: allowed };
}
function trust(authorizer) {
  if (!authorizer) return { trusted: false, reasons: ["trusted_authorizer_missing"] };
  const sources = [
    authorizer.issue_author_permission_trusted && "issue_author_permission",
    authorizer.governance_approved_label && "governance_approved_label",
    authorizer.codeowner_approved && "codeowner_approval",
    authorizer.trusted_team_approval && "trusted_team_approval",
  ].filter(Boolean);
  return sources.length ? { trusted: true, reasons: [], detected_sources: sources } : { trusted: false, reasons: ["no_trusted_authorization_source"], detected_sources: [] };
}

export function checkPolicyRelaxation({
  basePolicy, headPolicy, changedFiles, trustedAuthorizer, governanceGrant,
  contractChangeType, configuredProtectedSurfaces = null,
}) {
  if (!basePolicy || !headPolicy) return { ok: true };
  const { relaxations } = computePolicyDelta(basePolicy, headPolicy);
  if (!relaxations.length) return { ok: true, policy_relaxations: [] };
  const classified = classifyChangedFiles(changedFiles, basePolicy, configuredProtectedSurfaces);
  const authorizer = trust(trustedAuthorizer), grant = grantCoversRelaxation(governanceGrant, relaxations);
  const reasons = [...authorizer.reasons];
  if (!grant.ok) reasons.push(grant.reason);
  const governanceOnly = !classified.protectedFiles.length && !classified.otherFiles.length && classified.governanceFiles.length > 0;
  if (!governanceOnly) reasons.push("policy_relaxation_mixed_with_non_governance_changes");
  if (contractChangeType && contractChangeType !== "governance") reasons.push("contract_change_type_is_not_governance");
  const details = relaxations.map((item) => `- ${item.pointer}: ${item.message}`);
  if (!governanceOnly && classified.protectedFiles.length) details.push(`Mixed with protected-surface changes: ${classified.protectedFiles.slice(0, 10).join(", ")}`);
  if (authorizer.reasons.length) details.push(`trusted_authorizer: ${authorizer.reasons.join(", ")}`);
  const ok = !reasons.length;
  return {
    ok, message: ok ? undefined : "PR attempts to relax trusted repository policy", policy_relaxations: relaxations,
    details, blocked_reasons: reasons, governance_only: governanceOnly, protected_files: classified.protectedFiles,
    governance_files: classified.governanceFiles, other_files: classified.otherFiles, protected_patterns: classified.protectedPatterns,
    trusted_authorizer: authorizer,
    hint: ok ? undefined : "Policy relaxation requires a dedicated governance change and a trusted linked-issue GovernanceGrant covering every relaxed pointer.",
  };
}

export const policyRelaxationRuleFamily = {
  id: "policy-delta",
  applies: (facts) => Boolean(facts.basePolicy && facts.headPolicy),
  evaluate: (facts) => ({ name: "policy-relaxation", check: checkPolicyRelaxation({
    basePolicy: facts.basePolicy, headPolicy: facts.headPolicy, changedFiles: facts.diff.files.checked,
    trustedAuthorizer: facts.trustedAuthorizer, governanceGrant: facts.governanceGrant,
    contractChangeType: facts.contract?.change_type, configuredProtectedSurfaces: facts.basePolicy?.policy_delta_rules?.protected_surfaces,
  }) }),
};
