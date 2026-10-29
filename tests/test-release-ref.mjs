import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as releaseRef from "../scripts/verify-release-ref.mjs";

const { verifyReleaseRef, verifyHistoricalRelease } = releaseRef;
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

  it("returns explicit independent absence when tag and release do not exist", async () => {
    assert.equal(typeof releaseRef.observeReleaseTruth, "function");
    const calls = [];
    const truth = await releaseRef.observeReleaseTruth({
      repo: "netkeep80/repo-guard",
      tag: "v2.3.4",
      fetchImpl: fakeFetch([
        ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 404],
        ["/repos/netkeep80/repo-guard/releases/tags/v2.3.4", 404],
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
    assert.deepEqual(calls, [
      "https://api.github.com/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
      "https://api.github.com/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
    ]);
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
        ["/repos/netkeep80/repo-guard/releases/tags/v2.3.4", 404],
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


function makeHistoricalRepo() {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-852-history-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path, value) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, value);
  };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=#852", "-c", "user.email=852@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };

  git("init", "-q", "--object-format=sha1");
  put("package.json", JSON.stringify({ name: "repo-guard", version: "2.3.4" }));
  put("package-lock.json", JSON.stringify({
    name: "repo-guard",
    version: "2.3.4",
    lockfileVersion: 3,
    packages: { "": { name: "repo-guard", version: "2.3.4" } },
  }));
  const marker = join(root, "TARGET_OWNED_VERIFIER_EXECUTED");
  put("scripts/verify-release-ref.mjs",
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`);
  const target = commit("historical v2.3.4 target");
  git("tag", "v2.3.4", target);

  put("package.json", JSON.stringify({ name: "repo-guard", version: "5.0.0" }));
  put("package-lock.json", JSON.stringify({
    name: "repo-guard",
    version: "5.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "repo-guard", version: "5.0.0" } },
  }));
  put("scripts/verify-release-ref.mjs", "throw new Error('trusted evaluator fixture; target script must stay inert');\n");
  const verifier = commit("newer trusted evaluator");
  return { root, git, put, commit, target, verifier, marker };
}

function historicalRoutes(target, {
  tag = "v2.3.4",
  release = publishedRelease(tag),
  tagType = "commit",
  tagObjectSha = annotatedTagObject,
} = {}) {
  const routes = [[
    `/repos/netkeep80/repo-guard/git/ref/tags/${tag}`,
    200,
    tagObject(tagType, tagType === "commit" ? target : tagObjectSha),
  ]];
  if (tagType === "tag") {
    routes.push([
      `/repos/netkeep80/repo-guard/git/tags/${tagObjectSha}`,
      200,
      tagObject("commit", target),
    ]);
  }
  routes.push([
    `/repos/netkeep80/repo-guard/releases/tags/${tag}`,
    200,
    release,
  ]);
  return routes;
}

describe("#852 trusted historical release verification", () => {
  it("verifies an older release from a newer trusted evaluator without executing target verifier code", async () => {
    const fixture = makeHistoricalRepo();
    try {
      const result = await verifyHistoricalRelease({
        packageRoot: fixture.root,
        repo: "netkeep80/repo-guard",
        tag: "v2.3.4",
        targetSha: fixture.target,
        verifierSha: fixture.verifier,
        fetchImpl: fakeFetch(historicalRoutes(fixture.target)),
      });
      assert.equal(result.ok, true, JSON.stringify(result.checks));
      assert.equal(result.packageVersion, "2.3.4");
      assert.equal(result.targetSha, fixture.target);
      assert.equal(result.verifierSha, fixture.verifier);
      assert.notEqual(fixture.target, fixture.verifier);
      assert.equal(existsSync(fixture.marker), false, "target-owned verifier executed");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves annotated-tag resolution for historical verification", async () => {
    const fixture = makeHistoricalRepo();
    try {
      const result = await verifyHistoricalRelease({
        packageRoot: fixture.root,
        tag: "v2.3.4",
        targetSha: fixture.target,
        verifierSha: fixture.verifier,
        fetchImpl: fakeFetch(historicalRoutes(fixture.target, { tagType: "tag" })),
      });
      assert.equal(result.ok, true, JSON.stringify(result.checks));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when observed tag target differs from acquired exact target", async () => {
    const fixture = makeHistoricalRepo();
    try {
      const result = await verifyHistoricalRelease({
        packageRoot: fixture.root,
        tag: "v2.3.4",
        targetSha: fixture.target,
        verifierSha: fixture.verifier,
        fetchImpl: fakeFetch(historicalRoutes(otherHead)),
      });
      assert.equal(result.ok, false);
      assert.ok(result.checks.some((check) => check.name === "historical-target-binding" && check.status === "FAIL"));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const [name, routes] of [
    ["missing tag", [
      ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 404],
      ["/repos/netkeep80/repo-guard/releases/tags/v2.3.4", 404],
    ]],
    ["missing release", [
      ["/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4", 200, tagObject("commit", exactHead)],
      ["/repos/netkeep80/repo-guard/releases/tags/v2.3.4", 404],
    ]],
  ]) {
    it(`fails closed on ${name}`, async () => {
      const fixture = makeHistoricalRepo();
      try {
        const mapped = routes.map(([path, status, body]) => [
          path,
          status,
          body?.object?.sha === exactHead ? tagObject("commit", fixture.target) : body,
        ]);
        const result = await verifyHistoricalRelease({
          packageRoot: fixture.root,
          tag: "v2.3.4",
          targetSha: fixture.target,
          verifierSha: fixture.verifier,
          fetchImpl: fakeFetch(mapped),
        });
        assert.equal(result.ok, false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  for (const [name, release] of [
    ["draft", publishedRelease("v2.3.4", { draft: true })],
    ["prerelease", publishedRelease("v2.3.4", { prerelease: true })],
  ]) {
    it(`fails closed on historical ${name} release`, async () => {
      const fixture = makeHistoricalRepo();
      try {
        const result = await verifyHistoricalRelease({
          packageRoot: fixture.root,
          tag: "v2.3.4",
          targetSha: fixture.target,
          verifierSha: fixture.verifier,
          fetchImpl: fakeFetch(historicalRoutes(fixture.target, { release })),
        });
        assert.equal(result.ok, false);
        assert.ok(result.checks.some((check) => check.name === "published-github-release" && check.status === "FAIL"));
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  it("fails closed when selected tag does not match historical package version", async () => {
    const fixture = makeHistoricalRepo();
    try {
      const result = await verifyHistoricalRelease({
        packageRoot: fixture.root,
        tag: "v2.3.5",
        targetSha: fixture.target,
        verifierSha: fixture.verifier,
        fetchImpl: fakeFetch(historicalRoutes(fixture.target, {
          tag: "v2.3.5",
          release: publishedRelease("v2.3.5"),
        })),
      });
      assert.equal(result.ok, false);
      assert.ok(result.checks.some((check) => check.name === "historical-package-tag-binding" && check.status === "FAIL"));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves #850 replacement-ref invariance for exact historical package reads", async () => {
    const fixture = makeHistoricalRepo();
    const previousNoReplace = process.env.GIT_NO_REPLACE_OBJECTS;
    try {
      fixture.git("checkout", "-q", "-b", "replacement", fixture.target);
      fixture.put("package.json", JSON.stringify({ name: "repo-guard", version: "9.9.9" }));
      fixture.put("package-lock.json", JSON.stringify({
        name: "repo-guard",
        version: "9.9.9",
        lockfileVersion: 3,
        packages: { "": { name: "repo-guard", version: "9.9.9" } },
      }));
      const replacement = fixture.commit("replacement target");
      fixture.git("checkout", "-q", "--detach", fixture.verifier);
      fixture.git("replace", fixture.target, replacement);

      delete process.env.GIT_NO_REPLACE_OBJECTS;
      assert.match(
        fixture.git("show", fixture.target + ":package.json"),
        /9\.9\.9/,
        "raw Git control must honor refs/replace",
      );

      const result = await verifyHistoricalRelease({
        packageRoot: fixture.root,
        tag: "v2.3.4",
        targetSha: fixture.target,
        verifierSha: fixture.verifier,
        fetchImpl: fakeFetch(historicalRoutes(fixture.target)),
      });
      assert.equal(result.ok, true, JSON.stringify(result.checks));
      assert.equal(result.packageVersion, "2.3.4");
    } finally {
      if (previousNoReplace === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
      else process.env.GIT_NO_REPLACE_OBJECTS = previousNoReplace;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
