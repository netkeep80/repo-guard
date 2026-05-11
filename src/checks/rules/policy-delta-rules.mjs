import { matchesAny } from "../../utils/path-patterns.mjs";
import { expandGovernancePatterns } from "./governance-paths.mjs";

const RELAXATION_KIND = {
  SIZE_RULE_MAX_INCREASED: "size_rule_max_increased",
  SIZE_RULE_LEVEL_WEAKENED: "size_rule_level_weakened",
  SIZE_RULE_COUNT_WEAKENED: "size_rule_count_weakened",
  SIZE_RULE_REMOVED: "size_rule_removed",
  DIFF_RULE_BUDGET_INCREASED: "diff_rule_budget_increased",
  FORBIDDEN_PATH_REMOVED: "forbidden_path_removed",
  GOVERNANCE_PATH_REMOVED: "governance_path_removed",
  INTEGRATION_WORKFLOW_REMOVED: "integration_workflow_removed",
  INTEGRATION_WORKFLOW_EXPECTATION_WEAKENED: "integration_workflow_expectation_weakened",
  ENFORCEMENT_WEAKENED: "enforcement_weakened",
};

const SIZE_RULE_LEVEL_RANK = { advisory: 0, blocking: 1 };
const SIZE_RULE_COUNT_RANK = { changed_only: 0, all_tracked: 1 };
const ENFORCEMENT_RANK = { advisory: 0, blocking: 1 };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function indexByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key === undefined || key === null) continue;
    map.set(String(key), item);
  }
  return map;
}

function buildSizeRuleIndex(policy) {
  const sizeRules = asArray(policy?.size_rules);
  return indexByKey(sizeRules, (rule) => rule.id);
}

function computeSizeRuleDeltas(basePolicy, headPolicy) {
  const baseIndex = buildSizeRuleIndex(basePolicy);
  const headIndex = buildSizeRuleIndex(headPolicy);
  const deltas = [];

  for (const [id, baseRule] of baseIndex) {
    const headRule = headIndex.get(id);
    if (!headRule) {
      deltas.push({
        kind: RELAXATION_KIND.SIZE_RULE_REMOVED,
        rule_id: id,
        pointer: `/size_rules/${id}`,
        before: { present: true, glob: baseRule.glob, max: baseRule.max },
        after: { present: false },
        message: `size_rules entry "${id}" removed (glob: ${baseRule.glob ?? "?"}, max: ${baseRule.max ?? "?"})`,
      });
      continue;
    }

    const baseMax = typeof baseRule.max === "number" ? baseRule.max : null;
    const headMax = typeof headRule.max === "number" ? headRule.max : null;
    if (baseMax !== null && headMax !== null && headMax > baseMax) {
      deltas.push({
        kind: RELAXATION_KIND.SIZE_RULE_MAX_INCREASED,
        rule_id: id,
        pointer: `/size_rules/${id}/max`,
        before: baseMax,
        after: headMax,
        message: `size_rules[${id}].max: ${baseMax} -> ${headMax}`,
      });
    }

    const baseLevel = baseRule.level || "blocking";
    const headLevel = headRule.level || "blocking";
    if (
      Object.hasOwn(SIZE_RULE_LEVEL_RANK, baseLevel) &&
      Object.hasOwn(SIZE_RULE_LEVEL_RANK, headLevel) &&
      SIZE_RULE_LEVEL_RANK[headLevel] < SIZE_RULE_LEVEL_RANK[baseLevel]
    ) {
      deltas.push({
        kind: RELAXATION_KIND.SIZE_RULE_LEVEL_WEAKENED,
        rule_id: id,
        pointer: `/size_rules/${id}/level`,
        before: baseLevel,
        after: headLevel,
        message: `size_rules[${id}].level: ${baseLevel} -> ${headLevel}`,
      });
    }

    const baseCount = baseRule.count || "all_tracked";
    const headCount = headRule.count || "all_tracked";
    if (
      Object.hasOwn(SIZE_RULE_COUNT_RANK, baseCount) &&
      Object.hasOwn(SIZE_RULE_COUNT_RANK, headCount) &&
      SIZE_RULE_COUNT_RANK[headCount] < SIZE_RULE_COUNT_RANK[baseCount]
    ) {
      deltas.push({
        kind: RELAXATION_KIND.SIZE_RULE_COUNT_WEAKENED,
        rule_id: id,
        pointer: `/size_rules/${id}/count`,
        before: baseCount,
        after: headCount,
        message: `size_rules[${id}].count: ${baseCount} -> ${headCount}`,
      });
    }
  }

  return deltas;
}

