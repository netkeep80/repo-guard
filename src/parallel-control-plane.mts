import type { ParallelControlPlaneFacts, ParallelReadinessProvider } from "./parallel-readiness.mjs";

type Failure = { ok: false; error: string; message: string };
type KnownBoolean = boolean | null;

export interface NormalizedParallelControlPlaneFacts extends ParallelControlPlaneFacts {
  targetBranch: string | null;
  requiredChecks: string[] | null;
  pullRequestRequired: KnownBoolean;
  requiredChecksEnforced: KnownBoolean;
  upToDateRequired: KnownBoolean;
  noBypass: KnownBoolean;
  mergeQueueEnabled: KnownBoolean;
}

export interface ParallelControlPlaneEvidence {
  provider: ParallelReadinessProvider;
  repository: string;
  defaultBranch: string | null;
  branchProtectionComplete: boolean;
  branchProtected: boolean | null;
  activeBranchRulesComplete: boolean;
  activeRuleTypes: string[] | null;
  rulesetsComplete: boolean;
  activeRulesetIds: number[] | null;
}

export type ParallelControlPlaneNormalizationResult = Failure | {
  ok: true;
  facts: NormalizedParallelControlPlaneFacts;
  evidence: ParallelControlPlaneEvidence;
};

interface BranchProtectionEnvelope {
  complete: boolean;
  protected: boolean | null;
  data: Record<string, unknown> | null;
}

interface InventoryEnvelope {
  complete: boolean;
  items: unknown[] | null;
}

interface ProtectionFacts {
  active: boolean;
  pullRequestRequired: boolean;
  requiredChecks: string[];
  requiredChecksEnforced: boolean;
  upToDateRequired: boolean;
  noBypass: KnownBoolean;
}

