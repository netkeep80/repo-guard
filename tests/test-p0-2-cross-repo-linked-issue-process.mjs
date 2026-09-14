import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
expected_effects: ["foreign linked issue cannot authorize local governance"]
\`\`\``;
const foreignGrant = `\`\`\`repo-guard-grant
authorized_governance_paths:
  - schemas/**
allow_policy_relaxation: []
\`\`\``;

test("check-pr never rewrites a foreign linked issue into the current repository", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-p02-cross-repo-"));
  const fakeDir = mkdtempSync(join(tmpdir(), "rg-p02-cross-repo-gh-"));
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

    const callLog = join(fakeDir, "api-calls.log");
    const gh = join(fakeDir, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('gh 0.0'); process.exit(0); }
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(a) + '\\n');
if (String(a[1] || '').endsWith('/issues/77')) {
  console.log(JSON.stringify({body:${JSON.stringify(`${intent}\n${foreignGrant}`)},user:{login:'maintainer',type:'User'},author_association:'OWNER',labels:['governance-approved']}));
  process.exit(0);
}
if (String(a[1] || '').includes('/collaborators/')) {
  console.log(JSON.stringify({permission:'admin',role_name:'admin'}));
  process.exit(0);
}
process.exit(1);
`);
    chmodSync(gh, 0o755);

    const eventPath = join(root, "event.json");
    const run = (body) => {
      writeFileSync(eventPath, JSON.stringify({
        pull_request: {
          number: 42,
          base: { sha: "HEAD~1" },
          head: { sha: "HEAD" },
          body,
        },
        repository: { full_name: "owner/repo" },
      }));
      return spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], {
        cwd: root,
        env: { ...process.env, GITHUB_EVENT_PATH: eventPath, PATH: `${fakeDir}:${process.env.PATH}` },
        encoding: "utf-8",
      });
    };
    const apiCalls = () => existsSync(callLog) ? readFileSync(callLog, "utf-8").trim().split("\n").filter(Boolean) : [];

    const fallback = run("Fixes foreign/project#77");
    const fallbackOutput = `${fallback.stdout || ""}${fallback.stderr || ""}`;
    assert.equal(fallback.status, 1, fallbackOutput);
    assert.match(fallbackOutput, /linked issue fallback must belong to owner\/repo; refusing foreign\/project#77/);
    assert.deepEqual(apiCalls(), []);

    const directIntent = run(`${intent}\n\nFixes foreign/project#77`);
    const directOutput = `${directIntent.stdout || ""}${directIntent.stderr || ""}`;
    assert.equal(directIntent.status, 1, directOutput);
    assert.match(directOutput, /cross-repository closing references are not eligible GovernanceGrant sources/);
    assert.match(directOutput, /FAIL: governance-change-authorization/);
    assert.deepEqual(apiCalls(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  }
});