function computeDiffRuleDeltas(basePolicy, headPolicy) {
  const baseRules = basePolicy?.diff_rules || {};
  const headRules = headPolicy?.diff_rules || {};
  const fields = ["max_new_files", "max_new_docs", "max_net_added_lines"];
  const deltas = [];
  for (const field of fields) {
    const baseValue = baseRules[field];
    const headValue = headRules[field];
    if (typeof baseValue !== "number" || typeof headValue !== "number") continue;
    if (headValue > baseValue) {
      deltas.push({
        kind: RELAXATION_KIND.DIFF_RULE_BUDGET_INCREASED,
        field,
        pointer: `/diff_rules/${field}`,
        before: baseValue,
        after: headValue,
        message: `diff_rules.${field}: ${baseValue} -> ${headValue}`,
      });
    }
  }
  return deltas;
}

function computeForbiddenPathDeltas(basePolicy, headPolicy) {
  const baseForbidden = asArray(basePolicy?.paths?.forbidden);
  const headForbidden = new Set(asArray(headPolicy?.paths?.forbidden));
  const deltas = [];
  for (const pattern of baseForbidden) {
    if (!headForbidden.has(pattern)) {
      deltas.push({
        kind: RELAXATION_KIND.FORBIDDEN_PATH_REMOVED,
        pattern,
        pointer: `/paths/forbidden`,
        before: pattern,
        after: null,
        message: `paths.forbidden removed: ${pattern}`,
      });
    }
  }
  return deltas;
}

function computeGovernancePathDeltas(basePolicy, headPolicy) {
  const baseGovernance = asArray(basePolicy?.paths?.governance_paths);
  const headGovernance = new Set(asArray(headPolicy?.paths?.governance_paths));
  const deltas = [];
  for (const pattern of baseGovernance) {
    if (!headGovernance.has(pattern)) {
      deltas.push({
        kind: RELAXATION_KIND.GOVERNANCE_PATH_REMOVED,
        pattern,
        pointer: `/paths/governance_paths`,
        before: pattern,
        after: null,
        message: `paths.governance_paths removed: ${pattern}`,
      });
    }
  }
  return deltas;
}

function computeEnforcementDelta(basePolicy, headPolicy) {
  const baseMode = basePolicy?.enforcement?.mode;
  const headMode = headPolicy?.enforcement?.mode;
  if (!baseMode || !headMode) return [];
  if (
    Object.hasOwn(ENFORCEMENT_RANK, baseMode) &&
    Object.hasOwn(ENFORCEMENT_RANK, headMode) &&
    ENFORCEMENT_RANK[headMode] < ENFORCEMENT_RANK[baseMode]
  ) {
    return [
      {
        kind: RELAXATION_KIND.ENFORCEMENT_WEAKENED,
        pointer: `/enforcement/mode`,
        before: baseMode,
        after: headMode,
        message: `enforcement.mode: ${baseMode} -> ${headMode}`,
      },
    ];
  }
  return [];
}

function computeIntegrationWorkflowDeltas(basePolicy, headPolicy) {
  const baseWorkflows = asArray(basePolicy?.integration?.workflows);
  const headWorkflows = indexByKey(asArray(headPolicy?.integration?.workflows), (wf) => wf.id);
  const deltas = [];
  for (const baseWorkflow of baseWorkflows) {
    const id = baseWorkflow?.id;
    if (!id) continue;
    const headWorkflow = headWorkflows.get(String(id));
    if (!headWorkflow) {
      deltas.push({
        kind: RELAXATION_KIND.INTEGRATION_WORKFLOW_REMOVED,
        workflow_id: id,
        pointer: `/integration/workflows/${id}`,
        before: { present: true, role: baseWorkflow.role, path: baseWorkflow.path },
        after: { present: false },
        message: `integration.workflows entry "${id}" removed`,
      });
      continue;
    }

    const baseExpect = baseWorkflow.expect || {};
    const headExpect = headWorkflow.expect || {};
    const baseEnforcement = baseExpect.enforcement;
    const headEnforcement = headExpect.enforcement;
    if (
      baseEnforcement &&
      headEnforcement &&
      Object.hasOwn(ENFORCEMENT_RANK, baseEnforcement) &&
      Object.hasOwn(ENFORCEMENT_RANK, headEnforcement) &&
      ENFORCEMENT_RANK[headEnforcement] < ENFORCEMENT_RANK[baseEnforcement]
    ) {
      deltas.push({
        kind: RELAXATION_KIND.INTEGRATION_WORKFLOW_EXPECTATION_WEAKENED,
        workflow_id: id,
        pointer: `/integration/workflows/${id}/expect/enforcement`,
        before: baseEnforcement,
        after: headEnforcement,
        message: `integration.workflows[${id}].expect.enforcement: ${baseEnforcement} -> ${headEnforcement}`,
      });
    }
  }
  return deltas;
}

