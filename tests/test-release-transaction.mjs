import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exactSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const moduleUnderTest = await import("../scripts/release-preflight.mjs").catch(() => ({}));

function requirePreflight() {
  assert.equal(
    typeof moduleUnderTest.preflightRelease,
    "function",
    "scripts/release-preflight.mjs must export preflightRelease",
  );
  return moduleUnderTest.preflightRelease;
}

function makeRoot({ version = "2.3.4", lockVersion = version, packageEntryVersion = lockVersion } = {}) {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-release-preflight-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "repo-guard", version }),
    "utf8",
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "repo-guard",
      version: lockVersion,
      lockfileVersion: 3,
      packages: { "": { name: "repo-guard", version: packageEntryVersion } },
    }),
    "utf8",
  );
  return root;
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

function mainRef(sha = exactSha) {
  return { object: { type: "commit", sha } };
}

function workflowRun({
  id,
  name,
  path,
  event,
  headBranch = "main",
  headSha = exactSha,
  conclusion = "success",
} = {}) {
  return {
    id,
    name,
    path,
    event,
    head_branch: headBranch,
    head_sha: headSha,
    status: "completed",
    conclusion,
    html_url: `https://example.invalid/actions/runs/${id}`,
  };
}

function ciRun(overrides = {}) {
  return workflowRun({
    id: 101,
    name: "CI",
    path: ".github/workflows/ci.yml",
    event: "push",
    ...overrides,
  });
}

function pagesRun(overrides = {}) {
  return workflowRun({
    id: 202,
    name: "Policy Observatory Pages",
    path: ".github/workflows/pages.yml",
    event: "workflow_run",
    ...overrides,
  });
}

function tagRef(sha = exactSha) {
  return { object: { type: "commit", sha } };
}

function publishedRelease(overrides = {}) {
  return {
    tag_name: "v2.3.4",
    draft: false,
    prerelease: false,
    html_url: "https://example.invalid/releases/v2.3.4",
    ...overrides,
  };
}

function routes({
  mainSha = exactSha,
  ciRuns = [ciRun()],
  pagesRuns = [pagesRun()],
  tagStatus = 404,
  tagSha = exactSha,
  releaseStatus = 404,
  release = {},
} = {}) {
  return [
    ["/git/ref/heads/main", 200, mainRef(mainSha)],
    ["/actions/workflows/ci.yml/runs", 200, { workflow_runs: ciRuns }],
    ["/actions/workflows/pages.yml/runs", 200, { workflow_runs: pagesRuns }],
    ["/git/ref/tags/v2.3.4", tagStatus, tagRef(tagSha)],
    ["/releases/tags/v2.3.4", releaseStatus, release],
  ];
}

function fakeFetch(entries, calls = []) {
  return async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const match = entries.find(([suffix]) => parsed.pathname.endsWith(suffix));
    if (!match) return response(404, { message: "not found" });
    return response(match[1], match[2]);
  };
}

function fakeRun({ head = exactSha, distError = null } = {}, calls = []) {
  return (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return head;
    if (command === "npm" && args.join(" ") === "run check:dist") {
      if (distError) throw new Error(distError);
      return "";
    }
    throw new Error(`Unexpected process call: ${command} ${args.join(" ")}`);
  };
}

async function runPreflight({
  sha = exactSha,
  root = makeRoot(),
  routeEntries = routes(),
  run = fakeRun(),
  calls = [],
} = {}) {
  const preflightRelease = requirePreflight();
  return preflightRelease({
    repoRoot: root,
    repo: "netkeep80/repo-guard",
    sha,
    fetchImpl: fakeFetch(routeEntries, calls),
    run,
  });
}

