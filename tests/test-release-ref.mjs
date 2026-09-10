import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseRef } from "../scripts/verify-release-ref.mjs";

const exactHead = "a".repeat(40);
const otherHead = "b".repeat(40);

function runAt(sha) {
  return () => sha;
}

function makePackageRoot(version) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-release-ref-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }), "utf-8");
  return dir;
}

function response(status, body = {}) {
  return {
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function fakeFetch(routes, calls) {
  return async (url) => {
    calls.push(url);
    const route = routes.find(([pattern]) => url.endsWith(pattern));
    if (!route) return response(404, { message: "not found" });
    return response(route[1], route[2] || {});
  };
}

describe("release ref verification", () => {
  it("passes when package version, tag, and published release are in sync", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const calls = [];
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 200],
        ["/repos/netkeep80/repo-guard/releases/tags/v2.3.4", 200, { draft: false }],
      ], calls),
    });

    assert.equal(result.ok, true);
    assert.equal(result.expectedTag, "v2.3.4");
    assert.deepEqual(calls, [
      "https://api.github.com/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
      "https://api.github.com/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
    ]);
  });

  it("rejects a matching tag name that resolves to another commit", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      run: runAt(exactHead),
      fetchImpl: fakeFetch([
        [
          "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
          200,
          { object: { type: "commit", sha: otherHead } },
        ],
        [
          "/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
          200,
          {
            tag_name: "v2.3.4",
            draft: false,
            prerelease: false,
            html_url: "https://example.invalid/release",
          },
        ],
      ], []),
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => (
      check.name === "release-tag-resolves-to-checkout"
      && check.status === "FAIL"
    )));
  });

  it("fails before network checks when a supplied release tag differs from package.json", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const calls = [];
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      tag: "v2.3.5",
      fetchImpl: fakeFetch([], calls),
    });

    assert.equal(result.ok, false);
    assert.equal(result.expectedTag, "v2.3.4");
    assert.equal(calls.length, 0);
    assert.ok(result.checks.some((check) => check.name === "release-tag-matches-package" && check.status === "FAIL"));
  });

  it("fails when the Git tag does not exist", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 404],
      ], []),
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.name === "published-git-tag" && check.status === "FAIL"));
  });

  it("fails when the GitHub release does not exist", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 200],
        ["/repos/netkeep80/repo-guard/releases/tags/v2.3.4", 404],
      ], []),
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.name === "published-github-release" && check.status === "FAIL"));
  });

  it("fails when the GitHub release is still a draft", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 200],
        ["/repos/netkeep80/repo-guard/releases/tags/v2.3.4", 200, { draft: true }],
      ], []),
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.name === "published-github-release" && check.status === "FAIL"));
  });
});