export function computePolicyDelta(basePolicy, headPolicy) {
  if (!basePolicy || !headPolicy) {
    return { relaxations: [] };
  }
  const relaxations = [
    ...computeSizeRuleDeltas(basePolicy, headPolicy),
    ...computeDiffRuleDeltas(basePolicy, headPolicy),
    ...computeForbiddenPathDeltas(basePolicy, headPolicy),
    ...computeGovernancePathDeltas(basePolicy, headPolicy),
    ...computeIntegrationWorkflowDeltas(basePolicy, headPolicy),
    ...computeEnforcementDelta(basePolicy, headPolicy),
  ];
  return { relaxations };
}

const DEFAULT_PROTECTED_SURFACES = ["source", "tests", "schemas"];

function protectedSurfacePatterns(basePolicy, configuredSurfaces = null) {
  const surfaces = basePolicy?.surfaces || {};
  const names = configuredSurfaces && configuredSurfaces.length > 0
    ? configuredSurfaces
    : DEFAULT_PROTECTED_SURFACES;
  const patterns = [];
  for (const name of names) {
    for (const pattern of asArray(surfaces[name])) {
      if (!patterns.includes(pattern)) patterns.push(pattern);
    }
  }
  return patterns;
}

function isPolicyFile(filePath, policyPath = "repo-policy.json") {
  return filePath === policyPath;
}

function isGovernanceFile(filePath, basePolicy) {
  const governance = asArray(basePolicy?.paths?.governance_paths);
  if (governance.length === 0) return false;
  return matchesAny(filePath, expandGovernancePatterns(governance));
}

export function classifyChangedFiles(files, basePolicy, configuredProtectedSurfaces = null) {
  const protectedPatterns = protectedSurfacePatterns(basePolicy, configuredProtectedSurfaces);
  const protectedFiles = [];
  const governanceFiles = [];
  const otherFiles = [];

  for (const file of files) {
    const path = file.path;
    if (isPolicyFile(path)) {
      governanceFiles.push(path);
      continue;
    }
    if (isGovernanceFile(path, basePolicy)) {
      governanceFiles.push(path);
      continue;
    }
    if (protectedPatterns.length > 0 && matchesAny(path, protectedPatterns)) {
      protectedFiles.push(path);
      continue;
    }
    otherFiles.push(path);
  }

  return { protectedFiles, governanceFiles, otherFiles, protectedPatterns };
}

function trustedIssueAuthorizationCoversRelaxation(issueAuthorization, relaxations) {
  if (!issueAuthorization) return { ok: false, reason: "no_linked_issue_authorization" };
  const allowed = asArray(issueAuthorization.allow_policy_relaxation);
  if (allowed.length === 0) {
    return { ok: false, reason: "linked_issue_missing_allow_policy_relaxation" };
  }
  const uncoveredPointers = relaxations
    .map((relaxation) => relaxation.pointer)
    .filter((pointer) => !allowed.some((p) => pointerCovers(p, pointer)));
  if (uncoveredPointers.length > 0) {
    return {
      ok: false,
      reason: "linked_issue_allow_policy_relaxation_does_not_cover_all_pointers",
      uncovered_pointers: uncoveredPointers,
      allowed_pointers: allowed,
    };
  }
  return { ok: true, allowed_pointers: allowed };
}

