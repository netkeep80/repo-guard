const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PENDING_CHECK_STATUSES = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);
const FAILED_CHECK_CONCLUSIONS = new Set([
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
    "neutral",
    "skipped",
]);
function fail(error, message) {
    return { ok: false, error, message };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isSha(value) {
    return typeof value === "string" && SHA.test(value);
}
function isRepository(value) {
    return typeof value === "string" && REPOSITORY.test(value);
}
function normalizePullRequest(input, readyLabel) {
    if (!isRecord(input))
        return fail("malformed_pull_request", "pull request must be an object");
    const base = input.base, head = input.head, labels = input.labels;
    if (!Number.isInteger(input.number) || input.number <= 0)
        return fail("malformed_pull_request", "pull request number must be a positive integer");
    if (typeof input.draft !== "boolean")
        return fail("malformed_pull_request", "pull request draft must be boolean");
    if (input.mergeable !== true && input.mergeable !== false && input.mergeable !== null)
        return fail("malformed_pull_request", "pull request mergeable must be true, false, or null");
    if (!isRecord(base) || !isNonEmptyString(base.ref) || !isSha(base.sha))
        return fail("malformed_pull_request", "pull request base ref/SHA is malformed");
    if (!isRecord(head) || !isNonEmptyString(head.ref) || !isSha(head.sha) || !isRecord(head.repo) || !isRepository(head.repo.full_name))
        return fail("malformed_pull_request", "pull request head ref/SHA/repository is malformed");
    if (!Array.isArray(labels))
        return fail("malformed_pull_request", "pull request labels must be an array");
    const labelNames = [];
    for (const label of labels) {
        if (!isRecord(label) || !isNonEmptyString(label.name))
            return fail("malformed_pull_request", "pull request label is malformed");
        labelNames.push(label.name);
    }
    const mergeability = input.mergeable === true
        ? "mergeable"
        : input.mergeable === false
            ? "conflicting"
            : "unknown";
    return {
        ok: true,
        value: {
            prNumber: input.number,
            baseRef: base.ref,
            baseSha: base.sha,
            headRef: head.ref,
            headSha: head.sha,
            headRepository: head.repo.full_name,
            draft: input.draft,
            ready: !input.draft && labelNames.includes(readyLabel),
            mergeability,
        },
    };
}
function normalizeRequiredChecks(input) {
    if (!isRecord(input))
        return fail("malformed_required_checks", "required checks must be an object");
    const result = { transaction: [], state: [] };
    for (const phase of ["transaction", "state"]) {
        const raw = input[phase];
        if (!Array.isArray(raw) || raw.length === 0)
            return fail("malformed_required_checks", `${phase} required checks must be a non-empty array`);
        const seen = new Set();
        for (const item of raw) {
            if (!isRecord(item) || !isNonEmptyString(item.name) || (item.appSlug !== undefined && !isNonEmptyString(item.appSlug)))
                return fail("malformed_required_checks", `${phase} required check is malformed`);
            const required = item.appSlug === undefined
                ? { name: item.name }
                : { name: item.name, appSlug: item.appSlug };
            const key = `${required.name}\u0000${required.appSlug ?? ""}`;
            if (seen.has(key))
                return fail("malformed_required_checks", `${phase} required check is duplicated`);
            seen.add(key);
            result[phase].push(required);
        }
    }
    return { ok: true, ...result };
}
function normalizeFreshness(input, currentMainSha, headSha) {
    if (!isRecord(input) || !isSha(input.mainSha) || !isSha(input.headSha))
        return fail("malformed_freshness_evidence", "compare evidence must contain exact main/head SHA");
    if (input.mainSha !== currentMainSha || input.headSha !== headSha)
        return fail("stale_freshness_evidence", "compare evidence is not bound to the current main/head snapshot");
    if (input.status === "ahead" || input.status === "identical")
        return { ok: true, status: "current" };
    if (input.status === "behind" || input.status === "diverged")
        return { ok: true, status: "behind" };
    if (input.status === "unknown" || input.status === null)
        return { ok: true, status: "unknown" };
    return fail("unknown_compare_state", "compare evidence contains an unknown status");
}
function checkRunAppSlug(input) {
    if (input.app === null || input.app === undefined)
        return null;
    if (!isRecord(input.app) || !isNonEmptyString(input.app.slug))
        return undefined;
    return input.app.slug;
}
function normalizeObservedCheck(input, headSha) {
    if (!isNonEmptyString(input.name) || !isSha(input.head_sha))
        return fail("malformed_check_run", "required check run name/head SHA is malformed");
    if (input.head_sha !== headSha)
        return fail("stale_check_evidence", "required check run is bound to another head SHA");
    const appSlug = checkRunAppSlug(input);
    if (appSlug === undefined)
        return fail("malformed_check_run", "required check run app identity is malformed");
    if (PENDING_CHECK_STATUSES.has(input.status)) {
        if (input.conclusion !== null && input.conclusion !== undefined)
            return fail("unknown_check_state", "non-completed required check unexpectedly has a conclusion");
        return {
            ok: true,
            evidence: { name: input.name, headSha, status: "pending", conclusion: null, appSlug },
        };
    }
    if (input.status !== "completed")
        return fail("unknown_check_state", "required check run has an unknown status");
    if (input.conclusion === "success") {
        return {
            ok: true,
            evidence: { name: input.name, headSha, status: "success", conclusion: "success", appSlug },
        };
    }
    if (typeof input.conclusion === "string" && FAILED_CHECK_CONCLUSIONS.has(input.conclusion)) {
        return {
            ok: true,
            evidence: { name: input.name, headSha, status: "failure", conclusion: input.conclusion, appSlug },
        };
    }
    return fail("unknown_check_state", "completed required check has an unknown conclusion");
}
function normalizeGate(runs, required, headSha) {
    const evidence = [];
    let missing = false;
    for (const spec of required) {
        const matching = runs.filter((run) => {
            if (!isRecord(run) || run.name !== spec.name)
                return false;
            if (spec.appSlug === undefined)
                return true;
            return checkRunAppSlug(run) === spec.appSlug;
        });
        if (matching.length > 1)
            return fail("duplicate_required_check", `required check ${spec.name} matched more than one run`);
        if (matching.length === 0) {
            missing = true;
            continue;
        }
        const normalized = normalizeObservedCheck(matching[0], headSha);
        if (!normalized.ok)
            return normalized;
        evidence.push(normalized.evidence);
    }
    const status = evidence.some((item) => item.status === "failure")
        ? "failure"
        : evidence.some((item) => item.status === "pending")
            ? "pending"
            : missing
                ? "missing"
                : "success";
    return { ok: true, status, evidence };
}
export function normalizeGitHubCandidate(input) {
    if (!isRecord(input))
        return fail("malformed_candidate", "candidate input must be an object");
    if (!isRepository(input.repository))
        return fail("malformed_repository", "repository identity is malformed");
    if (!isSha(input.currentMainSha))
        return fail("malformed_main", "current main must be an exact 40-character SHA");
    if (!isNonEmptyString(input.readyLabel))
        return fail("malformed_ready_label", "READY label must be non-empty");
    const pr = normalizePullRequest(input.pullRequest, input.readyLabel);
    if (!pr.ok)
        return pr;
    const freshness = normalizeFreshness(input.compare, input.currentMainSha, pr.value.headSha);
    if (!freshness.ok)
        return freshness;
    if (!isRecord(input.checkRuns))
        return fail("malformed_check_inventory", "check-run inventory must be an object");
    if (input.checkRuns.complete !== true)
        return fail("incomplete_check_inventory", "check-run pagination is incomplete");
    if (!isSha(input.checkRuns.headSha))
        return fail("malformed_check_inventory", "check-run inventory head SHA is malformed");
    if (input.checkRuns.headSha !== pr.value.headSha)
        return fail("stale_check_evidence", "check-run inventory is bound to another head SHA");
    if (!Array.isArray(input.checkRuns.runs))
        return fail("malformed_check_inventory", "check-run inventory runs must be an array");
    const required = normalizeRequiredChecks(input.requiredChecks);
    if (!required.ok)
        return required;
    const transaction = normalizeGate(input.checkRuns.runs, required.transaction, pr.value.headSha);
    if (!transaction.ok)
        return transaction;
    const state = normalizeGate(input.checkRuns.runs, required.state, pr.value.headSha);
    if (!state.ok)
        return state;
    const snapshot = {
        currentMainSha: input.currentMainSha,
        prNumber: pr.value.prNumber,
        baseRef: pr.value.baseRef,
        baseSha: pr.value.baseSha,
        headSha: pr.value.headSha,
        ready: pr.value.ready,
        mergeability: pr.value.mergeability,
        freshness: { mainSha: input.currentMainSha, status: freshness.status },
        transaction: { headSha: pr.value.headSha, status: transaction.status },
        state: { headSha: pr.value.headSha, status: state.status },
    };
    return {
        ok: true,
        repository: input.repository,
        snapshot,
        evidence: { transaction: transaction.evidence, state: state.evidence },
    };
}
export function normalizeGitHubReadyInventory(input) {
    if (!isRecord(input))
        return fail("malformed_pr_inventory", "PR inventory must be an object");
    if (!isRepository(input.repository))
        return fail("malformed_repository", "repository identity is malformed");
    if (!isNonEmptyString(input.readyLabel))
        return fail("malformed_ready_label", "READY label must be non-empty");
    if (input.complete !== true)
        return fail("incomplete_pr_inventory", "PR inventory pagination is incomplete");
    if (!Array.isArray(input.pages) || input.pages.some((page) => !Array.isArray(page)))
        return fail("malformed_pr_inventory", "PR inventory pages must be arrays");
    const items = [];
    const seen = new Set();
    for (const page of input.pages) {
        for (const raw of page) {
            const normalized = normalizePullRequest(raw, input.readyLabel);
            if (!normalized.ok)
                return normalized;
            if (seen.has(normalized.value.prNumber))
                return fail("malformed_pr_inventory", `PR #${normalized.value.prNumber} appears more than once`);
            seen.add(normalized.value.prNumber);
            items.push(normalized.value);
        }
    }
    return {
        ok: true,
        repository: input.repository,
        items,
        readyPrNumbers: items.filter((item) => item.ready).map((item) => item.prNumber),
    };
}
