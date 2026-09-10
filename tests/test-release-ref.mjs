import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as releaseRef from "../scripts/verify-release-ref.mjs";

const { verifyReleaseRef } = releaseRef;
const exactHead = "a".repeat(40);
const otherHead = "b".repeat(40);
const annotatedTagObject = "c".repeat(40);

function runAt(sha, calls = null) {
  return (command, args, options) => {
    calls?.push({ command, args, options });
    return sha;
  };
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

function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const route = routes.find(([pattern]) => url.endsWith(pattern));
    if (!route) return response(404, { message: "not found" });
    return response(route[1], route[2] ?? {});
  };
}

function tagObject(type, sha) {
  return { object: { type, sha } };
}

function publishedRelease(tag = "v2.3.4", overrides = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: "https://example.invalid/release",
    ...overrides,
  };
}

function exactTagRoutes(release = publishedRelease()) {
  return [
    [
      "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
      200,
      tagObject("commit", exactHead),
    ],
    [
      "/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
      200,
      release,
    ],
  ];
}

describe("release truth observation", () => {
  it("observes a lightweight tag and published release as exact normalized facts", async () => {
    assert.equal(typeof releaseRef.observeReleaseTruth, "function");
    const calls = [];
    const truth = await releaseRef.observeReleaseTruth({
      repo: "netkeep80/repo-guard",
      tag: "v2.3.4",
      fetchImpl: fakeFetch(exactTagRoutes(), calls),
    });

    assert.deepEqual(truth, {
      tag: "v2.3.4",
      tag_exists: true,
      tag_commit: exactHead,
      release_exists: true,
      published: true,
      draft: false,
      prerelease: false,
      release_url: "https://example.invalid/release",
    });
    assert.deepEqual(calls, [
      "https://api.github.com/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
      "https://api.github.com/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
    ]);
  });

  it("resolves an annotated tag object to its exact commit", async () => {
    assert.equal(typeof releaseRef.observeReleaseTruth, "function");
    const truth = await releaseRef.observeReleaseTruth({
      repo: "netkeep80/repo-guard",
      tag: "v2.3.4",
      fetchImpl: fakeFetch([
        [
          "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
          200,
          tagObject("tag", annotatedTagObject),
        ],
        [
          `/repos/netkeep80/repo-guard/git/tags/${annotatedTagObject}`,
          200,
          tagObject("commit", exactHead),
        ],
        [
          "/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
          200,
          publishedRelease(),
        ],
      ]),
    });

    assert.equal(truth.tag_commit, exactHead);
    assert.equal(truth.published, true);
  });

  it("returns explicit absence when the tag does not exist", async () => {
    assert.equal(typeof releaseRef.observeReleaseTruth, "function");
    const calls = [];
    const truth = await releaseRef.observeReleaseTruth({
      repo: "netkeep80/repo-guard",
      tag: "v2.3.4",
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 404],
      ], calls),
    });

    assert.deepEqual(truth, {
      tag: "v2.3.4",
      tag_exists: false,
      tag_commit: null,
      release_exists: false,
      published: false,
      draft: null,
      prerelease: null,
      release_url: null,
    });
    assert.equal(calls.length, 1);
  });

  it("fails closed on an unknown tag object type", async () => {
    assert.equal(typeof releaseRef.observeReleaseTruth, "function");
    await assert.rejects(
      releaseRef.observeReleaseTruth({
        repo: "netkeep80/repo-guard",
        tag: "v2.3.4",
        fetchImpl: fakeFetch([
          [
            "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
            200,
            tagObject("blob", exactHead),
          ],
        ]),
      }),
      /unsupported object type/i,
    );
  });

  it("fails closed on an annotated tag cycle", async () => {
    assert.equal(typeof releaseRef.observeReleaseTruth, "function");
    await assert.rejects(
      releaseRef.observeReleaseTruth({
        repo: "netkeep80/repo-guard",
        tag: "v2.3.4",
        fetchImpl: fakeFetch([
          [
            "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
            200,
            tagObject("tag", annotatedTagObject),
          ],
          [
            `/repos/netkeep80/repo-guard/git/tags/${annotatedTagObject}`,
            200,
            tagObject("tag", annotatedTagObject),
          ],
        ]),
      }),
      /cycle/i,
    );
  });

  for (const [name, release, pattern] of [
    ["malformed release payload", {}, /release payload/i],
    ["mismatching release tag", publishedRelease("v9.9.9"), /tag_name/i],
  ]) {
    it(`fails closed on ${name}`, async () => {
      assert.equal(typeof releaseRef.observeReleaseTruth, "function");
      await assert.rejects(
        releaseRef.observeReleaseTruth({
          repo: "netkeep80/repo-guard",
          tag: "v2.3.4",
          fetchImpl: fakeFetch(exactTagRoutes(release)),
        }),
        pattern,
      );
    });
  }

  it("does not treat a GitHub API error as release absence", async () => {
    assert.equal(typeof releaseRef.observeReleaseTruth, "function");
    await assert.rejects(
      releaseRef.observeReleaseTruth({
        repo: "netkeep80/repo-guard",
        tag: "v2.3.4",
        fetchImpl: fakeFetch([
          [
            "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
            200,
            tagObject("commit", exactHead),
          ],
          [
            "/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
            500,
            { message: "server error" },
          ],
        ]),
      }),
      /server error/i,
    );
  });
});

