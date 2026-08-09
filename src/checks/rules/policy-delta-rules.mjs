import { matchesAny } from "../../utils/path-patterns.mjs";
import { expandGovernancePatterns } from "./governance-paths.mjs";

const RANKS = {
  enforcement: { advisory: 0, blocking: 1 },
  count: { changed_only: 0, all_tracked: 1 },
};
const asArray = (value) => Array.isArray(value) ? value : [];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function constraint(key, relation, value, metadata = {}) {
  return { key, relation, value, ...metadata };
}
function scalar(key, value, relation, metadata = {}) {
  return constraint(key, relation, value, metadata);
}
function setConstraint(key, value, relation, metadata = {}) {
  return constraint(key, relation, asArray(value), metadata);
}
function entity(key, metadata = {}) {
  return constraint(key, "required_entity", true, metadata);
}
function exact(key, value, metadata = {}) {
  return constraint(key, "equal_or_incomparable", value, metadata);
}

/**
 * Compile policy into a small monotonic comparison IR.
 * High-level macros that expand to these primitives gain self-weakening protection
 * without adding another field-specific delta walker.
 */
export function compilePolicyStrictnessIR(policy = {}) {
  const result = [];

  for (const rule of asArray(policy.size_rules)) {
    const owner = `size:${rule.id}`;
    result.push(entity(owner, {
      pointer: `/size_rules/${rule.id}`,
      removeKind: "size_rule_removed",
      rule_id: rule.id,
      removeBefore: { present: true, glob: rule.glob, max: rule.max },
      removeAfter: { present: false },
      removeMessage: `size_rules entry "${rule.id}" removed (glob: ${rule.glob ?? "?"}, max: ${rule.max ?? "?"})`,
    }));
    result.push(
      exact(`${owner}:shape`, {
        scope: rule.scope,
        metric: rule.metric,
        glob: rule.glob,
        applies_to_change_types: rule.applies_to_change_types,
      }, { owner, pointer: `/size_rules/${rule.id}`, incomparableMessage: `size_rules[${rule.id}] changed selector/scope semantics` }),
      scalar(`${owner}:max`, rule.max, "lower_stricter", {
        owner, pointer: `/size_rules/${rule.id}/max`, weakenKind: "size_rule_max_increased", rule_id: rule.id,
        message: (before, after) => `size_rules[${rule.id}].max: ${before} -> ${after}`,
      }),
      scalar(`${owner}:level`, RANKS.enforcement[rule.level || "blocking"], "higher_stricter", {
        owner, raw: rule.level || "blocking", pointer: `/size_rules/${rule.id}/level`, weakenKind: "size_rule_level_weakened", rule_id: rule.id,
        message: (before, after) => `size_rules[${rule.id}].level: ${before} -> ${after}`,
      }),
      scalar(`${owner}:count`, RANKS.count[rule.count || "all_tracked"], "higher_stricter", {
        owner, raw: rule.count || "all_tracked", pointer: `/size_rules/${rule.id}/count`, weakenKind: "size_rule_count_weakened", rule_id: rule.id,
        message: (before, after) => `size_rules[${rule.id}].count: ${before} -> ${after}`,
      }),
      setConstraint(`${owner}:ignore`, rule.ignore, "subset_stricter", {
        owner, pointer: `/size_rules/${rule.id}/ignore`, weakenKind: "size_rule_ignore_added", itemField: "pattern",
        message: (item) => `size_rules[${rule.id}].ignore added: ${item}`,
      }),
    );
    if (rule.max_growth !== undefined) {
      result.push(scalar(`${owner}:max_growth`, rule.max_growth, "lower_stricter", {
        owner, pointer: `/size_rules/${rule.id}/max_growth`, weakenKind: "size_rule_max_growth_increased",
        removeKind: "size_rule_max_growth_removed", rule_id: rule.id,
        message: (before, after) => `size_rules[${rule.id}].max_growth: ${before} -> ${after}`,
        removeMessage: `size_rules[${rule.id}].max_growth removed (was ${rule.max_growth})`,
      }));
    }
  }

  for (const field of ["max_new_files", "max_new_docs", "max_net_added_lines"]) {
    if (typeof policy.diff_rules?.[field] !== "number") continue;
    result.push(scalar(`diff:${field}`, policy.diff_rules[field], "lower_stricter", {
      pointer: `/diff_rules/${field}`, weakenKind: "diff_rule_budget_increased", removeKind: "diff_rule_budget_removed", field,
      message: (before, after) => `diff_rules.${field}: ${before} -> ${after}`,
      removeMessage: `diff_rules.${field} removed (was ${policy.diff_rules[field]})`,
    }));
  }

  result.push(
    setConstraint("paths:forbidden", policy.paths?.forbidden, "superset_stricter", {
      pointer: "/paths/forbidden", weakenKind: "forbidden_path_removed", itemField: "pattern",
      message: (item) => `paths.forbidden removed: ${item}`,
    }),
    setConstraint("paths:governance", policy.paths?.governance_paths, "superset_stricter", {
      pointer: "/paths/governance_paths", weakenKind: "governance_path_removed", itemField: "pattern",
      message: (item) => `paths.governance_paths removed: ${item}`,
    }),
    setConstraint("paths:operational", policy.paths?.operational_paths, "subset_stricter", {
      pointer: "/paths/operational_paths", weakenKind: "operational_path_added", itemField: "pattern",
      message: (item) => `paths.operational_paths added exclusion: ${item}`,
    }),
    setConstraint("paths:canonical_docs", policy.paths?.canonical_docs, "subset_stricter", {
      pointer: "/paths/canonical_docs", weakenKind: "canonical_doc_added", itemField: "pattern",
      message: (item) => `paths.canonical_docs added exemption: ${item}`,
    }),
  );

  const mode = policy.enforcement?.mode;
  if (mode) result.push(scalar("enforcement", RANKS.enforcement[mode], "higher_stricter", {
    raw: mode, pointer: "/enforcement/mode", weakenKind: "enforcement_weakened", removeKind: "enforcement_removed",
    message: (before, after) => `enforcement.mode: ${before} -> ${after}`,
    removeMessage: `enforcement.mode removed (was ${mode})`,
  }));

  for (const workflow of asArray(policy.integration?.workflows)) {
    const owner = `workflow:${workflow.id}`;
    result.push(entity(owner, {
      pointer: `/integration/workflows/${workflow.id}`,
      removeKind: "integration_workflow_removed",
      workflow_id: workflow.id,
      removeBefore: { present: true, role: workflow.role, path: workflow.path },
      removeAfter: { present: false },
      removeMessage: `integration.workflows entry "${workflow.id}" removed`,
    }));
    const { enforcement, ...otherExpect } = workflow.expect || {};
    result.push(exact(`${owner}:shape`, {
      kind: workflow.kind,
      path: workflow.path,
      role: workflow.role,
      profiles: workflow.profiles,
      expect: otherExpect,
    }, { owner, pointer: `/integration/workflows/${workflow.id}`, incomparableMessage: `integration.workflows[${workflow.id}] changed non-monotonic wiring semantics` }));
    if (enforcement) result.push(scalar(`${owner}:enforcement`, RANKS.enforcement[enforcement], "higher_stricter", {
      owner, raw: enforcement, pointer: `/integration/workflows/${workflow.id}/expect/enforcement`,
      weakenKind: "integration_workflow_expectation_weakened", removeKind: "integration_workflow_expectation_removed", workflow_id: workflow.id,
      message: (before, after) => `integration.workflows[${workflow.id}].expect.enforcement: ${before} -> ${after}`,
      removeMessage: `integration.workflows[${workflow.id}].expect.enforcement removed (was ${enforcement})`,
    }));
  }
  return result;
}

