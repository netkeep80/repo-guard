type GitHubMutationRequest = {
  method: "PUT";
  path: string;
  body: Record<string, string>;
};

type GitHubMutationResponse = {
  status: number;
  body: unknown;
};

type GitHubMutationTransport = {
  request(request: GitHubMutationRequest): Promise<GitHubMutationResponse>;
};

type Failure = {
  ok: false;
  error: string;
  message: string;
};

type UpdateSuccess = {
  ok: true;
  kind: "update_accepted";
  expectedHeadSha: string;
  rereadRequired: true;
};

type MergeMethod = "merge" | "squash" | "rebase";

type MergeSuccess = {
  ok: true;
  kind: "merged";
  expectedHeadSha: string;
  mergeSha: string;
  mergeMethod: MergeMethod;
};

export type GitHubUpdateBranchResult = Failure | UpdateSuccess;
export type GitHubMergeExactHeadResult = Failure | MergeSuccess;

const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MERGE_METHODS = new Set<MergeMethod>(["merge", "squash", "rebase"]);

function fail(error: string, message: string): Failure {
  return { ok: false, error, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

function isRepository(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === "string" && MERGE_METHODS.has(value as MergeMethod);
}

function normalizeTransport(input: unknown): GitHubMutationTransport | null {
  if (!isRecord(input) || typeof input.request !== "function") return null;
  return input as unknown as GitHubMutationTransport;
}

function normalizeResponse(input: unknown): GitHubMutationResponse | null {
  if (!isRecord(input) || !Number.isInteger(input.status)) return null;
  return { status: input.status as number, body: input.body };
}

function updateFailure(status: number, body: unknown): Failure {
  const suffix = responseMessage(body);
  if (status === 403) return fail("forbidden", `update-branch is forbidden${suffix}`);
  if (status === 409) return fail("conflict", `update-branch conflicts with current repository state${suffix}`);
  if (status === 422) return fail("stale_head", `update-branch expected head is stale or invalid${suffix}`);
  return fail("unexpected_response", `update-branch returned unexpected HTTP ${status}${suffix}`);
}

function mergeFailure(status: number, body: unknown): Failure {
  const suffix = responseMessage(body);
  if (status === 403) return fail("forbidden", `merge is forbidden${suffix}`);
  if (status === 404) return fail("not_found", `pull request was not found${suffix}`);
  if (status === 405) return fail("merge_not_allowed", `pull request cannot be merged by this endpoint${suffix}`);
  if (status === 409) return fail("stale_head", `merge expected head is stale${suffix}`);
  if (status === 422) return fail("validation_failed", `merge request failed validation${suffix}`);
  return fail("unexpected_response", `merge returned unexpected HTTP ${status}${suffix}`);
}

function responseMessage(body: unknown): string {
  if (!isRecord(body) || typeof body.message !== "string" || body.message.length === 0) return "";
  return `: ${body.message}`;
}

function validateCommonInput(input: unknown): Failure | {
  repository: string;
  prNumber: number;
  expectedHeadSha: string;
} {
  if (!isRecord(input)) return fail("invalid_input", "mutation input must be an object");
  if (!isRepository(input.repository)) return fail("invalid_input", "repository must be owner/name");
  if (!isPositiveInteger(input.prNumber)) return fail("invalid_input", "PR number must be a positive integer");
  if (!isSha(input.expectedHeadSha)) return fail("invalid_input", "expected head must be an exact 40-character SHA");
  return {
    repository: input.repository,
    prNumber: input.prNumber,
    expectedHeadSha: input.expectedHeadSha,
  };
}

export function createGitHubWriteAdapter(transportInput: unknown) {
  const transport = normalizeTransport(transportInput);

  return {
    async updateBranch(input: unknown): Promise<GitHubUpdateBranchResult> {
      const common = validateCommonInput(input);
      if ("ok" in common && common.ok === false) return common;
      if (transport === null) return fail("invalid_transport", "write transport must expose an async request function");

      let rawResponse: unknown;
      try {
        rawResponse = await transport.request({
          method: "PUT",
          path: `/repos/${common.repository}/pulls/${common.prNumber}/update-branch`,
          body: { expected_head_sha: common.expectedHeadSha },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail("transport_error", `update-branch transport failed: ${message}`);
      }

      const response = normalizeResponse(rawResponse);
      if (response === null) return fail("malformed_response", "update-branch transport returned a malformed response");
      if (response.status !== 202) return updateFailure(response.status, response.body);

      return {
        ok: true,
        kind: "update_accepted",
        expectedHeadSha: common.expectedHeadSha,
        rereadRequired: true,
      };
    },

    async mergeExactHead(input: unknown): Promise<GitHubMergeExactHeadResult> {
      const common = validateCommonInput(input);
      if ("ok" in common && common.ok === false) return common;
      if (!isRecord(input) || !isMergeMethod(input.mergeMethod))
        return fail("invalid_input", "merge method must be merge, squash, or rebase");
      if (transport === null) return fail("invalid_transport", "write transport must expose an async request function");

      let rawResponse: unknown;
      try {
        rawResponse = await transport.request({
          method: "PUT",
          path: `/repos/${common.repository}/pulls/${common.prNumber}/merge`,
          body: {
            sha: common.expectedHeadSha,
            merge_method: input.mergeMethod,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail("transport_error", `merge transport failed: ${message}`);
      }

      const response = normalizeResponse(rawResponse);
      if (response === null) return fail("malformed_response", "merge transport returned a malformed response");
      if (response.status !== 200) return mergeFailure(response.status, response.body);
      if (!isRecord(response.body)) return fail("malformed_response", "merge success response body must be an object");
      if (response.body.merged === false) return fail("merge_rejected", `GitHub did not merge the pull request${responseMessage(response.body)}`);
      if (response.body.merged !== true || !isSha(response.body.sha))
        return fail("malformed_response", "merge success response must contain merged=true and an exact merge SHA");

      return {
        ok: true,
        kind: "merged",
        expectedHeadSha: common.expectedHeadSha,
        mergeSha: response.body.sha,
        mergeMethod: input.mergeMethod,
      };
    },
  };
}
