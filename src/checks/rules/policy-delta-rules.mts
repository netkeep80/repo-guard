import type { ParsedDiffFile } from "../../diff/parser.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";
import { compareConstraintPrograms } from "../constraint-program.mjs";
import type { RuleFamily } from "../rule-registry.mjs";
import { expandGovernancePatterns } from "./governance-paths.mjs";

interface PolicyProjection {
  surfaces?: Record<string, unknown>;
  paths?: { governance_paths?: unknown };
  policy_delta_rules?: { protected_surfaces?: string[] };
}

interface PolicyRelaxation {
  pointer: string;
  message: string;
}

interface ConstraintProgramComparison {
  relaxations: PolicyRelaxation[];
  incomparable: PolicyRelaxation[];
}

interface GovernanceGrantProjection {
  allow_policy_relaxation?: unknown;
}

interface TrustedAuthorizerProjection {
  issue_author_permission_trusted?: unknown;
  governance_approved_label?: unknown;
  codeowner_approved?: unknown;
  trusted_team_approval?: unknown;
}

interface ClassifiedChangedFiles {
  protectedFiles: string[];
  governanceFiles: string[];
  otherFiles: string[];
  protectedPatterns: string[];
}

interface PolicyDeltaFacts {
  basePolicy?: PolicyProjection | null;
  headPolicy?: PolicyProjection | null;
  diff: { files: { checked: ParsedDiffFile[] } };
  trustedAuthorizer?: TrustedAuthorizerProjection | null;
  governanceGrant?: GovernanceGrantProjection | null;
  changeIntent?: { change_type?: string } | null;
}

interface PolicyRelaxationCheckInput {
  basePolicy?: PolicyProjection | null;
  headPolicy?: PolicyProjection | null;
  changedFiles: ParsedDiffFile[];
  trustedAuthorizer?: TrustedAuthorizerProjection | null;
  governanceGrant?: GovernanceGrantProjection | null;
  changeIntentType?: string | null;
  configuredProtectedSurfaces?: string[] | null;
}

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const comparePolicyStrictness = compareConstraintPrograms;
export function computePolicyDelta(basePolicy: PolicyProjection | null | undefined, headPolicy: PolicyProjection | null | undefined): { relaxations: PolicyRelaxation[] } {
  if (!basePolicy || !headPolicy) return { relaxations: [] };
  const compared = compareConstraintPrograms(basePolicy, headPolicy) as ConstraintProgramComparison;
  return { relaxations: [...compared.relaxations, ...compared.incomparable] };
}

const DEFAULT_PROTECTED_SURFACES = ["source", "tests", "schemas"];
function protectedPatterns(policy: PolicyProjection | null | undefined, configured: string[] | null | undefined): string[] {
  return [...new Set((configured?.length ? configured : DEFAULT_PROTECTED_SURFACES).flatMap((name) => array(policy?.surfaces?.[name]) as string[]))];
}
const governanceFile = (path: string, policy: PolicyProjection | null | undefined): boolean => path === "repo-policy.json" || matchesAny(path, expandGovernancePatterns(array(policy?.paths?.governance_paths)));
export function classifyChangedFiles(files: ParsedDiffFile[], basePolicy: PolicyProjection | null | undefined, configured: string[] | null = null): ClassifiedChangedFiles {
  const patterns = protectedPatterns(basePolicy, configured), protectedFiles: string[] = [], governanceFiles: string[] = [], otherFiles: string[] = [];
  for (const file of files) {
    if (governanceFile(file.path, basePolicy)) governanceFiles.push(file.path);
    else if (patterns.length && matchesAny(file.path, patterns)) protectedFiles.push(file.path);
    else otherFiles.push(file.path);
  }
  return { protectedFiles, governanceFiles, otherFiles, protectedPatterns: patterns };
}

