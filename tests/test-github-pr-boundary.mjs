import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthenticatedProviderBundle, loadGitHubEvent } from "../dist/github-pr.mjs";

function withEventFile(content, run) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-github-pr-boundary-"));
  const eventPath = join(dir, "event.json");
  const previous = process.env.GITHUB_EVENT_PATH;
  writeFileSync(eventPath, content);
  process.env.GITHUB_EVENT_PATH = eventPath;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previous;
    rmSync(dir, { recursive: true });
  }
}

describe("github PR event boundary", () => {
  it("contains malformed event JSON as an event_read_error", () => {
    const result = withEventFile("{bad", () => loadGitHubEvent());
    assert.equal(result.ok, false);
    assert.equal(result.error, "event_read_error");
    assert.match(result.message, /Cannot read event file:/);
  });

  it("preserves the PR event projection", () => {
    const event = {
      pull_request: {
        number: 42,
        base: { sha: "a".repeat(40), ref: "main" },
        head: { sha: "b".repeat(40) },
        body: "PR body",
      },
      repository: { full_name: "netkeep80/repo-guard" },
    };
    const result = withEventFile(JSON.stringify(event), () => loadGitHubEvent());
    assert.deepEqual(result, {
      ok: true,
      base: "a".repeat(40),
      baseRef: "main",
      head: "b".repeat(40),
      prBody: "PR body",
      prNumber: 42,
      repoFullName: "netkeep80/repo-guard",
    });
  });
});


describe("#752 authenticated provider production boundary", () => {
  it("accepts an exact provider claim only from an accepted pull_request_target workflow source", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-bundle-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      claims: [{
        boundary: "domain",
        class: "domain",
        key: "domain:example",
        requirementId: "APP-01",
        subjectPaths: ["README.md"],
        status: "pass"
      }]
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle,
        runnerTemp: dir,
        eventName: "pull_request_target",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: base,
        event: {
          repository: { full_name: "example/consumer" },
          pull_request: { base: { sha: base }, head: { sha: head } }
        },
        authorityBaseRevision: base,
        baseRevision: base,
        headRevision: head
      });
      assert.equal(result.ok, true, result.reasons.join(" | "));
      assert.equal(result.authenticatedProviderGrants.length, 1);
      assert.equal(result.evidenceFacts.length, 1);
      assert.equal(result.observationFacts.length, 0);
      assert.equal(result.evidenceFacts[0].key, "domain:example");
      assert.equal(result.evidenceFacts[0].status, "pass");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
