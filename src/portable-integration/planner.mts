export type PortableDecisionKind =
  | "ignore_not_ready"
  | "refresh_branch"
  | "wait_for_checks"
  | "merge_exact_head"
  | "block_conflict"
  | "block_failed_checks"
  | "invalid_snapshot";

export type PortableDecisionReason =
  | "not_ready"
  | "branch_behind"
  | "merge_conflict"
  | "checks_failed"
  | "checks_pending"
  | "malformed_snapshot"
  | "freshness_stale"
  | "freshness_unknown"
  | "mergeability_unknown"
  | "evidence_stale"
  | "ready_to_merge";

export type PortableMergeability = "mergeable" | "conflicting" | "unknown";
export type PortableFreshnessStatus = "current" | "behind" | "unknown";
export type PortableGateStatus = "success" | "pending" | "failure" | "missing";

export interface PortableFreshnessEvidence {
  mainSha: string;
  status: PortableFreshnessStatus;
}

export interface PortableGateEvidence {
  headSha: string;
  status: PortableGateStatus;
}

export interface PortableCandidateSnapshot {
  currentMainSha: string;
  prNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  ready: boolean;
  mergeability: PortableMergeability;
  freshness: PortableFreshnessEvidence;
  transaction: PortableGateEvidence;
  state: PortableGateEvidence;
}

export interface PortableIntegrationDecision {
  kind: PortableDecisionKind;
  prNumber: number | null;
  mainSha: string | null;
  headSha: string | null;
  reason: PortableDecisionReason;
}

type LooseObject = Record<string, unknown>;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function isObject(value: unknown): value is LooseObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isMergeability(value: unknown): value is PortableMergeability {
  return value === "mergeable" || value === "conflicting" || value === "unknown";
}

function isFreshnessStatus(value: unknown): value is PortableFreshnessStatus {
  return value === "current" || value === "behind" || value === "unknown";
}

function isGateStatus(value: unknown): value is PortableGateStatus {
  return value === "success" || value === "pending" || value === "failure" || value === "missing";
}

function decision(
  kind: PortableDecisionKind,
  reason: PortableDecisionReason,
  identity: { prNumber: number | null; mainSha: string | null; headSha: string | null },
): PortableIntegrationDecision {
  return {
    kind,
    prNumber: identity.prNumber,
    mainSha: identity.mainSha,
    headSha: identity.headSha,
    reason,
  };
}

function looseIdentity(input: unknown) {
  if (!isObject(input)) return { prNumber: null, mainSha: null, headSha: null };
  return {
    prNumber: isPositiveInteger(input.prNumber) ? input.prNumber : null,
    mainSha: isSha(input.currentMainSha) ? input.currentMainSha : null,
    headSha: isSha(input.headSha) ? input.headSha : null,
  };
}

function hasValidIdentity(input: LooseObject): input is LooseObject & {
  currentMainSha: string;
  prNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  ready: boolean;
} {
  return isSha(input.currentMainSha)
    && isPositiveInteger(input.prNumber)
    && isNonEmptyString(input.baseRef)
    && isSha(input.baseSha)
    && isSha(input.headSha)
    && typeof input.ready === "boolean";
}

function hasValidFreshness(value: unknown): value is PortableFreshnessEvidence {
  return isObject(value) && isSha(value.mainSha) && isFreshnessStatus(value.status);
}

function hasValidGate(value: unknown): value is PortableGateEvidence {
  return isObject(value) && isSha(value.headSha) && isGateStatus(value.status);
}

export function planPortableIntegration(input: unknown): PortableIntegrationDecision {
  const identity = looseIdentity(input);
  if (!isObject(input) || !hasValidIdentity(input)) {
    return decision("invalid_snapshot", "malformed_snapshot", identity);
  }

  const exactIdentity = {
    prNumber: input.prNumber,
    mainSha: input.currentMainSha,
    headSha: input.headSha,
  };

  if (!input.ready) {
    return decision("ignore_not_ready", "not_ready", exactIdentity);
  }

  if (!isMergeability(input.mergeability)
    || !hasValidFreshness(input.freshness)
    || !hasValidGate(input.transaction)
    || !hasValidGate(input.state)) {
    return decision("invalid_snapshot", "malformed_snapshot", exactIdentity);
  }

  if (input.freshness.mainSha !== input.currentMainSha) {
    return decision("invalid_snapshot", "freshness_stale", exactIdentity);
  }

  if (input.mergeability === "unknown") {
    return decision("invalid_snapshot", "mergeability_unknown", exactIdentity);
  }

  if (input.mergeability === "conflicting") {
    return decision("block_conflict", "merge_conflict", exactIdentity);
  }

  if (input.freshness.status === "unknown") {
    return decision("invalid_snapshot", "freshness_unknown", exactIdentity);
  }

  if (input.freshness.status === "behind") {
    return decision("refresh_branch", "branch_behind", exactIdentity);
  }

  if (input.transaction.headSha !== input.headSha || input.state.headSha !== input.headSha) {
    return decision("invalid_snapshot", "evidence_stale", exactIdentity);
  }

  if (input.transaction.status === "failure" || input.state.status === "failure") {
    return decision("block_failed_checks", "checks_failed", exactIdentity);
  }

  if (input.transaction.status !== "success" || input.state.status !== "success") {
    return decision("wait_for_checks", "checks_pending", exactIdentity);
  }

  return decision("merge_exact_head", "ready_to_merge", exactIdentity);
}