function pointerCovers(grant: unknown, delta: unknown): boolean {
  if (typeof grant !== "string" || typeof delta !== "string") return false;
  if (grant === delta || delta.startsWith(`${grant}/`)) return true;
  if (!grant.endsWith("/*")) return false;
  const prefix = grant.slice(0, -2), remainder = delta.startsWith(`${prefix}/`) ? delta.slice(prefix.length + 1) : null;
  return remainder !== null && remainder.split("/").length <= 2;
}
function grantCoversRelaxation(governanceGrant: GovernanceGrantProjection | null | undefined, relaxations: PolicyRelaxation[]) {
  if (!governanceGrant) return { ok: false, reason: "governance_grant_missing" };
  const allowed = array(governanceGrant.allow_policy_relaxation);
  if (!allowed.length) return { ok: false, reason: "governance_grant_missing_allow_policy_relaxation" };
  const uncovered = relaxations.map((item) => item.pointer).filter((pointer) => !allowed.some((entry) => pointerCovers(entry, pointer)));
  return uncovered.length
    ? { ok: false, reason: "governance_grant_does_not_cover_all_relaxations", uncovered_pointers: uncovered, allowed_pointers: allowed }
    : { ok: true, allowed_pointers: allowed };
}
function trust(authorizer: TrustedAuthorizerProjection | null | undefined) {
  if (!authorizer) return { trusted: false, reasons: ["trusted_authorizer_missing"] };
  const sources = [
    authorizer.issue_author_permission_trusted && "issue_author_permission",
    authorizer.governance_approved_label && "governance_approved_label",
    authorizer.codeowner_approved && "codeowner_approval",
    authorizer.trusted_team_approval && "trusted_team_approval",
  ].filter(Boolean) as string[];
  return sources.length ? { trusted: true, reasons: [], detected_sources: sources } : { trusted: false, reasons: ["no_trusted_authorization_source"], detected_sources: [] };
}

export function checkPolicyRelaxation({
  basePolicy, headPolicy, changedFiles, trustedAuthorizer, governanceGrant,
  changeIntentType, configuredProtectedSurfaces = null,
}: PolicyRelaxationCheckInput) {
  if (!basePolicy || !headPolicy) return { ok: true };
  const { relaxations } = computePolicyDelta(basePolicy, headPolicy);
  if (!relaxations.length) return { ok: true, policy_relaxations: [] };
  const classified = classifyChangedFiles(changedFiles, basePolicy, configuredProtectedSurfaces);
  const authorizer = trust(trustedAuthorizer), grant = grantCoversRelaxation(governanceGrant, relaxations);
  const reasons = [...authorizer.reasons];
  if (!grant.ok) reasons.push(grant.reason!);
  const governanceOnly = !classified.protectedFiles.length && !classified.otherFiles.length && classified.governanceFiles.length > 0;
  if (!governanceOnly) reasons.push("policy_relaxation_mixed_with_non_governance_changes");
  if (changeIntentType && changeIntentType !== "governance") reasons.push("change_intent_type_is_not_governance");
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

export const policyRelaxationRuleFamily: RuleFamily = {
  id: "policy-delta",
  applies: (facts) => Boolean((facts as PolicyDeltaFacts).basePolicy && (facts as PolicyDeltaFacts).headPolicy),
  evaluate: (facts) => ({ name: "policy-relaxation", check: checkPolicyRelaxation({
    basePolicy: (facts as PolicyDeltaFacts).basePolicy, headPolicy: (facts as PolicyDeltaFacts).headPolicy, changedFiles: (facts as PolicyDeltaFacts).diff.files.checked,
    trustedAuthorizer: (facts as PolicyDeltaFacts).trustedAuthorizer, governanceGrant: (facts as PolicyDeltaFacts).governanceGrant,
    changeIntentType: (facts as PolicyDeltaFacts).changeIntent?.change_type, configuredProtectedSurfaces: (facts as PolicyDeltaFacts).basePolicy?.policy_delta_rules?.protected_surfaces,
  }) }),
};