function pointerCovers(authorizationPointer, deltaPointer) {
  if (typeof authorizationPointer !== "string" || typeof deltaPointer !== "string") return false;
  if (authorizationPointer === deltaPointer) return true;
  if (deltaPointer.startsWith(`${authorizationPointer}/`)) return true;
  if (authorizationPointer.endsWith("/*")) {
    const prefix = authorizationPointer.slice(0, -2);
    const remainder = deltaPointer.startsWith(`${prefix}/`) ? deltaPointer.slice(prefix.length + 1) : null;
    if (remainder !== null && !remainder.includes("/")) return true;
    if (remainder !== null && remainder.split("/").length === 2) return true;
  }
  return false;
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
  if (!basePolicy || !headPolicy) {
    return { ok: true };
  }

  const { relaxations } = computePolicyDelta(basePolicy, headPolicy);
  if (relaxations.length === 0) {
    return { ok: true, policy_relaxations: [] };
  }

  const { protectedFiles, governanceFiles, otherFiles, protectedPatterns } = classifyChangedFiles(
    changedFiles,
    basePolicy,
    configuredProtectedSurfaces
  );

  const messages = relaxations.map((relaxation) => relaxation.message);

  const reasons = [];
  const trustedAuthorizerSummary = summarizeTrustedAuthorizer(trustedAuthorizer);
  if (!trustedAuthorizerSummary.trusted) {
    reasons.push(...trustedAuthorizerSummary.reasons);
  }

  const issueAuthCheck = trustedIssueAuthorizationCoversRelaxation(issueAuthorization, relaxations);
  if (!issueAuthCheck.ok) {
    reasons.push(issueAuthCheck.reason);
  }

  const isGovernanceOnly =
    protectedFiles.length === 0 &&
    otherFiles.length === 0 &&
    governanceFiles.length > 0;

  if (!isGovernanceOnly) {
    reasons.push("policy_relaxation_mixed_with_non_governance_changes");
  }

  if (contractChangeType && contractChangeType !== "governance") {
    reasons.push("contract_change_type_is_not_governance");
  }

  const ok = reasons.length === 0;

  const details = relaxations.map((relaxation) => `- ${relaxation.pointer}: ${relaxation.message}`);
  if (!isGovernanceOnly && protectedFiles.length > 0) {
    details.push(
      `Mixed with protected-surface changes: ${protectedFiles.slice(0, 10).join(", ")}${
        protectedFiles.length > 10 ? `, +${protectedFiles.length - 10} more` : ""
      }`
    );
  }
  if (trustedAuthorizerSummary.reasons.length > 0) {
    details.push(`trusted_authorizer: ${trustedAuthorizerSummary.reasons.join(", ")}`);
  }

  return {
    ok,
    message: ok ? undefined : "PR attempts to relax trusted repository policy",
    policy_relaxations: relaxations,
    details,
    blocked_reasons: reasons,
    governance_only: isGovernanceOnly,
    protected_files: protectedFiles,
    governance_files: governanceFiles,
    other_files: otherFiles,
    protected_patterns: protectedPatterns,
    trusted_authorizer: trustedAuthorizerSummary,
    hint: ok
      ? undefined
      : [
          "Policy relaxation must be submitted as a dedicated governance change and authorized by a trusted maintainer/code owner.",
          "Do not combine policy relaxation with product/kernel/generated changes.",
          "Set contract change_type to \"governance\" and ensure the linked issue body lists the relaxed pointers in allow_policy_relaxation.",
          "Trusted authorization sources: linked-issue author with write/maintain/admin permission, a maintainer-applied governance-approved label, a CODEOWNERS approval for the governance files, or a configured trusted GitHub team approval.",
        ].join(" "),
  };
}

function summarizeTrustedAuthorizer(trustedAuthorizer) {
  if (!trustedAuthorizer || typeof trustedAuthorizer !== "object") {
    return { trusted: false, reasons: ["trusted_authorizer_missing"] };
  }

  const sources = [];
  if (trustedAuthorizer.issue_author_permission_trusted) sources.push("issue_author_permission");
  if (trustedAuthorizer.governance_approved_label) sources.push("governance_approved_label");
  if (trustedAuthorizer.codeowner_approved) sources.push("codeowner_approval");
  if (trustedAuthorizer.trusted_team_approval) sources.push("trusted_team_approval");
  if (sources.length === 0) {
    return {
      trusted: false,
      reasons: ["no_trusted_authorization_source"],
      detected_sources: [],
    };
  }
  return { trusted: true, reasons: [], detected_sources: sources };
}

export const policyRelaxationRuleFamily = {
  id: "policy-delta",
  applies(facts) {
    return Boolean(facts.basePolicy && facts.headPolicy);
  },
  evaluate(facts) {
    const check = checkPolicyRelaxation({
      basePolicy: facts.basePolicy,
      headPolicy: facts.headPolicy,
      changedFiles: facts.diff.files.checked,
      trustedAuthorizer: facts.trustedAuthorizer,
      issueAuthorization: facts.issueAuthorization,
      contractChangeType: facts.contract?.change_type,
      configuredProtectedSurfaces: facts.basePolicy?.policy_delta_rules?.protected_surfaces,
    });
    return { name: "policy-relaxation", check };
  },
};