function relaxation(entry, { before, after = null, kind = entry.weakenKind, message = null, extra = {} }) {
  return {
    kind,
    ...(entry.rule_id ? { rule_id: entry.rule_id } : {}),
    ...(entry.field ? { field: entry.field } : {}),
    ...(entry.workflow_id ? { workflow_id: entry.workflow_id } : {}),
    pointer: entry.pointer,
    before,
    after,
    message: message || entry.message?.(before, after) || entry.removeMessage,
    ...extra,
  };
}

function incomparable(entry, before, after) {
  return {
    kind: "policy_incomparable",
    pointer: entry.pointer,
    before,
    after,
    message: entry.incomparableMessage || `policy constraint ${entry.key} changed with no proven monotonic ordering`,
  };
}

function unknownProjection(policy = {}) {
  const copy = clone(policy) || {};
  delete copy.enforcement;
  delete copy.diff_rules;
  delete copy.size_rules;

  if (copy.paths) {
    for (const field of ["forbidden", "governance_paths", "operational_paths", "canonical_docs"]) delete copy.paths[field];
    if (Object.keys(copy.paths).length === 0) delete copy.paths;
  }

  if (copy.integration) {
    delete copy.integration.workflows;
    if (Object.keys(copy.integration).length === 0) delete copy.integration;
  }
  return copy;
}

