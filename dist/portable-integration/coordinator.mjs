import { planPortableIntegration, } from "./planner.mjs";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isPositiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isRepository(value) {
    return typeof value === "string" && REPOSITORY.test(value);
}
function isMergeMethod(value) {
    return typeof value === "string" && MERGE_METHODS.has(value);
}
function invalid(kind, error, message) {
    return {
        kind,
        repository: null,
        prNumber: null,
        mainSha: null,
        headSha: null,
        decision: null,
        mutation: "none",
        result: null,
        error,
        message,
    };
}
function normalizeInventory(input) {
    if (!isObject(input)) {
        return {
            ok: false,
            result: invalid("invalid_inventory", "malformed_inventory", "READY inventory must be an object"),
        };
    }
    if (input.ok === false) {
        const error = typeof input.error === "string" ? input.error : "inventory_unavailable";
        const message = typeof input.message === "string" ? input.message : "READY inventory is unavailable or incomplete";
        return { ok: false, result: invalid("invalid_inventory", error, message) };
    }
    if (input.ok !== true || !isRepository(input.repository) || !Array.isArray(input.readyPrNumbers)) {
        return {
            ok: false,
            result: invalid("invalid_inventory", "malformed_inventory", "READY inventory is malformed"),
        };
    }
    const seen = new Set();
    const readyPrNumbers = [];
    for (const value of input.readyPrNumbers) {
        if (!isPositiveInteger(value) || seen.has(value)) {
            return {
                ok: false,
                result: invalid("invalid_inventory", "invalid_ready_membership", "READY inventory must contain unique positive PR numbers"),
            };
        }
        seen.add(value);
        readyPrNumbers.push(value);
    }
    readyPrNumbers.sort((left, right) => left - right);
    return {
        ok: true,
        value: {
            repository: input.repository,
            readyPrNumbers,
        },
    };
}
function observed(repository, decision, error, message) {
    return {
        kind: "observed",
        repository,
        prNumber: decision?.prNumber ?? null,
        mainSha: decision?.mainSha ?? null,
        headSha: decision?.headSha ?? null,
        decision,
        mutation: "none",
        result: null,
        ...(error === undefined ? {} : { error }),
        ...(message === undefined ? {} : { message }),
    };
}
function mutationAttempt(repository, decision, mutation, result) {
    return {
        kind: "mutation_attempted",
        repository,
        prNumber: decision.prNumber,
        mainSha: decision.mainSha,
        headSha: decision.headSha,
        decision,
        mutation,
        result,
    };
}
export async function runPortableCoordinatorPass(input) {
    if (!isObject(input)) {
        return invalid("invalid_input", "malformed_input", "coordinator input must be an object");
    }
    if (!isMergeMethod(input.mergeMethod)) {
        return invalid("invalid_input", "invalid_merge_method", "merge method must be merge, squash, or rebase");
    }
    if (typeof input.loadCandidate !== "function"
        || typeof input.updateBranch !== "function"
        || typeof input.mergeExactHead !== "function") {
        return invalid("invalid_input", "invalid_dependencies", "coordinator dependencies must be callable");
    }
    const normalizedInventory = normalizeInventory(input.inventory);
    if (!normalizedInventory.ok)
        return normalizedInventory.result;
    const { repository, readyPrNumbers } = normalizedInventory.value;
    if (readyPrNumbers.length === 0) {
        return {
            kind: "idle",
            repository,
            prNumber: null,
            mainSha: null,
            headSha: null,
            decision: null,
            mutation: "none",
            result: null,
        };
    }
    const loadCandidate = input.loadCandidate;
    const updateBranch = input.updateBranch;
    const mergeExactHead = input.mergeExactHead;
    let lastObservation = null;
    for (const readyPrNumber of readyPrNumbers) {
        let snapshot;
        try {
            snapshot = await loadCandidate(readyPrNumber);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lastObservation = observed(repository, null, "candidate_load_error", message);
            continue;
        }
        const decision = planPortableIntegration(snapshot);
        if (decision.prNumber !== null && decision.prNumber !== readyPrNumber) {
            lastObservation = observed(repository, decision, "candidate_identity_mismatch", `READY PR ${readyPrNumber} loaded snapshot for PR ${decision.prNumber}`);
            continue;
        }
        if (decision.kind === "refresh_branch") {
            if (decision.prNumber === null || decision.headSha === null) {
                lastObservation = observed(repository, decision, "missing_mutation_identity", "refresh decision lacks exact PR/head identity");
                continue;
            }
            let result;
            try {
                result = await updateBranch({
                    repository,
                    prNumber: decision.prNumber,
                    expectedHeadSha: decision.headSha,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result = { ok: false, error: "mutation_transport_error", message };
            }
            return mutationAttempt(repository, decision, "refresh_branch", result);
        }
        if (decision.kind === "merge_exact_head") {
            if (decision.prNumber === null || decision.headSha === null) {
                lastObservation = observed(repository, decision, "missing_mutation_identity", "merge decision lacks exact PR/head identity");
                continue;
            }
            let result;
            try {
                result = await mergeExactHead({
                    repository,
                    prNumber: decision.prNumber,
                    expectedHeadSha: decision.headSha,
                    mergeMethod: input.mergeMethod,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result = { ok: false, error: "mutation_transport_error", message };
            }
            return mutationAttempt(repository, decision, "merge_exact_head", result);
        }
        lastObservation = observed(repository, decision);
    }
    return lastObservation ?? {
        kind: "idle",
        repository,
        prNumber: null,
        mainSha: null,
        headSha: null,
        decision: null,
        mutation: "none",
        result: null,
    };
}
