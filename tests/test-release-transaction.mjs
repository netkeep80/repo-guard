import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exactSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const { preflightRelease } = await import("../scripts/release-preflight.mjs");

function makeRoot({ version = "2.3.4", lockVersion = version } = {}) {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-release-preflight-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "repo-guard", version }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "repo-guard", version: lockVersion, lockfileVersion: 3,
    packages: { "": { name: "repo-guard", version: lockVersion } },
  }));
  return root;
}
const response = (status, body = {}) => ({
  status,
  async json() { return body; },
  async text() { return JSON.stringify(body); },
});
const workflowRun = (overrides = {}) => ({
  id: 101, name: "CI", path: ".github/workflows/ci.yml", event: "push",
  head_branch: "main", head_sha: exactSha, status: "completed",
  conclusion: "success", html_url: "https://example.invalid/run/101",
  ...overrides,
});
function routes({ mainSha = exactSha, ciRuns = [workflowRun()], tagStatus = 404, tagSha = exactSha, releaseStatus = 404, release = {} } = {}) {
  return [
    ["/git/ref/heads/main", 200, { object: { type: "commit", sha: mainSha } }],
    ["/actions/workflows/ci.yml/runs", 200, { workflow_runs: ciRuns }],
    ["/git/ref/tags/v2.3.4", tagStatus, { object: { type: "commit", sha: tagSha } }],
    ["/releases/tags/v2.3.4", releaseStatus, release],
  ];
}
function fakeFetch(entries) {
  return async (url) => {
    const path = new URL(url).pathname;
    const match = entries.find(([suffix]) => path.endsWith(suffix));
    return match ? response(match[1], match[2]) : response(404, { message: "not found" });
  };
}
function fakeRun({ head = exactSha, distError = null } = {}) {
  return (command, args) => {
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return head;
    if (command === "npm" && args.join(" ") === "run check:dist") {
      if (distError) throw new Error(distError);
      return "";
    }
    throw new Error(`unexpected process call: ${command} ${args.join(" ")}`);
  };
}
const publishedRelease = (overrides = {}) => ({
  tag_name: "v2.3.4", draft: false, prerelease: false,
  html_url: "https://example.invalid/releases/v2.3.4", ...overrides,
});
async function run(overrides = {}) {
  return preflightRelease({
    repoRoot: overrides.root ?? makeRoot(),
    repo: "netkeep80/repo-guard",
    sha: overrides.sha ?? exactSha,
    fetchImpl: fakeFetch(overrides.routes ?? routes()),
    run: overrides.run ?? fakeRun(),
  });
}

describe("atomic release preflight", () => {
  it("accepts exact main with successful post-merge CI and fresh dist", async () => {
    assert.deepEqual(await run(), { sha: exactSha, version: "2.3.4", tag: "v2.3.4" });
  });
  it("rejects malformed SHA", async () => {
    await assert.rejects(run({ sha: "main" }), /40-hex SHA/i);
  });
  it("rejects checkout/main drift", async () => {
    await assert.rejects(run({ run: fakeRun({ head: otherSha }) }), /checkout.*requested SHA/i);
    await assert.rejects(run({ routes: routes({ mainSha: otherSha }) }), /main.*requested SHA/i);
  });
  it("requires exact successful post-merge CI", async () => {
    await assert.rejects(run({ routes: routes({ ciRuns: [] }) }), /post-merge CI/i);
    await assert.rejects(run({ routes: routes({ ciRuns: [workflowRun({ conclusion: "failure" })] }) }), /post-merge CI/i);
  });
  it("rejects stale dist and lock drift", async () => {
    await assert.rejects(run({ run: fakeRun({ distError: "dist is stale" }) }), /dist is stale/i);
    await assert.rejects(run({ root: makeRoot({ lockVersion: "2.3.5" }) }), /package-lock.*version/i);
  });
  it("accepts exact existing stable publication", async () => {
    const result = await run({ routes: routes({ tagStatus: 200, releaseStatus: 200, release: publishedRelease() }) });
    assert.equal(result.sha, exactSha);
  });
  it("rejects mismatching tag or non-stable release", async () => {
    await assert.rejects(run({ routes: routes({ tagStatus: 200, tagSha: otherSha }) }), /tag.*different SHA/i);
    await assert.rejects(run({ routes: routes({ tagStatus: 200, releaseStatus: 200, release: publishedRelease({ draft: true }) }) }), /Release.*published/i);
  });
});
console.log("Atomic release preflight contract passed");
