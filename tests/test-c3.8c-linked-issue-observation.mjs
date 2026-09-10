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
expected_effects: ["same trust result with one linked-issue observation"]
\`\`\``;
const grant = `\`\`\`repo-guard-grant
authorized_governance_paths:
  - schemas/**
allow_policy_relaxation: []
\`\`\``;

test("check-pr reuses one linked-issue observation across grant and trust resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-c38c-"));
  const fakeDir = mkdtempSync(join(tmpdir(), "rg-c38c-gh-"));
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

    const issueBody = `${intent}\n${grant}`;
    const callLog = join(fakeDir, "api-calls.log");
    const gh = join(fakeDir, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const a = process.argv.slice(2), i = a.indexOf('--jq'), q = i >= 0 ? a[i + 1] : '', route = a[1] || '';
if (a.includes('--version')) { console.log('gh 0.0'); process.exit(0); }
if (a[0] === 'api') appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(a) + '\\n');
if (route.endsWith('/issues/77')) {
  if (q === '.body') console.log(${JSON.stringify(issueBody)});
  else console.log(JSON.stringify({body:${JSON.stringify(issueBody)},user:{login:'maintainer',type:'User'},author_association:'OWNER',labels:[]}));
} else if (route.includes('/collaborators/')) {
  console.log(JSON.stringify({permission:'write',role_name:'write'}));
} else {
  console.log(JSON.stringify({labels:[]}));
}
`);
    chmodSync(gh, 0o755);

    const eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      pull_request: {
        number: 42,
        base: { sha: "HEAD~1" },
        head: { sha: "HEAD" },
        body: `${intent}\n\nFixes #77`,
      },
      repository: { full_name: "owner/repo" },
    }));

    const result = spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], {
      cwd: root,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, PATH: `${fakeDir}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /PASS: governance-change-authorization/);

    const calls = readFileSync(callLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const issueReads = calls.filter((args) => String(args[1] || "").endsWith("/issues/77"));
    const prReads = calls.filter((args) => String(args[1] || "").endsWith("/pulls/42"));
    const permissionReads = calls.filter((args) => String(args[1] || "").includes("/collaborators/maintainer/permission"));

    assert.deepEqual(
      { totalRestReads: calls.length, linkedIssueReads: issueReads.length, prReads: prReads.length, permissionReads: permissionReads.length },
      { totalRestReads: 3, linkedIssueReads: 1, prReads: 1, permissionReads: 1 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  }
});
