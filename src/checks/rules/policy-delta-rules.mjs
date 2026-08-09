import { matchesAny } from "../../utils/path-patterns.mjs";
import { compareConstraintPrograms } from "../constraint-program.mjs";
import { expandGovernancePatterns } from "./governance-paths.mjs";

const asArray = (value) => Array.isArray(value) ? value : [];

export const comparePolicyStrictness = compareConstraintPrograms;

export function computePolicyDelta(basePolicy, headPolicy) {
  if (!basePolicy || !headPolicy) return { relaxations: [] };
  const compared = compareConstraintPrograms(basePolicy, headPolicy);
  return { relaxations: [...compared.relaxations, ...compared.incomparable] };
}

const DEFAULT_PROTECTED_SURFACES = ["source", "tests", "schemas"];
function protectedSurfacePatterns(basePolicy, configured = null) {
  const names = configured?.length ? configured : DEFAULT_PROTECTED_SURFACES;
  return [...new Set(names.flatMap((name) => asArray(basePolicy?.surfaces?.[name])))];
}
function isGovernanceFile(path, policy) {
  return path === "repo-policy.json" || matchesAny(path, expandGovernancePatterns(asArray(policy?.paths?.governance_paths)));
}

export function classifyChangedFiles(files, basePolicy, configuredProtectedSurfaces = null) {
  const protectedPatterns = protectedSurfacePatterns(basePolicy, configuredProtectedSurfaces);
  const protectedFiles = [], governanceFiles = [], otherFiles = [];
  for (const file of files) {
    if (isGovernanceFile(file.path, basePolicy)) governanceFiles.push(file.path);
    else if (protectedPatterns.length && matchesAny(file.path, protectedPatterns)) protectedFiles.push(file.path);
    else otherFiles.push(file.path);
  }
  return { protectedFiles, governanceFiles, otherFiles, protectedPatterns };
}

function pointerCovers(authorizationPointer, deltaPointer) {
  if (typeof authorizationPointer !== "string" || typeof deltaPointer !== "string") return false;
  if (authorizationPointer === deltaPointer || deltaPointer.startsWith(`${authorizationPointer}/`)) return true;
  if (!authorizationPointer.endsWith("/*")) return false;
  const prefix = authorizationPointer.slice(0, -2);
  const remainder = deltaPointer.startsWith(`${prefix}/`) ? deltaPointer.slice(prefix.length + 1) : null;
  return remainder !== null && remainder.split("/").length <= 2;
}

function trustedIssueAuthorizationCoversRelaxation(issueAuthorization, relaxations) {
  if (!issueAuthorization) return { ok: false, reason: "no_linked_issue_authorization" };
  const allowed = asArray(issueAuthorization.allow_policy_relaxation);
  if (!allowed.length) return { ok: false, reason: "linked_issue_missing_allow_policy_relaxation" };
  const uncovered = relaxations.map((item) => item.pointer).filter((pointer) => !allowed.some((entry) => pointerCovers(entry, pointer)));
  return uncovered.length
    ? { ok: false, reason: "linked_issue_allow_policy_relaxation_does_not_cover_all_pointers", uncovered_pointers: uncovered, allowed_pointers: allowed }
    : { ok: true, allowed_pointers: allowed };
}

function summarizeTrustedAuthorizer(authorizer) {
  if (!authorizer || typeof authorizer !== "object") return { trusted: false, reasons: ["trusted_authorizer_missing"] };
  const sources = [];
  if (authorizer.issue_author_permission_trusted) sources.push("issue_author_permission");
  if (authorizer.governance_approved_label) sources.push("governance_approved_label");
  if (authorizer.codeowner_approved) sources.push("codeowner_approval");
  if (authorizer.trusted_team_approval) sources.push("trusted_team_approval");
  return sources.length
    ? { trusted: true, reasons: [], detected_sources: sources }
    : { trusted: false, reasons: ["no_trusted_authorization_source"], detected_sources: [] };
}

export function checkPolicyRelaxation({
  basePolicy,
  headPolicy,
  changedFiles,
  trustedAuthorizer,
  issueAuthorization,
  contractChangeType,
  configuredProtectedSurfaces = null,
}) {
  if (!basePolicy || !headPolicy) return { ok: true };
  const { relaxations } = computePolicyDelta(basePolicy, headPolicy);
  if (!relaxations.length) return { ok: true, policy_relaxations: [] };

  const classified = classifyChangedFiles(changedFiles, basePolicy, configuredProtectedSurfaces);
  const authorizer = summarizeTrustedAuthorizer(trustedAuthorizer);
  const issueAuth = trustedIssueAuthorizationCoversRelaxation(issueAuthorization, relaxations);
  const reasons = [...authorizer.reasons];
  if (!issueAuth.ok) reasons.push(issueAuth.reason);
  const governanceOnly = !classified.protectedFiles.length && !classified.otherFiles.length && classified.governanceFiles.length > 0;
  if (!governanceOnly) reasons.push("policy_relaxation_mixed_with_non_governance_changes");
  if (contractChangeType && contractChangeType !== "governance") reasons.push("contract_change_type_is_not_governance");
  const details = relaxations.map((item) => `- ${item.pointer}: ${item.message}`);
  if (!governanceOnly && classified.protectedFiles.length) {
    details.push(`Mixed with protected-surface changes: ${classified.protectedFiles.slice(0, 10).join(", ")}${classified.protectedFiles.length > 10 ? `, +${classified.protectedFiles.length - 10} more` : ""}`);
  }
  if (authorizer.reasons.length) details.push(`trusted_authorizer: ${authorizer.reasons.join(", ")}`);
  const ok = reasons.length === 0;
  return {
    ok,
    message: ok ? undefined : "PR attempts to relax trusted repository policy",
    policy_relaxations: relaxations,
    details,
    blocked_reasons: reasons,
    governance_only: governanceOnly,
    protected_files: classified.protectedFiles,
    governance_files: classified.governanceFiles,
    other_files: classified.otherFiles,
    protected_patterns: classified.protectedPatterns,
    trusted_authorizer: authorizer,
    hint: ok ? undefined : "Policy relaxation must be a dedicated governance change, authorized by a trusted maintainer/code owner, with change_type governance and all relaxed pointers listed in linked-issue allow_policy_relaxation.",
  };
}

export const policyRelaxationRuleFamily = {
  id: "policy-delta",
  applies: (facts) => Boolean(facts.basePolicy && facts.headPolicy),
  evaluate(facts) {
    return {
      name: "policy-relaxation",
      check: checkPolicyRelaxation({
        basePolicy: facts.basePolicy,
        headPolicy: facts.headPolicy,
        changedFiles: facts.diff.files.checked,
        trustedAuthorizer: facts.trustedAuthorizer,
        issueAuthorization: facts.issueAuthorization,
        contractChangeType: facts.contract?.change_type,
        configuredProtectedSurfaces: facts.basePolicy?.policy_delta_rules?.protected_surfaces,
      }),
    };
  },
};