describe("atomic release preflight", () => {
  it("accepts an exact accepted SHA when tag and Release are still absent", async () => {
    const processCalls = [];
    const result = await runPreflight({ run: fakeRun({}, processCalls) });

    assert.deepEqual(result, {
      sha: exactSha,
      version: "2.3.4",
      tag: "v2.3.4",
    });
    assert.deepEqual(
      processCalls.map(({ command, args }) => [command, ...args]),
      [
        ["git", "rev-parse", "HEAD"],
        ["npm", "run", "check:dist"],
      ],
    );
  });

  it("rejects a malformed SHA before any GitHub observation", async () => {
    const calls = [];
    await assert.rejects(
      runPreflight({ sha: "main", calls }),
      /40-hex SHA/i,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects when checkout HEAD is not the requested immutable SHA", async () => {
    await assert.rejects(
      runPreflight({ run: fakeRun({ head: otherSha }) }),
      /checkout.*requested SHA/i,
    );
  });

  it("rejects when current main no longer points to the captured SHA", async () => {
    await assert.rejects(
      runPreflight({ routeEntries: routes({ mainSha: otherSha }) }),
      /main.*requested SHA/i,
    );
  });

  for (const [name, ciRuns, pattern] of [
    [
      "only PR CI exists",
      [ciRun({ event: "pull_request" })],
      /post-merge CI/i,
    ],
    [
      "a similarly named run has the wrong workflow path",
      [ciRun({ path: ".github/workflows/not-ci.yml" })],
      /post-merge CI/i,
    ],
    [
      "the exact post-merge CI failed",
      [ciRun({ conclusion: "failure" })],
      /post-merge CI/i,
    ],
    [
      "the exact post-merge CI was cancelled",
      [ciRun({ conclusion: "cancelled" })],
      /post-merge CI/i,
    ],
  ]) {
    it(`rejects when ${name}`, async () => {
      await assert.rejects(
        runPreflight({ routeEntries: routes({ ciRuns }) }),
        pattern,
      );
    });
  }

  for (const [name, pagesRuns] of [
    ["Pages-on-S evidence is missing", []],
    ["Pages-on-S failed", [pagesRun({ conclusion: "failure" })]],
    ["Pages evidence comes from the wrong workflow", [pagesRun({ path: ".github/workflows/other.yml" })]],
  ]) {
    it(`rejects when ${name}`, async () => {
      await assert.rejects(
        runPreflight({ routeEntries: routes({ pagesRuns }) }),
        /Pages.*accepted SHA/i,
      );
    });
  }

  it("rejects package-lock root version drift", async () => {
    await assert.rejects(
      runPreflight({ root: makeRoot({ lockVersion: "2.3.5" }) }),
      /package-lock.*version/i,
    );
  });

  it("rejects package-lock package-entry version drift", async () => {
    await assert.rejects(
      runPreflight({ root: makeRoot({ packageEntryVersion: "2.3.5" }) }),
      /package-lock.*version/i,
    );
  });

  it("rejects stale generated dist", async () => {
    await assert.rejects(
      runPreflight({ run: fakeRun({ distError: "dist is stale" }) }),
      /dist is stale/i,
    );
  });

  it("accepts an idempotent existing tag on S with no Release yet", async () => {
    const result = await runPreflight({
      routeEntries: routes({ tagStatus: 200 }),
    });
    assert.equal(result.sha, exactSha);
    assert.equal(result.tag, "v2.3.4");
  });

  it("accepts an already published non-draft release on the exact tag and S", async () => {
    const result = await runPreflight({
      routeEntries: routes({
        tagStatus: 200,
        releaseStatus: 200,
        release: publishedRelease(),
      }),
    });
    assert.equal(result.sha, exactSha);
  });

  it("rejects an existing release tag that points to another SHA", async () => {
    await assert.rejects(
      runPreflight({
        routeEntries: routes({ tagStatus: 200, tagSha: otherSha }),
      }),
      /tag.*different SHA/i,
    );
  });

  for (const [name, release] of [
    ["draft", publishedRelease({ draft: true })],
    ["prerelease", publishedRelease({ prerelease: true })],
  ]) {
    it(`rejects a contradictory ${name} Release`, async () => {
      await assert.rejects(
        runPreflight({
          routeEntries: routes({
            tagStatus: 200,
            releaseStatus: 200,
            release,
          }),
        }),
        /Release.*published/i,
      );
    });
  }

  it("fails closed on malformed GitHub Release payload", async () => {
    await assert.rejects(
      runPreflight({
        routeEntries: routes({
          tagStatus: 200,
          releaseStatus: 200,
          release: {},
        }),
      }),
      /release payload/i,
    );
  });
});

console.log("Atomic release preflight contract passed");
