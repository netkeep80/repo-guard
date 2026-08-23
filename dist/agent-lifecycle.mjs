export const AGENT_LIFECYCLE_STATES = [
    "fix_pr",
    "ready_for_integration",
    "queued",
    "integrating",
    "blocked_ci",
    "fix_conflict",
    "misconfigured",
    "merged",
];
export const AGENT_NEXT_ACTIONS = [
    "fix_pr",
    "enqueue",
    "wait",
    "inspect_failure",
    "configure_repository",
    "none",
];
const SHA = /^[0-9a-f]{40}$/i;
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isProvider(value) {
    return value === "legacy" || value === "portable" || value === "github_merge_queue";
}
function isConfigurationStatus(value) {
    return value === "ready" || value === "misconfigured" || value === "unknown";
}
function isGateStatus(value) {
    return value === "success" || value === "pending" || value === "failure" || value === "missing";
}
function isSha(value) {
    return typeof value === "string" && SHA.test(value);
}
function isPositiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function invalid(message) {
    return { ok: false, error: "malformed_lifecycle_facts", message };
}
function normalizeFacts(input) {
    if (!isObject(input))
        return invalid("lifecycle facts must be an object");
    if (!isProvider(input.provider))
        return invalid("provider must be legacy, portable, or github_merge_queue");
    if (!isConfigurationStatus(input.configuration_status))
        return invalid("configuration_status is missing or unknown");
    if (!isPositiveInteger(input.pr))
        return invalid("pr must be a positive integer");
    if (!isSha(input.base_sha) || !isSha(input.head_sha))
        return invalid("base_sha and head_sha must be exact 40-character SHAs");
    for (const field of ["branch_behind", "merged", "queued", "integrating", "merge_conflict"]) {
        if (typeof input[field] !== "boolean")
            return invalid(`${field} must be boolean`);
    }
    if (!isGateStatus(input.transaction_status) || !isGateStatus(input.state_status)) {
        return invalid("transaction_status and state_status must be finite gate states");
    }
    return {
        provider: input.provider,
        configuration_status: input.configuration_status,
        pr: input.pr,
        base_sha: input.base_sha,
        head_sha: input.head_sha,
        branch_behind: input.branch_behind,
        merged: input.merged,
        queued: input.queued,
        integrating: input.integrating,
        merge_conflict: input.merge_conflict,
        transaction_status: input.transaction_status,
        state_status: input.state_status,
    };
}
function projection(facts, state, next_action, requires_agent_branch_update = false) {
    return {
        ok: true,
        value: {
            state,
            next_action,
            protocol: facts.provider === "legacy" ? "legacy" : "parallel",
            provider: facts.provider,
            pr: facts.pr,
            base_sha: facts.base_sha,
            head_sha: facts.head_sha,
            branch_behind: facts.branch_behind,
            requires_agent_branch_update,
        },
    };
}
export function projectAgentLifecycle(input) {
    const normalized = normalizeFacts(input);
    if ("ok" in normalized)
        return normalized;
    const facts = normalized;
    if (facts.configuration_status !== "ready") {
        return projection(facts, "misconfigured", "configure_repository");
    }
    if (facts.merged) {
        return projection(facts, "merged", "none");
    }
    if (facts.merge_conflict) {
        return projection(facts, "fix_conflict", "fix_pr");
    }
    if (facts.transaction_status === "failure") {
        return projection(facts, "fix_pr", "fix_pr");
    }
    if (facts.state_status === "failure") {
        return projection(facts, "blocked_ci", "inspect_failure");
    }
    if (facts.transaction_status === "missing" || facts.state_status === "missing") {
        return projection(facts, "blocked_ci", "inspect_failure");
    }
    if (facts.integrating) {
        return projection(facts, "integrating", "wait");
    }
    if (facts.queued) {
        return projection(facts, "queued", "wait");
    }
    if (facts.transaction_status === "pending" || facts.state_status === "pending") {
        return projection(facts, "blocked_ci", "wait");
    }
    if (facts.provider === "legacy" && facts.branch_behind) {
        return projection(facts, "fix_pr", "fix_pr", true);
    }
    return projection(facts, "ready_for_integration", "enqueue");
}
