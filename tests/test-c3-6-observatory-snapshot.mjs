import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  collectObservatorySnapshot,
  stableJson,
} from "../scripts/observatory/collect.mjs";

const repoRoot = resolve(".");
const acceptedSha = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: repoRoot, encoding: "utf8" },
).trim();
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

const release404 = async () => response(404);

const input = {
  repoRoot,
  acceptedSha,
  ci: {
    workflow: "CI",
    run_id: 123,
    run_url: "https://example.invalid/runs/123",
    conclusion: "success",
  },
  repository: "netkeep80/repo-guard",
  token: "test-token",
  fetchImpl: release404,
};

const first = await collectObservatorySnapshot(input);
const second = await collectObservatorySnapshot(input);

assert.equal(first.schema_version, 1);
assert.equal(first.repository.full_name, input.repository);
assert.equal(first.repository.provenance.origin, "github_observation");
assert.equal(first.repository.provenance.source, "repository");
assert.equal(first.repository.provenance.sha, acceptedSha);
assert.equal(first.accepted.sha, acceptedSha);
assert.equal(first.accepted.ci.conclusion, "success");
assert.equal(first.accepted.provenance.origin, "accepted_ci");
assert.equal(first.accepted.provenance.sha, acceptedSha);
assert.equal(packageJson.version, "3.0.0");
assert.equal(first.version.package_version, "3.0.0");
assert.equal(first.version.matching_release_tag, "v3.0.0");
assert.equal(first.version.matching_published_release, false);
assert.equal(first.version.release_commit, null);
assert.equal(first.version.release_url, null);
assert.equal(first.version.release_truth_status, "package_only");
assert.equal(first.version.provenance.origin, "github_observation");
assert.equal(first.version.provenance.sha, acceptedSha);

const publishedReleaseUrl = "https://example.invalid/releases/v3.0.0";
const exactPublishedFetch = async (url) => {
  if (url.includes("/git/ref/tags/")) {
    return response(200, {
      object: { type: "commit", sha: acceptedSha },
    });
  }
  if (url.includes("/releases/tags/")) {
    return response(200, {
      tag_name: "v3.0.0",
      draft: false,
      prerelease: false,
      html_url: publishedReleaseUrl,
    });
  }
  throw new Error(`unexpected URL: ${url}`);
};
const published = await collectObservatorySnapshot({
  ...input,
  fetchImpl: exactPublishedFetch,
});
assert.equal(published.version.matching_published_release, true);
assert.equal(published.version.release_commit, acceptedSha);
assert.equal(published.version.release_url, publishedReleaseUrl);
assert.equal(published.version.release_truth_status, "published");

function nonOfficialReleaseFetch({ draft, prerelease, url }) {
  return async (requestUrl) => {
    if (requestUrl.includes("/git/ref/tags/")) {
      return response(200, {
        object: { type: "commit", sha: acceptedSha },
      });
    }
    if (requestUrl.includes("/releases/tags/")) {
      return response(200, {
        tag_name: "v3.0.0",
        draft,
        prerelease,
        html_url: url,
      });
    }
    throw new Error(`unexpected URL: ${requestUrl}`);
  };
}

for (const [name, fetchImpl] of [
  [
    "prerelease",
    nonOfficialReleaseFetch({
      draft: false,
      prerelease: true,
      url: "https://example.invalid/releases/v3.0.0-rc",
    }),
  ],
  [
    "draft",
    nonOfficialReleaseFetch({
      draft: true,
      prerelease: false,
      url: "https://example.invalid/releases/v3.0.0-draft",
    }),
  ],
]) {
  const nonOfficial = await collectObservatorySnapshot({
    ...input,
    fetchImpl,
  });
  assert.equal(nonOfficial.version.matching_published_release, false, name);
  assert.equal(nonOfficial.version.release_commit, null, name);
  assert.equal(nonOfficial.version.release_url, null, name);
  assert.equal(nonOfficial.version.release_truth_status, "package_only", name);
}

assert.deepEqual(
  first.architecture.current.architecture.canonical_fact_sources,
  ["change_intent", "diff", "document", "repository"],
);
assert.deepEqual(
  first.architecture.current.architecture.runtime_constraint_kind_names,
  ["primitive_relation"],
);
assert.equal(
  first.architecture.current.architecture.primitive_descriptor_registry_count,
  1,
);
assert.deepEqual(first.architecture.provenance, {
  origin: "accepted_commit",
  source: "scripts/compression-metrics.mjs",
  sha: acceptedSha,
});

assert.equal(first.scenarios.length, 5);
assert.deepEqual(
  first.scenarios.map((item) => item.id).sort(),
  [
    "contract-evidence",
    "governance-cutover",
    "minimal-diff-policy",
    "surgical-change",
    "version-transition",
  ],
);
assert.ok(first.scenarios.every((item) => item.cases.length === 2));
assert.ok(first.scenarios.every((item) => (
  item.provenance?.origin === "accepted_commit"
  && item.provenance?.sha === acceptedSha
  && item.provenance?.source === `examples/scenarios/${item.id}/scenario.json`
)));

assert.ok(first.policy.constraint_program.length > 0);
assert.ok(
  first.policy.constraint_program
    .filter((entry) => entry.runtime)
    .every((entry) => entry.runtime.kind === "primitive_relation"),
);
assert.equal(first.policy.provenance.origin, "accepted_commit");
assert.equal(first.policy.provenance.sha, acceptedSha);
assert.equal(first.ci.provenance.origin, "accepted_commit");
assert.equal(first.ci.provenance.sha, acceptedSha);

assert.equal(stableJson(first), stableJson(second));
assert.ok(!stableJson(first).includes(repoRoot));

const policy = JSON.parse(
  readFileSync(resolve(repoRoot, "repo-policy.json"), "utf8"),
);
assert.deepEqual(first.policy.accepted, policy);

await assert.rejects(
  () => collectObservatorySnapshot({
    ...input,
    fetchImpl: async () => response(500),
  }),
  /failed/,
);

await assert.rejects(
  () => collectObservatorySnapshot({
    ...input,
    fetchImpl: async () => response(200),
  }),
  /malformed/i,
);

await assert.rejects(
  () => collectObservatorySnapshot({
    ...input,
    acceptedSha: "0".repeat(40),
  }),
  /accepted SHA mismatch/,
);

console.log("C3.7 Observatory release truth contract passed");
