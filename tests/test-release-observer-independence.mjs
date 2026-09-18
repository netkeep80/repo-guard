import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { observeReleaseTruth } from "../scripts/verify-release-ref.mjs";

const tag = "v3.1.0";
const releaseUrl = "https://example.invalid/releases/v3.1.0";

function response(status, body = {}) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const route = routes.find(([suffix]) => url.endsWith(suffix));
    if (!route) return response(404, { message: "not found" });
    return response(route[1], route[2] ?? {});
  };
}

function stableRelease() {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: releaseUrl,
  };
}

describe("independent release truth observation", () => {
  it("observes an existing stable GitHub Release even when the Git tag is absent", async () => {
    const calls = [];
    const truth = await observeReleaseTruth({
      repo: "netkeep80/repo-guard",
      tag,
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v3.1.0", 404],
        ["/repos/netkeep80/repo-guard/releases/tags/v3.1.0", 200, stableRelease()],
      ], calls),
    });

    assert.deepEqual(truth, {
      tag,
      tag_exists: false,
      tag_commit: null,
      release_exists: true,
      published: true,
      draft: false,
      prerelease: false,
      release_url: releaseUrl,
    });
    assert.deepEqual(calls, [
      "https://api.github.com/repos/netkeep80/repo-guard/git/ref/tags/v3.1.0",
      "https://api.github.com/repos/netkeep80/repo-guard/releases/tags/v3.1.0",
    ]);
  });

  it("observes tag and Release absence independently when both endpoints return 404", async () => {
    const calls = [];
    const truth = await observeReleaseTruth({
      repo: "netkeep80/repo-guard",
      tag,
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v3.1.0", 404],
        ["/repos/netkeep80/repo-guard/releases/tags/v3.1.0", 404],
      ], calls),
    });

    assert.deepEqual(truth, {
      tag,
      tag_exists: false,
      tag_commit: null,
      release_exists: false,
      published: false,
      draft: null,
      prerelease: null,
      release_url: null,
    });
    assert.equal(calls.length, 2);
  });
});
