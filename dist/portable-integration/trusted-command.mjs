import { normalizeGitHubCandidate, normalizeGitHubReadyInventory, } from "./github-read.mjs";
import { createGitHubWriteAdapter } from "./github-write.mjs";
import { runPortableCoordinatorPass, } from "./coordinator.mjs";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isRepository(value) {
    return typeof value === "string" && REPOSITORY.test(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isMergeMethod(value) {
    return typeof value === "string" && MERGE_METHODS.has(value);
}
function invalidEvidence(error, message) {
    return {
        provider: "portable",
        kind: "invalid_input",
        repository: null,
        main_sha: null,
        pr: null,
        head_sha: null,
        decision: null,
        reason: null,
        mutation: "none",
        result: null,
        error,
        message,
    };
}
function projectEvidence(pass) {
    return {
        provider: "portable",
        kind: pass.kind,
        repository: pass.repository,
        main_sha: pass.mainSha,
        pr: pass.prNumber,
        head_sha: pass.headSha,
        decision: pass.decision?.kind ?? null,
        reason: pass.decision?.reason ?? null,
        mutation: pass.mutation,
        result: pass.result,
        ...(pass.error === undefined ? {} : { error: pass.error }),
        ...(pass.message === undefined ? {} : { message: pass.message }),
    };
}
function overlayTrustedFields(raw, trusted) {
    if (!isObject(raw))
        return raw;
    return { ...raw, ...trusted };
}
export async function runTrustedPortableCoordinator(input) {
    if (!isObject(input)) {
        return invalidEvidence("malformed_input", "trusted coordinator input must be an object");
    }
    if (!isRepository(input.repository)) {
        return invalidEvidence("malformed_repository", "repository identity must be owner/name");
    }
    if (!isNonEmptyString(input.readyLabel)) {
        return invalidEvidence("malformed_ready_label", "READY label must be non-empty");
    }
    if (!isMergeMethod(input.mergeMethod)) {
        return invalidEvidence("invalid_merge_method", "merge method must be merge, squash, or rebase");
    }
    if (typeof input.readReadyInventory !== "function" || typeof input.readCandidate !== "function") {
        return invalidEvidence("invalid_readers", "trusted coordinator readers must be callable");
    }
    const repository = input.repository;
    const readyLabel = input.readyLabel;
    const mergeMethod = input.mergeMethod;
    const requiredChecks = input.requiredChecks;
    const readReadyInventory = input.readReadyInventory;
    const readCandidate = input.readCandidate;
    const writer = createGitHubWriteAdapter(input.mutationTransport);
    let inventory;
    try {
        const rawInventory = await readReadyInventory();
        inventory = normalizeGitHubReadyInventory(overlayTrustedFields(rawInventory, {
            repository,
            readyLabel,
        }));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        inventory = {
            ok: false,
            error: "inventory_read_error",
            message: `READY inventory read failed: ${message}`,
        };
    }
    const pass = await runPortableCoordinatorPass({
        inventory,
        mergeMethod,
        loadCandidate: async (prNumber) => {
            const rawCandidate = await readCandidate(prNumber);
            const normalized = normalizeGitHubCandidate(overlayTrustedFields(rawCandidate, {
                repository,
                readyLabel,
                requiredChecks,
            }));
            if (!normalized.ok) {
                throw new Error(`${normalized.error}: ${normalized.message}`);
            }
            if (normalized.repository !== repository) {
                throw new Error("candidate repository identity changed during normalization");
            }
            return normalized.snapshot;
        },
        updateBranch: writer.updateBranch,
        mergeExactHead: writer.mergeExactHead,
    });
    return projectEvidence(pass);
}
