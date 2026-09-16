import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  C3_BASELINE_SHA,
  collectObservatorySnapshot,
  stableJson,
} from "../scripts/observatory/collect.mjs";
import { observeImmutable } from "./support/immutable-observation.mjs";

const repoRoot = resolve(".");
const acceptedSha = observeImmutable("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
const otherSha = "f".repeat(40);
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const packageVersion = packageJson.version;
const observedAt = "2026-09-16T18:00:00Z";
const laterObservedAt = "2026-09-16T18:05:00Z";

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

const runCache = new Map();
const runExecutions = new Map();
function runKey(command, args, options = {}) {
  return JSON.stringify([command, args, options.cwd ?? null]);
}
function memoizedRun(command, args, options = {}) {
  const key = runKey(command, args, options);
  if (!runCache.has(key)) {
    runExecutions.set(key, (runExecutions.get(key) ?? 0) + 1);
    runCache.set(key, observeImmutable(command, args, options));
  }
  return runCache.get(key);
}
function executionCount(command, args, options = {}) {
  return runExecutions.get(runKey(command, args, options)) ?? 0;
}

const release404 = async () => response(404);
const acceptedCi = {
  workflow: "CI",
  workflow_path: ".github/workflows/ci.yml",
  event: "push",
  branch: "main",
  head_sha: acceptedSha,
  run_id: 123,
  run_url: "https://example.invalid/runs/123",
  conclusion: "success",
};
const input = {
  repoRoot,
  acceptedSha,
  observedAt,
  ci: acceptedCi,
  releaseIntegrity: null,
  repository: "netkeep80/repo-guard",
  token: "test-token",
  fetchImpl: release404,
  run: memoizedRun,
};

const first = await collectObservatorySnapshot(input);
const second = await collectObservatorySnapshot(input);

assert.equal(first.schema_version, 2);
assert.equal(first.observed_at, observedAt);
assert.equal(first.repository.full_name, input.repository);
assert.equal(first.repository.provenance.origin, "github_observation");
assert.equal(first.repository.provenance.source, "repository");
assert.equal(first.repository.provenance.sha, acceptedSha);
assert.equal(first.accepted.sha, acceptedSha);
assert.deepEqual(first.accepted.ci, {
  workflow: "CI",
  run_id: 123,
  run_url: "https://example.invalid/runs/123",
  conclusion: "success",
});
assert.equal(first.accepted.provenance.origin, "accepted_ci");
assert.equal(first.accepted.provenance.sha, acceptedSha);
assert.deepEqual(first.version, {
  package_version: packageVersion,
  expected_release_tag: `v${packageVersion}`,
});
assert.deepEqual(first.release, {
  tag_exists: false,
  tag_commit: null,
  release_exists: false,
  draft: null,
  prerelease: null,
  stable_published: false,
  release_url: null,
  tag_matches_accepted_sha: null,
});
assert.equal(first.release_integrity, null);

const packageTag = first.version.expected_release_tag;
const publishedReleaseUrl = `https://example.invalid/releases/${packageTag}`;
function releaseFetch({
  tagStatus = 200,
  tagCommit = acceptedSha,
  releaseStatus = 200,
  draft = false,
  prerelease = false,
  releaseUrl = publishedReleaseUrl,
} = {}) {
  return async (url) => {
    if (url.includes("/git/ref/tags/")) {
      if (tagStatus !== 200) return response(tagStatus);
      return response(200, { object: { type: "commit", sha: tagCommit } });
    }
    if (url.includes("/releases/tags/")) {
      if (releaseStatus !== 200) return response(releaseStatus);
      return response(200, {
        tag_name: packageTag,
        draft,
        prerelease,
        html_url: releaseUrl,
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
}

const published = await collectObservatorySnapshot({
  ...input,
  fetchImpl: releaseFetch(),
});
assert.deepEqual(published.release, {
  tag_exists: true,
  tag_commit: acceptedSha,
  release_exists: true,
  draft: false,
  prerelease: false,
  stable_published: true,
  release_url: publishedReleaseUrl,
  tag_matches_accepted_sha: true,
});

for (const [name, options] of [
  ["prerelease", { draft: false, prerelease: true }],
  ["draft", { draft: true, prerelease: false }],
]) {
  const nonStable = await collectObservatorySnapshot({
    ...input,
    fetchImpl: releaseFetch(options),
  });
  assert.equal(nonStable.release.tag_exists, true, name);
  assert.equal(nonStable.release.tag_commit, acceptedSha, name);
  assert.equal(nonStable.release.release_exists, true, name);
  assert.equal(nonStable.release.stable_published, false, name);
  assert.equal(nonStable.release.release_url, publishedReleaseUrl, name);
  assert.equal(nonStable.release.tag_matches_accepted_sha, true, name);
}

const historicalMismatch = await collectObservatorySnapshot({
  ...input,
  fetchImpl: releaseFetch({ tagCommit: otherSha }),
});
assert.equal(historicalMismatch.release.stable_published, true);
assert.equal(historicalMismatch.release.tag_commit, otherSha);
assert.equal(historicalMismatch.release.tag_matches_accepted_sha, false);

const releaseWithoutTag = await collectObservatorySnapshot({
  ...input,
  fetchImpl: releaseFetch({ tagStatus: 404 }),
});
assert.equal(releaseWithoutTag.release.tag_exists, false);
assert.equal(releaseWithoutTag.release.tag_commit, null);
assert.equal(releaseWithoutTag.release.release_exists, true);
assert.equal(releaseWithoutTag.release.stable_published, true);
assert.equal(releaseWithoutTag.release.tag_matches_accepted_sha, null);

const evidence = {
  target_sha: acceptedSha,
  tag: packageTag,
  run_id: 456,
  run_attempt: 2,
  run_url: "https://example.invalid/runs/456",
  conclusion: "failure",
};
const withEvidence = await collectObservatorySnapshot({
  ...input,
  releaseIntegrity: evidence,
});
assert.deepEqual(withEvidence.release_integrity, evidence);

const later = await collectObservatorySnapshot({
  ...input,
  observedAt: laterObservedAt,
});
assert.equal(later.observed_at, laterObservedAt);
assert.equal(
  stableJson({ ...first, observed_at: laterObservedAt }),
  stableJson(later),
  "same accepted S at another observation time changes only observed_at in the persisted snapshot when observations are fixed",
);

assert.equal(
  executionCount(
    process.execPath,
    [resolve(repoRoot, "scripts/compression-metrics.mjs"), "--compare", C3_BASELINE_SHA],
    { cwd: repoRoot },
  ),
  1,
);
assert.equal(executionCount("git", ["rev-parse", "HEAD"], { cwd: repoRoot }), 1);

assert.deepEqual(
  first.architecture.current.architecture.canonical_fact_sources,
  ["change_intent", "diff", "document", "repository"],
);
assert.deepEqual(
  first.architecture.current.architecture.runtime_constraint_kind_names,
  ["primitive_relation"],
);
assert.equal(first.architecture.current.architecture.primitive_descriptor_registry_count, 1);
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
assert.ok(first.policy.constraint_program.length > 0);
assert.ok(first.policy.constraint_program.filter((entry) => entry.runtime).every((entry) => entry.runtime.kind === "primitive_relation"));
assert.equal(first.policy.provenance.origin, "accepted_commit");
assert.equal(first.policy.provenance.sha, acceptedSha);
assert.equal(first.ci.provenance.origin, "accepted_commit");
assert.equal(first.ci.provenance.sha, acceptedSha);
assert.equal(stableJson(first), stableJson(second));
assert.ok(!stableJson(first).includes(repoRoot));

const policy = JSON.parse(readFileSync(resolve(repoRoot, "repo-policy.json"), "utf8"));
assert.deepEqual(first.policy.accepted, policy);

for (const [label, ci] of [
  ["workflow path", { ...acceptedCi, workflow_path: ".github/workflows/other.yml" }],
  ["event", { ...acceptedCi, event: "pull_request" }],
  ["branch", { ...acceptedCi, branch: "feature" }],
  ["head SHA", { ...acceptedCi, head_sha: otherSha }],
  ["conclusion", { ...acceptedCi, conclusion: "failure" }],
]) {
  await assert.rejects(
    () => collectObservatorySnapshot({ ...input, ci }),
    /accepted CI metadata/i,
    label,
  );
}

await assert.rejects(
  () => collectObservatorySnapshot({
    ...input,
    releaseIntegrity: { ...evidence, target_sha: otherSha },
  }),
  /release integrity.*target/i,
);
await assert.rejects(
  () => collectObservatorySnapshot({
    ...input,
    releaseIntegrity: { ...evidence, tag: "v9.9.9" },
  }),
  /release integrity.*tag/i,
);
await assert.rejects(
  () => collectObservatorySnapshot({ ...input, observedAt: "not-a-time" }),
  /observed_at/i,
);
await assert.rejects(
  () => collectObservatorySnapshot({ ...input, fetchImpl: async () => response(500) }),
  /failed/,
);
await assert.rejects(
  () => collectObservatorySnapshot({ ...input, fetchImpl: async () => response(200) }),
  /malformed/i,
);
await assert.rejects(
  () => collectObservatorySnapshot({ ...input, acceptedSha: "0".repeat(40) }),
  /accepted SHA mismatch/,
);

console.log("C3.7 Observatory snapshot v2 contract passed");
