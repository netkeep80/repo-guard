import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();

const intent = `\`\`\`repo-guard-yaml
change_type: refactor
scope:
  - schemas/**
budgets: { max_new_files: 1, max_net_added_lines: 100 }
anchors: { affects: [], implements: [], verifies: [] }
must_touch: []
must_not_touch: []
expected_effects: ["skip trust-only permission lookup when no valid grant exists"]
\`\`\``;

const validGrant = `\`\`\`repo-guard-grant
authorized_governance_paths:
  - schemas/**
allow_policy_relaxation: []
\`\`\``;

const malformedGrant = `\`\`\`repo-guard-grant
authorized_governance_paths: [
\`\`\``;

function summarizeCalls(calls) {
  return {
    totalRestReads: calls.length,
    linkedIssueReads: calls.filter((args) => String(args[1] || "").endsWith("/issues/77")).length,
    permissionReads: calls.filter((args) => String(args[1] || "").includes("/collaborators/maintainer/permission")).length,
  };
}

test("check-pr resolves repository permission only for a schema-valid GovernanceGrant", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-p22-"));
  const fakeDir = mkdtempSync(join(tmpdir(), "rg-p22-gh-"));
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "test@test.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "repo-policy.json"), JSON.stringify({
      policy_format_version: "0.3.0",
      repository_kind: "library",
      enforcement: { mode: "blocking" },
      paths: { forbidden: [], canonical_docs: [], governance_paths: ["schemas/**"] },
      diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 },
      content_rules: [],
      cochange_rules: [],
    }));
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "base");

    mkdirSync(join(root, "schemas"));
    writeFileSync(join(root, "schemas/a.json"), "{}\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "governance");

    const baseSha = git(root, "rev-parse", "HEAD~1");
    const headSha = git(root, "rev-parse", "HEAD");
    const eventPath = join(root, "event.json");
    const callLog = join(fakeDir, "api-calls.log");
    const gh = join(fakeDir, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2), route = args[1] || '';
if (args.includes('--version')) { console.log('gh 0.0'); process.exit(0); }
if (args[0] === 'api') appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
if (route.endsWith('/issues/77')) {
  console.log(JSON.stringify({
    body: process.env.ISSUE_BODY || '',
    user: { login: 'maintainer', type: 'User' },
    author_association: 'OWNER',
    labels: [],
  }));
} else if (route.includes('/collaborators/maintainer/permission')) {
  const permission = process.env.PERMISSION || 'write';
  console.log(JSON.stringify({ permission, role_name: permission }));
} else {
  console.log('{}');
}
`);
    chmodSync(gh, 0o755);

    const run = ({ linked = true, issueBody = "", permission = "write" } = {}) => {
      writeFileSync(callLog, "");
      writeFileSync(eventPath, JSON.stringify({
        pull_request: {
          number: 42,
          base: { sha: baseSha },
          head: { sha: headSha },
          body: `${intent}${linked ? "\n\nFixes #77" : ""}`,
        },
        repository: { full_name: "owner/repo" },
      }));
      const result = spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: eventPath,
          PATH: `${fakeDir}:${process.env.PATH}`,
          ISSUE_BODY: issueBody,
          PERMISSION: permission,
        },
        encoding: "utf-8",
      });
      const lines = readFileSync(callLog, "utf-8").trim().split("\n").filter(Boolean);
      return {
        result,
        output: `${result.stdout || ""}${result.stderr || ""}`,
        calls: summarizeCalls(lines.map((line) => JSON.parse(line))),
      };
    };

    const noIssue = run({ linked: false });
    assert.equal(noIssue.result.status, 1, noIssue.output);
    assert.deepEqual(noIssue.calls, { totalRestReads: 0, linkedIssueReads: 0, permissionReads: 0 });

    const noGrant = run({ issueBody: "ChangeIntent is already in the PR body." });
    assert.equal(noGrant.result.status, 1, noGrant.output);
    assert.deepEqual(noGrant.calls, { totalRestReads: 1, linkedIssueReads: 1, permissionReads: 0 });

    const malformed = run({ issueBody: malformedGrant });
    assert.equal(malformed.result.status, 1, malformed.output);
    assert.match(malformed.output, /governance-grant/);
    assert.deepEqual(malformed.calls, { totalRestReads: 1, linkedIssueReads: 1, permissionReads: 0 });

    const untrusted = run({ issueBody: validGrant, permission: "read" });
    assert.equal(untrusted.result.status, 1, untrusted.output);
    assert.deepEqual(untrusted.calls, { totalRestReads: 2, linkedIssueReads: 1, permissionReads: 1 });

    const trusted = run({ issueBody: validGrant, permission: "write" });
    assert.equal(trusted.result.status, 0, trusted.output);
    assert.match(trusted.output, /PASS: governance-change-authorization/);
    assert.deepEqual(trusted.calls, { totalRestReads: 2, linkedIssueReads: 1, permissionReads: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  }
});
