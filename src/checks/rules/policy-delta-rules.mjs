import { matchesAny } from "../../utils/path-patterns.mjs";
import { expandGovernancePatterns } from "./governance-paths.mjs";

const RANKS = {
  enforcement: { advisory: 0, blocking: 1 },
  count: { changed_only: 0, all_tracked: 1 },
};
const asArray = (value) => Array.isArray(value) ? value : [];
const stable = (value) => JSON.stringify(value, Object.keys(value || {}).sort());

function scalar(key, value, relation, metadata = {}) {
  return { key, value, relation, ...metadata };
}
function setConstraint(key, value, metadata = {}) {
  return { key, value: asArray(value), relation: "superset_stricter", ...metadata };
}
function entity(key, value, metadata = {}) {
  return { key, value, relation: "required_entity", ...metadata };
}

/** Compile high-level policy into monotonic primitives understood by one comparator. */
export function compilePolicyStrictnessIR(policy = {}) {
  const constraints = [];
  for (const rule of asArray(policy.size_rules)) {
    const owner = `size:${rule.id}`;
    constraints.push(entity(owner, { glob: rule.glob, max: rule.max }, {
      pointer: `/size_rules/${rule.id}`, removeKind: "size_rule_removed", rule_id: rule.id,
      removeMessage: `size_rules entry "${rule.id}" removed (glob: ${rule.glob ?? "?"}, max: ${rule.max ?? "?"})`,
    }));
    constraints.push(
      scalar(`${owner}:max`, rule.max, "lower_stricter", { owner, pointer: `/size_rules/${rule.id}/max`, weakenKind: "size_rule_max_increased", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].max: ${a} -> ${b}` }),
      scalar(`${owner}:level`, RANKS.enforcement[rule.level || "blocking"], "higher_stricter", { owner, raw: rule.level || "blocking", pointer: `/size_rules/${rule.id}/level`, weakenKind: "size_rule_level_weakened", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].level: ${a} -> ${b}` }),
      scalar(`${owner}:count`, RANKS.count[rule.count || "all_tracked"], "higher_stricter", { owner, raw: rule.count || "all_tracked", pointer: `/size_rules/${rule.id}/count`, weakenKind: "size_rule_count_weakened", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].count: ${a} -> ${b}` }),
    );
  }

  for (const field of ["max_new_files", "max_new_docs", "max_net_added_lines"]) {
    if (typeof policy.diff_rules?.[field] !== "number") continue;
    constraints.push(scalar(`diff:${field}`, policy.diff_rules[field], "lower_stricter", {
      pointer: `/diff_rules/${field}`, weakenKind: "diff_rule_budget_increased", removeKind: "diff_rule_budget_removed", field,
      message: (a, b) => `diff_rules.${field}: ${a} -> ${b}`,
      removeMessage: `diff_rules.${field} removed (was ${policy.diff_rules[field]})`,
    }));
  }

  constraints.push(
    setConstraint("paths:forbidden", policy.paths?.forbidden, { pointer: "/paths/forbidden", weakenKind: "forbidden_path_removed", itemField: "pattern", message: (item) => `paths.forbidden removed: ${item}` }),
    setConstraint("paths:governance", policy.paths?.governance_paths, { pointer: "/paths/governance_paths", weakenKind: "governance_path_removed", itemField: "pattern", message: (item) => `paths.governance_paths removed: ${item}` }),
  );

  const mode = policy.enforcement?.mode;
  if (mode) constraints.push(scalar("enforcement", RANKS.enforcement[mode], "higher_stricter", {
    raw: mode, pointer: "/enforcement/mode", weakenKind: "enforcement_weakened", removeKind: "enforcement_removed",
    message: (a, b) => `enforcement.mode: ${a} -> ${b}`, removeMessage: `enforcement.mode removed (was ${mode})`,
  }));

  for (const workflow of asArray(policy.integration?.workflows)) {
    const owner = `workflow:${workflow.id}`;
    constraints.push(entity(owner, { role: workflow.role, path: workflow.path }, {
      pointer: `/integration/workflows/${workflow.id}`, removeKind: "integration_workflow_removed", workflow_id: workflow.id,
      removeMessage: `integration.workflows entry "${workflow.id}" removed`,
    }));
    const enforcement = workflow.expect?.enforcement;
    if (enforcement) constraints.push(scalar(`${owner}:enforcement`, RANKS.enforcement[enforcement], "higher_stricter", {
      owner, raw: enforcement, pointer: `/integration/workflows/${workflow.id}/expect/enforcement`,
      weakenKind: "integration_workflow_expectation_weakened", removeKind: "integration_workflow_expectation_removed", workflow_id: workflow.id,
      message: (a, b) => `integration.workflows[${workflow.id}].expect.enforcement: ${a} -> ${b}`,
      removeMessage: `integration.workflows[${workflow.id}].expect.enforcement removed (was ${enforcement})`,
    }));
  }
  return constraints;
}

function relaxation(entry, { before, after = null, kind = entry.weakenKind, message = null, extra = {} }) {
  return {
    kind, ...(entry.rule_id ? { rule_id: entry.rule_id } : {}), ...(entry.field ? { field: entry.field } : {}),
    ...(entry.workflow_id ? { workflow_id: entry.workflow_id } : {}), pointer: entry.pointer, before, after,
    message: message || entry.message?.(before, after) || entry.removeMessage, ...extra,
  };
}

function knownProjection(policy = {}) {
  return {
    enforcement: policy.enforcement,
    diff_rules: policy.diff_rules,
    size_rules: policy.size_rules,
    paths: { forbidden: policy.paths?.forbidden, governance_paths: policy.paths?.governance_paths },
    integration: { workflows: policy.integration?.workflows?.map((wf) => ({ id: wf.id, role: wf.role, path: wf.path, enforcement: wf.expect?.enforcement })) },
  };
}

export function comparePolicyStrictness(basePolicy, headPolicy) {
  if (!basePolicy || !headPolicy) return { relation: "equal", relaxations: [], incomparable: [] };
  const base = compilePolicyStrictnessIR(basePolicy);
  const head = new Map(compilePolicyStrictnessIR(headPolicy).map((item) => [item.key, item]));
  const relaxations = [];
  let tightened = false;
  const removedOwners = new Set();

  for (const entry of base) {
    if (entry.owner && removedOwners.has(entry.owner)) continue;
    const next = head.get(entry.key);
    if (!next) {
      if (entry.removeKind) {
        const before = entry.raw ?? entry.value;
        relaxations.push(relaxation(entry, { before, kind: entry.removeKind, message: entry.removeMessage }));
        if (entry.relation === "required_entity") removedOwners.add(entry.key);
      }
      continue;
    }
    if (entry.relation === "lower_stricter") {
      if (next.value > entry.value) relaxations.push(relaxation(entry, { before: entry.value, after: next.value }));
      else if (next.value < entry.value) tightened = true;
    } else if (entry.relation === "higher_stricter") {
      if (next.value < entry.value) relaxations.push(relaxation(entry, { before: entry.raw ?? entry.value, after: next.raw ?? next.value }));
      else if (next.value > entry.value) tightened = true;
    } else if (entry.relation === "superset_stricter") {
      const nextSet = new Set(next.value);
      for (const item of entry.value) {
        if (!nextSet.has(item)) relaxations.push(relaxation(entry, {
          before: item, kind: entry.weakenKind, message: entry.message(item), extra: { [entry.itemField]: item },
        }));
      }
      if (next.value.some((item) => !new Set(entry.value).has(item))) tightened = true;
    }
  }
  for (const item of head.values()) if (!base.some((entry) => entry.key === item.key)) tightened = true;

  const baseProjection = JSON.stringify(knownProjection(basePolicy));
  const headProjection = JSON.stringify(knownProjection(headPolicy));
  const baseUnknown = { ...basePolicy };
  const headUnknown = { ...headPolicy };
  for (const key of ["enforcement", "diff_rules", "size_rules", "paths", "integration"]) {
    delete baseUnknown[key]; delete headUnknown[key];
  }
  const incomparable = stable(baseUnknown) === stable(headUnknown) ? [] : [{
    kind: "policy_incomparable", pointer: "/", before: baseUnknown, after: headUnknown,
    message: "policy sections outside the normalized strictness IR changed and require explicit governance review",
  }];

  const relation = relaxations.length ? "weaker"
    : incomparable.length ? "incomparable"
      : baseProjection === headProjection && !tightened ? "equal" : "stricter";
  return { relation, relaxations, incomparable };
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
  return sources.length ? { trusted: true, reasons: [], detected_sources: sources }
    : { trusted: false, reasons: ["no_trusted_authorization_source"], detected_sources: [] };
}

export function checkPolicyRelaxation({
  basePolicy, headPolicy, changedFiles, trustedAuthorizer, issueAuthorization, contractChangeType,
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
  if (!governanceOnly && classified.protectedFiles.length) details.push(`Mixed with protected-surface changes: ${classified.protectedFiles.slice(0, 10).join(", ")}${classified.protectedFiles.length > 10 ? `, +${classified.protectedFiles.length - 10} more` : ""}`);
  if (authorizer.reasons.length) details.push(`trusted_authorizer: ${authorizer.reasons.join(", ")}`);
  const ok = reasons.length === 0;
  return {
    ok, message: ok ? undefined : "PR attempts to relax trusted repository policy",
    policy_relaxations: relaxations, details, blocked_reasons: reasons, governance_only: governanceOnly,
    protected_files: classified.protectedFiles, governance_files: classified.governanceFiles, other_files: classified.otherFiles,
    protected_patterns: classified.protectedPatterns, trusted_authorizer: authorizer,
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
        basePolicy: facts.basePolicy, headPolicy: facts.headPolicy, changedFiles: facts.diff.files.checked,
        trustedAuthorizer: facts.trustedAuthorizer, issueAuthorization: facts.issueAuthorization,
        contractChangeType: facts.contract?.change_type,
        configuredProtectedSurfaces: facts.basePolicy?.policy_delta_rules?.protected_surfaces,
      }),
    };
  },
};
