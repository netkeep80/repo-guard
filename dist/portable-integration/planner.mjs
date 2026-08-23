const SHA_PATTERN = /^[0-9a-f]{40}$/i;
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isSha(value) {
    return typeof value === "string" && SHA_PATTERN.test(value);
}
function isPositiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function isMergeability(value) {
    return value === "mergeable" || value === "conflicting" || value === "unknown";
}
function isFreshnessStatus(value) {
    return value === "current" || value === "behind" || value === "unknown";
}
function isGateStatus(value) {
    return value === "success" || value === "pending" || value === "failure" || value === "missing";
}
function decision(kind, reason, identity) {
    return {
        kind,
        prNumber: identity.prNumber,
        mainSha: identity.mainSha,
        headSha: identity.headSha,
        reason,
    };
}
function looseIdentity(input) {
    if (!isObject(input))
        return { prNumber: null, mainSha: null, headSha: null };
    return {
        prNumber: isPositiveInteger(input.prNumber) ? input.prNumber : null,
        mainSha: isSha(input.currentMainSha) ? input.currentMainSha : null,
        headSha: isSha(input.headSha) ? input.headSha : null,
    };
}
function hasValidIdentity(input) {
    return isSha(input.currentMainSha)
        && isPositiveInteger(input.prNumber)
        && isNonEmptyString(input.baseRef)
        && isSha(input.baseSha)
        && isSha(input.headSha)
        && typeof input.ready === "boolean";
}
function hasValidFreshness(value) {
    return isObject(value) && isSha(value.mainSha) && isFreshnessStatus(value.status);
}
function hasValidGate(value) {
    return isObject(value) && isSha(value.headSha) && isGateStatus(value.status);
}
export function planPortableIntegration(input) {
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