describe("release ref verification", () => {
  it("passes when package version, exact tag commit, checkout, and published release are in sync", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const calls = [];
    const runCalls = [];
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      run: runAt(exactHead, runCalls),
      fetchImpl: fakeFetch(exactTagRoutes(), calls),
    });

    assert.equal(result.ok, true);
    assert.equal(result.expectedTag, "v2.3.4");
    assert.deepEqual(runCalls, [{
      command: "git",
      args: ["rev-parse", "HEAD"],
      options: { cwd: packageRoot },
    }]);
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
          tagObject("commit", otherHead),
        ],
        [
          "/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
          200,
          publishedRelease(),
        ],
      ]),
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => (
      check.name === "release-tag-resolves-to-checkout"
      && check.status === "FAIL"
    )));
  });

  it("fails before checkout and network checks when a supplied release tag differs from package.json", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const calls = [];
    const runCalls = [];
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      tag: "v2.3.5",
      run: runAt(exactHead, runCalls),
      fetchImpl: fakeFetch([], calls),
    });

    assert.equal(result.ok, false);
    assert.equal(result.expectedTag, "v2.3.4");
    assert.equal(calls.length, 0);
    assert.equal(runCalls.length, 0);
    assert.ok(result.checks.some((check) => check.name === "release-tag-matches-package" && check.status === "FAIL"));
  });

  it("fails when the Git tag does not exist", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      run: runAt(exactHead),
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 404],
      ]),
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.name === "published-git-tag" && check.status === "FAIL"));
  });

  it("fails when the GitHub release does not exist", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      run: runAt(exactHead),
      fetchImpl: fakeFetch([
        [
          "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
          200,
          tagObject("commit", exactHead),
        ],
        ["/repos/netkeep80/repo-guard/releases/tags/v2.3.4", 404],
      ]),
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.name === "published-github-release" && check.status === "FAIL"));
  });

  for (const [name, release] of [
    ["draft", publishedRelease("v2.3.4", { draft: true })],
    ["prerelease", publishedRelease("v2.3.4", { prerelease: true })],
  ]) {
    it(`fails when the GitHub release is ${name}`, async () => {
      const packageRoot = makePackageRoot("2.3.4");
      const result = await verifyReleaseRef({
        packageRoot,
        repo: "netkeep80/repo-guard",
        run: runAt(exactHead),
        fetchImpl: fakeFetch(exactTagRoutes(release)),
      });

      assert.equal(result.ok, false);
      assert.ok(result.checks.some((check) => (
        check.name === "published-github-release"
        && check.status === "FAIL"
      )));
    });
  }

  it("turns malformed GitHub observations into a structured FAIL", async () => {
    const packageRoot = makePackageRoot("2.3.4");
    const result = await verifyReleaseRef({
      packageRoot,
      repo: "netkeep80/repo-guard",
      run: runAt(exactHead),
      fetchImpl: fakeFetch(exactTagRoutes({})),
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => (
      check.name === "release-observation"
      && check.status === "FAIL"
    )));
  });
});