interface RulesFacts extends ProtectionFacts {
  mergeQueueEnabled: boolean;
  ruleTypes: string[];
  rulesetIds: number[];
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(error: string, message: string): Failure {
  return { ok: false, error, message };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortedUniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function readBranchProtection(value: unknown): BranchProtectionEnvelope | Failure {
  if (!isRecord(value) || typeof value.complete !== "boolean") {
    return fail("invalid_branch_protection", "branchProtection must declare boolean complete");
  }
  if (!value.complete) return { complete: false, protected: null, data: null };
  if (typeof value.protected !== "boolean") {
    return fail("invalid_branch_protection", "complete branchProtection must declare boolean protected");
  }
  if (value.protected) {
    if (!isRecord(value.data)) return fail("invalid_branch_protection", "protected branch requires branch protection data");
    return { complete: true, protected: true, data: value.data };
  }
  if (value.data !== undefined && value.data !== null && !isRecord(value.data)) {
    return fail("invalid_branch_protection", "unprotected branch data must be null or an object");
  }
  return { complete: true, protected: false, data: isRecord(value.data) ? value.data : null };
}

function readInventory(value: unknown, field: "activeBranchRules" | "rulesets", itemsField: "rules" | "items"): InventoryEnvelope | Failure {
  if (!isRecord(value) || typeof value.complete !== "boolean") {
    return fail(`invalid_${field}`, `${field} must declare boolean complete`);
  }
  if (!value.complete) return { complete: false, items: null };
  const items = value[itemsField];
  if (!Array.isArray(items)) return fail(`invalid_${field}`, `complete ${field} must provide ${itemsField} array`);
  return { complete: true, items };
}

function readStringArray(value: unknown, field: string): string[] | Failure {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    return fail("invalid_branch_protection", `${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function classicBypassAllowances(value: unknown): KnownBoolean | Failure {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return fail("invalid_branch_protection", "bypass_pull_request_allowances must be an object");
  const groups = ["users", "teams", "apps"] as const;
  let complete = true;
  let hasBypass = false;
  for (const group of groups) {
    const actors = value[group];
    if (actors === undefined) {
      complete = false;
      continue;
    }
    if (!Array.isArray(actors)) return fail("invalid_branch_protection", `bypass_pull_request_allowances.${group} must be an array`);
    if (actors.length > 0) hasBypass = true;
  }
  if (hasBypass) return false;
  return complete ? true : null;
}

function parseClassic(envelope: BranchProtectionEnvelope): ProtectionFacts | Failure {
  if (!envelope.complete || !envelope.protected || !envelope.data) {
    return {
      active: false,
      pullRequestRequired: false,
      requiredChecks: [],
      requiredChecksEnforced: false,
      upToDateRequired: false,
      noBypass: null,
    };
  }

  const data = envelope.data;
  const status = data.required_status_checks;
  let checks: string[] = [];
  let strict = false;
  if (status !== undefined && status !== null) {
    if (!isRecord(status) || typeof status.strict !== "boolean") {
      return fail("invalid_branch_protection", "required_status_checks must contain boolean strict");
    }
    strict = status.strict;
    const contexts = readStringArray(status.contexts, "required_status_checks.contexts");
    if ("ok" in contexts) return contexts;
    const checkEntries = status.checks;
    if (checkEntries !== undefined) {
      if (!Array.isArray(checkEntries)) return fail("invalid_branch_protection", "required_status_checks.checks must be an array");
      for (const entry of checkEntries) {
        if (!isRecord(entry) || typeof entry.context !== "string" || entry.context.length === 0) {
          return fail("invalid_branch_protection", "required_status_checks.checks entries must contain context");
        }
        checks.push(entry.context);
      }
    }
    checks.push(...contexts);
    checks = sortedUnique(checks);
  }

  const reviews = data.required_pull_request_reviews;
  let pullRequestRequired = false;
  let allowances: KnownBoolean = null;
  if (reviews !== undefined && reviews !== null) {
    if (!isRecord(reviews)) return fail("invalid_branch_protection", "required_pull_request_reviews must be an object");
    pullRequestRequired = true;
    const allowanceResult = classicBypassAllowances(reviews.bypass_pull_request_allowances);
    if (typeof allowanceResult === "object" && allowanceResult !== null) return allowanceResult;
    allowances = allowanceResult;
  }

  const enforceAdmins = data.enforce_admins;
  let adminsProtected: KnownBoolean = null;
  if (enforceAdmins !== undefined && enforceAdmins !== null) {
    if (!isRecord(enforceAdmins) || typeof enforceAdmins.enabled !== "boolean") {
      return fail("invalid_branch_protection", "enforce_admins must contain boolean enabled");
    }
    adminsProtected = enforceAdmins.enabled;
  }

  const requiredChecksEnforced = checks.length > 0;
  const active = pullRequestRequired || requiredChecksEnforced;
  let noBypass: KnownBoolean = null;
  if (active && allowances === false) noBypass = false;
  else if (active && pullRequestRequired && allowances === true && adminsProtected === true) noBypass = true;

  return {
    active,
    pullRequestRequired,
    requiredChecks: checks,
    requiredChecksEnforced,
    upToDateRequired: requiredChecksEnforced && strict,
    noBypass,
  };
}

function rulesetId(rule: Record<string, unknown>): number | Failure {
  if (!Number.isInteger(rule.ruleset_id) || (rule.ruleset_id as number) < 0) {
    return fail("invalid_activeBranchRules", "parallel-relevant active rules must contain integer ruleset_id");
  }
  return rule.ruleset_id as number;
}

function parseActiveRules(envelope: InventoryEnvelope): RulesFacts | Failure {
  if (!envelope.complete || !envelope.items) {
    return {
      active: false,
      pullRequestRequired: false,
      requiredChecks: [],
      requiredChecksEnforced: false,
      upToDateRequired: false,
      noBypass: null,
      mergeQueueEnabled: false,
      ruleTypes: [],
      rulesetIds: [],
    };
  }

  let pullRequestRequired = false;
  let upToDateRequired = false;
  let mergeQueueEnabled = false;
  const checks: string[] = [];
  const ruleTypes: string[] = [];
  const ids: number[] = [];

  for (const rawRule of envelope.items) {
    if (!isRecord(rawRule) || typeof rawRule.type !== "string" || rawRule.type.length === 0) {
      return fail("invalid_activeBranchRules", "active branch rules must contain a string type");
    }
    ruleTypes.push(rawRule.type);
    if (!["pull_request", "required_status_checks", "merge_queue"].includes(rawRule.type)) continue;
    const id = rulesetId(rawRule);
    if (typeof id === "object") return id;
    ids.push(id);

    if (rawRule.type === "pull_request") pullRequestRequired = true;
    if (rawRule.type === "merge_queue") mergeQueueEnabled = true;
    if (rawRule.type === "required_status_checks") {
      if (!isRecord(rawRule.parameters) || typeof rawRule.parameters.strict_required_status_checks_policy !== "boolean") {
        return fail("invalid_activeBranchRules", "required_status_checks rule must contain strict_required_status_checks_policy");
      }
      const required = rawRule.parameters.required_status_checks;
      if (!Array.isArray(required)) return fail("invalid_activeBranchRules", "required_status_checks rule must contain required_status_checks array");
      for (const check of required) {
        if (!isRecord(check) || typeof check.context !== "string" || check.context.length === 0) {
          return fail("invalid_activeBranchRules", "ruleset required status checks must contain context");
        }
        checks.push(check.context);
      }
      if (required.length > 0 && rawRule.parameters.strict_required_status_checks_policy) upToDateRequired = true;
    }
  }

  const requiredChecks = sortedUnique(checks);
  return {
    active: pullRequestRequired || requiredChecks.length > 0 || mergeQueueEnabled,
    pullRequestRequired,
    requiredChecks,
    requiredChecksEnforced: requiredChecks.length > 0,
    upToDateRequired,
    noBypass: null,
    mergeQueueEnabled,
    ruleTypes: sortedUnique(ruleTypes),
    rulesetIds: sortedUniqueNumbers(ids),
  };
}

function rulesetBypassState(ids: number[], envelope: InventoryEnvelope): KnownBoolean | Failure {
  if (ids.length === 0) return null;
  if (!envelope.complete || !envelope.items) return null;
  const details = new Map<number, Record<string, unknown>>();
  for (const item of envelope.items) {
    if (!isRecord(item) || !Number.isInteger(item.id) || (item.id as number) < 0) {
      return fail("invalid_rulesets", "ruleset details must contain integer id");
    }
    details.set(item.id as number, item);
  }

  let complete = true;
  for (const id of ids) {
    const detail = details.get(id);
    if (!detail) {
      complete = false;
      continue;
    }
    if (detail.enforcement !== undefined && detail.enforcement !== "active") {
      complete = false;
      continue;
    }
    if (detail.bypass_actors === undefined) {
      complete = false;
      continue;
    }
    if (!Array.isArray(detail.bypass_actors)) return fail("invalid_rulesets", "ruleset bypass_actors must be an array");
    if (detail.bypass_actors.length > 0) return false;
  }
  return complete ? true : null;
}

function effectiveOr(left: boolean, leftComplete: boolean, right: boolean, rightComplete: boolean): KnownBoolean {
  if (left || right) return true;
  return leftComplete && rightComplete ? false : null;
}

function effectiveNoBypass(
  classic: ProtectionFacts,
  classicComplete: boolean,
  rules: RulesFacts,
  rulesComplete: boolean,
): KnownBoolean {
  if (classic.noBypass === false || rules.noBypass === false) return false;
  if (!classicComplete || !rulesComplete) return null;
  const states: KnownBoolean[] = [];
  if (classic.active) states.push(classic.noBypass);
  if (rules.active) states.push(rules.noBypass);
  if (states.length === 0) return false;
  if (states.some((state) => state === null)) return null;
  return true;
}

export function normalizeGitHubControlPlane(input: unknown): ParallelControlPlaneNormalizationResult {
  if (!isRecord(input)) return fail("invalid_input", "control-plane normalization input must be an object");
  if (input.provider !== "portable" && input.provider !== "github_merge_queue") {
    return fail("invalid_provider", "provider must be portable or github_merge_queue");
  }
  if (typeof input.repository !== "string" || !REPOSITORY.test(input.repository)) {
    return fail("invalid_repository", "repository must use owner/name form");
  }
  if (input.defaultBranch !== null && (typeof input.defaultBranch !== "string" || input.defaultBranch.length === 0)) {
    return fail("invalid_default_branch", "defaultBranch must be a non-empty string or null");
  }

  const branchProtection = readBranchProtection(input.branchProtection);
  if ("ok" in branchProtection) return branchProtection;
  const activeRules = readInventory(input.activeBranchRules, "activeBranchRules", "rules");
  if ("ok" in activeRules) return activeRules;
  const rulesets = readInventory(input.rulesets, "rulesets", "items");
  if ("ok" in rulesets) return rulesets;

  const classic = parseClassic(branchProtection);
  if ("ok" in classic) return classic;
  const rules = parseActiveRules(activeRules);
  if ("ok" in rules) return rules;
  const rulesBypass = rulesetBypassState(rules.rulesetIds, rulesets);
  if (typeof rulesBypass === "object" && rulesBypass !== null) return rulesBypass;
  rules.noBypass = rulesBypass;

  const requiredChecks = branchProtection.complete && activeRules.complete
    ? sortedUnique([...classic.requiredChecks, ...rules.requiredChecks])
    : null;
  const facts: NormalizedParallelControlPlaneFacts = {
    targetBranch: input.defaultBranch as string | null,
    requiredChecks,
    pullRequestRequired: effectiveOr(classic.pullRequestRequired, branchProtection.complete, rules.pullRequestRequired, activeRules.complete),
    requiredChecksEnforced: effectiveOr(classic.requiredChecksEnforced, branchProtection.complete, rules.requiredChecksEnforced, activeRules.complete),
    upToDateRequired: effectiveOr(classic.upToDateRequired, branchProtection.complete, rules.upToDateRequired, activeRules.complete),
    noBypass: effectiveNoBypass(classic, branchProtection.complete, rules, activeRules.complete),
    mergeQueueEnabled: activeRules.complete ? rules.mergeQueueEnabled : null,
  };

  return {
    ok: true,
    facts,
    evidence: {
      provider: input.provider,
      repository: input.repository,
      defaultBranch: input.defaultBranch as string | null,
      branchProtectionComplete: branchProtection.complete,
      branchProtected: branchProtection.protected,
      activeBranchRulesComplete: activeRules.complete,
      activeRuleTypes: activeRules.complete ? rules.ruleTypes : null,
      rulesetsComplete: rulesets.complete,
      activeRulesetIds: activeRules.complete ? rules.rulesetIds : null,
    },
  };
}
