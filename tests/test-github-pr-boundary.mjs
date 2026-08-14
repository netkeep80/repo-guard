import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGitHubEvent } from "../dist/github-pr.mjs";

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
