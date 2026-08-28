const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
function fail(error, message) {
    return { ok: false, error, message };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSha(value) {
    return typeof value === "string" && SHA.test(value);
}
function isRepository(value) {
    return typeof value === "string" && REPOSITORY.test(value);
}
function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}
function isMergeMethod(value) {
    return typeof value === "string" && MERGE_METHODS.has(value);
}
function isBranchRefName(value) {
    if (typeof value !== "string" || value.length === 0)
        return false;
    if (value === "@" || value.startsWith("-") || value.startsWith("/") || value.endsWith("/")
        || value.includes("//") || value.includes("..") || value.includes("@{") || value.endsWith("."))
        return false;
    for (const component of value.split("/")) {
        if (component.length === 0 || component.startsWith(".") || component.endsWith(".lock"))
            return false;
    }
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character))
            return false;
    }
    return true;
}
function encodeBranchPath(value) {
    return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
function normalizeTransport(input) {
    if (!isRecord(input) || typeof input.request !== "function")
        return null;
    return input;
}
function normalizeResponse(input) {
    if (!isRecord(input) || !Number.isInteger(input.status))
        return null;
    return { status: input.status, body: input.body };
}
function updateFailure(status, body) {
    const suffix = responseMessage(body);
    if (status === 403)
        return fail("forbidden", `update-branch is forbidden${suffix}`);
    if (status === 409)
        return fail("conflict", `update-branch conflicts with current repository state${suffix}`);
    if (status === 422)
        return fail("stale_head", `update-branch expected head is stale or invalid${suffix}`);
    return fail("unexpected_response", `update-branch returned unexpected HTTP ${status}${suffix}`);
}
function mergeFailure(status, body) {
    const suffix = responseMessage(body);
    if (status === 403)
        return fail("forbidden", `merge is forbidden${suffix}`);
    if (status === 404)
        return fail("not_found", `pull request was not found${suffix}`);
    if (status === 405)
        return fail("merge_not_allowed", `pull request cannot be merged by this endpoint${suffix}`);
    if (status === 409)
        return fail("stale_head", `merge expected head is stale${suffix}`);
    if (status === 422)
        return fail("validation_failed", `merge request failed validation${suffix}`);
    return fail("unexpected_response", `merge returned unexpected HTTP ${status}${suffix}`);
}
function responseMessage(body) {
    if (!isRecord(body) || typeof body.message !== "string" || body.message.length === 0)
        return "";
    return `: ${body.message}`;
}
function validateCommonInput(input) {
    if (!isRecord(input))
        return fail("invalid_input", "mutation input must be an object");
    if (!isRepository(input.repository))
        return fail("invalid_input", "repository must be owner/name");
    if (!isPositiveInteger(input.prNumber))
        return fail("invalid_input", "PR number must be a positive integer");
    if (!isSha(input.expectedHeadSha))
        return fail("invalid_input", "expected head must be an exact 40-character SHA");
    return {
        ok: true,
        value: {
            repository: input.repository,
            prNumber: input.prNumber,
            expectedHeadSha: input.expectedHeadSha,
        },
    };
}
export function createGitHubWriteAdapter(transportInput) {
    const transport = normalizeTransport(transportInput);
    return {
        async updateBranch(input) {
            const common = validateCommonInput(input);
            if (!common.ok)
                return common;
            const valid = common.value;
            if (transport === null)
                return fail("invalid_transport", "write transport must expose an async request function");
            let rawResponse;
            try {
                rawResponse = await transport.request({
                    method: "PUT",
                    path: `/repos/${valid.repository}/pulls/${valid.prNumber}/update-branch`,
                    body: { expected_head_sha: valid.expectedHeadSha },
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return fail("transport_error", `update-branch transport failed: ${message}`);
            }
            const response = normalizeResponse(rawResponse);
            if (response === null)
                return fail("malformed_response", "update-branch transport returned a malformed response");
            if (response.status !== 202)
                return updateFailure(response.status, response.body);
            return {
                ok: true,
                kind: "update_accepted",
                expectedHeadSha: valid.expectedHeadSha,
                rereadRequired: true,
            };
        },
        async mergeExactHead(input) {
            const common = validateCommonInput(input);
            if (!common.ok)
                return common;
            const valid = common.value;
            if (!isRecord(input) || !isMergeMethod(input.mergeMethod))
                return fail("invalid_input", "merge method must be merge, squash, or rebase");
            if (transport === null)
                return fail("invalid_transport", "write transport must expose an async request function");
            let rawResponse;
            try {
                rawResponse = await transport.request({
                    method: "PUT",
                    path: `/repos/${valid.repository}/pulls/${valid.prNumber}/merge`,
                    body: {
                        sha: valid.expectedHeadSha,
                        merge_method: input.mergeMethod,
                    },
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return fail("transport_error", `merge transport failed: ${message}`);
            }
            const response = normalizeResponse(rawResponse);
            if (response === null)
                return fail("malformed_response", "merge transport returned a malformed response");
            if (response.status !== 200)
                return mergeFailure(response.status, response.body);
            if (!isRecord(response.body))
                return fail("malformed_response", "merge success response body must be an object");
            if (response.body.merged === false)
                return fail("merge_rejected", `GitHub did not merge the pull request${responseMessage(response.body)}`);
            if (response.body.merged !== true || !isSha(response.body.sha))
                return fail("malformed_response", "merge success response must contain merged=true and an exact merge SHA");
            return {
                ok: true,
                kind: "merged",
                expectedHeadSha: valid.expectedHeadSha,
                mergeSha: response.body.sha,
                mergeMethod: input.mergeMethod,
            };
        },
        async deleteMergedBranchExact(input) {
            const common = validateCommonInput(input);
            if (!common.ok)
                return common;
            const valid = common.value;
            if (!isRecord(input) || input.kind !== "delete_merged_branch" || !isBranchRefName(input.branchName))
                return fail("invalid_input", "branch deletion requires planner kind delete_merged_branch and a valid branch name");
            if (transport === null)
                return fail("invalid_transport", "write transport must expose an async request function");
            const branchName = input.branchName;
            const encodedBranch = encodeBranchPath(branchName);
            let rawRead;
            try {
                rawRead = await transport.request({
                    method: "GET",
                    path: `/repos/${valid.repository}/git/ref/heads/${encodedBranch}`,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return fail("transport_error", `branch reread transport failed: ${message}`);
            }
            const read = normalizeResponse(rawRead);
            if (read === null)
                return fail("malformed_response", "branch reread transport returned a malformed response");
            if (read.status === 404) {
                return {
                    ok: true,
                    kind: "already_absent",
                    branchName,
                    prNumber: valid.prNumber,
                    expectedHeadSha: valid.expectedHeadSha,
                };
            }
            if (read.status !== 200)
                return fail("unexpected_response", `branch reread returned unexpected HTTP ${read.status}${responseMessage(read.body)}`);
            if (!isRecord(read.body) || read.body.ref !== `refs/heads/${branchName}` || !isRecord(read.body.object) || !isSha(read.body.object.sha))
                return fail("malformed_response", "branch reread must contain the exact ref and commit SHA");
            if (read.body.object.sha !== valid.expectedHeadSha)
                return fail("stale_head", "branch moved after merged-head evidence was collected");
            let rawDelete;
            try {
                rawDelete = await transport.request({
                    method: "DELETE",
                    path: `/repos/${valid.repository}/git/refs/heads/${encodedBranch}`,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return fail("transport_error", `branch delete transport failed: ${message}`);
            }
            const deletion = normalizeResponse(rawDelete);
            if (deletion === null)
                return fail("malformed_response", "branch delete transport returned a malformed response");
            if (deletion.status !== 204)
                return fail("unexpected_response", `branch delete returned unexpected HTTP ${deletion.status}${responseMessage(deletion.body)}`);
            return {
                ok: true,
                kind: "deleted",
                branchName,
                prNumber: valid.prNumber,
                expectedHeadSha: valid.expectedHeadSha,
            };
        },
    };
}