export function comparePolicyStrictness(basePolicy, headPolicy) {
  if (!basePolicy || !headPolicy) return { relation: "equal", relaxations: [], incomparable: [] };
  const base = compilePolicyStrictnessIR(basePolicy);
  const head = new Map(compilePolicyStrictnessIR(headPolicy).map((item) => [item.key, item]));
  const relaxations = [];
  const incomparableChanges = [];
  const removedOwners = new Set();
  let tightened = false;
  let changed = false;

  for (const entry of base) {
    if (entry.owner && removedOwners.has(entry.owner)) continue;
    const next = head.get(entry.key);
    if (!next) {
      if (entry.removeKind) {
        relaxations.push(relaxation(entry, {
          before: entry.removeBefore ?? entry.raw ?? entry.value,
          after: entry.removeAfter ?? null,
          kind: entry.removeKind,
          message: entry.removeMessage,
        }));
        changed = true;
        if (entry.relation === "required_entity") removedOwners.add(entry.key);
      }
      continue;
    }

    if (entry.relation === "lower_stricter") {
      if (next.value > entry.value) relaxations.push(relaxation(entry, { before: entry.value, after: next.value }));
      else if (next.value < entry.value) tightened = true;
      changed ||= next.value !== entry.value;
    } else if (entry.relation === "higher_stricter") {
      if (next.value < entry.value) relaxations.push(relaxation(entry, { before: entry.raw ?? entry.value, after: next.raw ?? next.value }));
      else if (next.value > entry.value) tightened = true;
      changed ||= next.value !== entry.value;
    } else if (entry.relation === "superset_stricter" || entry.relation === "subset_stricter") {
      const beforeSet = new Set(entry.value);
      const afterSet = new Set(next.value);
      const removed = entry.value.filter((item) => !afterSet.has(item));
      const added = next.value.filter((item) => !beforeSet.has(item));
      const weakerItems = entry.relation === "superset_stricter" ? removed : added;
      const stricterItems = entry.relation === "superset_stricter" ? added : removed;
      for (const item of weakerItems) {
        relaxations.push(relaxation(entry, {
          before: item,
          kind: entry.weakenKind,
          message: entry.message(item),
          extra: { [entry.itemField]: item },
        }));
      }
      tightened ||= stricterItems.length > 0;
      changed ||= removed.length > 0 || added.length > 0;
    } else if (entry.relation === "equal_or_incomparable" && !same(entry.value, next.value)) {
      incomparableChanges.push(incomparable(entry, entry.value, next.value));
      changed = true;
    }
  }

  const baseKeys = new Set(base.map((entry) => entry.key));
  for (const item of head.values()) {
    if (baseKeys.has(item.key)) continue;
    changed = true;
    if (item.relation === "required_entity" || item.relation === "lower_stricter" || item.relation === "higher_stricter") tightened = true;
    else if (item.relation === "subset_stricter" && item.value.length) {
      for (const added of item.value) incomparableChanges.push(incomparable(item, [], [added]));
    } else if (item.relation === "equal_or_incomparable" && !item.owner) {
      incomparableChanges.push(incomparable(item, null, item.value));
    }
  }

  const baseUnknown = unknownProjection(basePolicy);
  const headUnknown = unknownProjection(headPolicy);
  if (!same(baseUnknown, headUnknown)) {
    incomparableChanges.push({
      kind: "policy_incomparable",
      pointer: "/",
      before: baseUnknown,
      after: headUnknown,
      message: "policy sections outside the normalized strictness IR changed and require explicit governance review",
    });
    changed = true;
  }

  const relation = relaxations.length > 0 ? "weaker"
    : incomparableChanges.length > 0 ? "incomparable"
      : tightened || changed ? "stricter" : "equal";
  return { relation, relaxations, incomparable: incomparableChanges };
}

export function computePolicyDelta(basePolicy, headPolicy) {
  if (!basePolicy || !headPolicy) return { relaxations: [] };
  const compared = comparePolicyStrictness(basePolicy, headPolicy);
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
  const protectedFiles = [];
  const governanceFiles = [];
  const otherFiles = [];
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
