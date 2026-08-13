import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { loadGitHubEvent, resolvePRChangeIntentFacts } from "../src/github-pr.mjs";
import { extractLinkedIssueNumbers, resolveChangeIntent } from "../src/change-intent.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "src/repo-guard.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
const intent = (scope = ["src/**"], type = "feature") => `\`\`\`repo-guard-yaml
change_type: ${type}
scope:
${scope.map((item) => `  - ${item}`).join("\n")}
budgets: { max_new_files: 5, max_net_added_lines: 500 }
anchors: { affects: [], implements: [], verifies: [] }
must_touch: []
must_not_touch: []
expected_effects: ["effect"]
\`\`\``;
const grant = (paths = ["schemas/**"]) => `\`\`\`repo-guard-grant
authorized_governance_paths:
${paths.map((item) => `  - ${item}`).join("\n")}
allow_policy_relaxation: []
\`\`\``;

function tinyRepo(prefix, governance = ["repo-policy.json"]) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, "init", "-b", "main"); git(root, "config", "user.email", "test@test.com"); git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify({
    policy_format_version: "0.3.0", repository_kind: "library", enforcement: { mode: "blocking" },
    paths: { forbidden: [], canonical_docs: [], governance_paths: governance },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 }, content_rules: [], cochange_rules: [],
  }));
  writeFileSync(join(root, "a.txt"), "a\n"); git(root, "add", "-A"); git(root, "commit", "-m", "base");
  return root;
}
function run(root, body, extraEnv = {}) {
  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42, base: { sha: "HEAD~1" }, head: { sha: "HEAD" }, body }, repository: { full_name: "owner/repo" } }));
  return spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], { cwd: root, env: { ...process.env, GITHUB_EVENT_PATH: eventPath, ...extraEnv }, encoding: "utf-8" });
}

describe("GitHub event and ChangeIntent resolution", () => {
  it("fails cleanly outside GitHub Actions", () => {
    const saved = process.env.GITHUB_EVENT_PATH; delete process.env.GITHUB_EVENT_PATH;
    try { assert.equal(loadGitHubEvent().error, "no_event"); }
    finally { if (saved === undefined) delete process.env.GITHUB_EVENT_PATH; else process.env.GITHUB_EVENT_PATH = saved; }
  });

  it("reads pull_request event data", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-event-")), path = join(root, "event.json"), saved = process.env.GITHUB_EVENT_PATH;
    writeFileSync(path, JSON.stringify({ pull_request: { number: 7, base: { sha: "aaa", ref: "main" }, head: { sha: "bbb" }, body: "Fixes #9" }, repository: { full_name: "owner/repo" } }));
    process.env.GITHUB_EVENT_PATH = path;
    try { const event = loadGitHubEvent(); assert.equal(event.ok, true); assert.equal(event.prNumber, 7); assert.equal(event.baseRef, "main"); assert.equal(event.repoFullName, "owner/repo"); }
    finally { if (saved === undefined) delete process.env.GITHUB_EVENT_PATH; else process.env.GITHUB_EVENT_PATH = saved; rmSync(root, { recursive: true, force: true }); }
  });

  it("uses PR ChangeIntent and linked-issue GovernanceGrant independently", () => {
    const prBody = `${intent(["schemas/**"])}\n\nFixes #77`;
    const facts = resolvePRChangeIntentFacts({ prBody, issueBody: `${intent(["schemas/**"])}\n\n${grant()}` });
    assert.equal(facts.ok, true); assert.equal(facts.changeIntentSource, "pr body");
    assert.deepEqual(facts.grantResult.grant.authorized_governance_paths, ["schemas/**"]);
  });

  it("falls back to issue ChangeIntent and keeps the same issue grant", () => {
    const facts = resolvePRChangeIntentFacts({ prBody: "Fixes #15", issueBody: `${intent(["src/new.mjs"])}\n${grant(["repo-policy.json"])}` });
    assert.equal(facts.ok, true); assert.equal(facts.changeIntentSource, "linked issue");
    assert.equal(facts.changeIntent.scope[0], "src/new.mjs"); assert.equal(facts.grantResult.grant.authorized_governance_paths[0], "repo-policy.json");
  });

  it("rejects ambiguous linked issues only when fallback is needed", () => {
    const body = "Fixes #10\nCloses #20";
    assert.deepEqual(extractLinkedIssueNumbers(body), [10, 20]);
    assert.equal(resolvePRChangeIntentFacts({ prBody: body }).error, "issue_link_ambiguous");
    assert.equal(resolveChangeIntent(`${intent()}\n${body}`, null).ok, true);
  });
});

describe("check-pr process boundary", () => {
  it("passes shell-looking refs to git without executing them", () => {
    const root = tinyRepo("rg-pr-injection-");
    writeFileSync(join(root, "a.txt"), "changed\n"); git(root, "add", "-A"); git(root, "commit", "-m", "change");
    const marker = join(root, "injected"), eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42, base: { sha: `HEAD~1; touch ${marker}; #` }, head: { sha: "HEAD" }, body: intent(["a.txt"], "bugfix") }, repository: { full_name: "owner/repo" } }));
    const result = spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], { cwd: root, env: { ...process.env, GITHUB_EVENT_PATH: eventPath }, encoding: "utf-8" });
    assert.equal(result.status, 1); assert.equal(existsSync(marker), false);
    rmSync(root, { recursive: true, force: true });
  });

  it("fetches a trusted linked-issue GovernanceGrant even when intent is in PR", () => {
    const root = tinyRepo("rg-pr-grant-", ["schemas/**"]);
    mkdirSync(join(root, "schemas"), { recursive: true }); writeFileSync(join(root, "schemas/a.json"), "{}\n"); git(root, "add", "-A"); git(root, "commit", "-m", "governance");
    const fakeDir = mkdtempSync(join(tmpdir(), "rg-gh-")), gh = join(fakeDir, "gh"), issueBody = `${intent(["schemas/**"])}\n${grant()}`;
    writeFileSync(gh, `#!/usr/bin/env node
const a=process.argv.slice(2), i=a.indexOf('--jq'), q=i>=0?a[i+1]:'';
if(a.includes('--version')) console.log('gh 0.0');
else if(q==='.body') console.log(${JSON.stringify(issueBody)});
else if(q.includes('author_association')) console.log(JSON.stringify({user:{login:'maintainer',type:'User'},author_association:'OWNER',labels:[]}));
else if(q.includes('permission')) console.log(JSON.stringify({permission:'write',role_name:'write'}));
else console.log(JSON.stringify({labels:[]}));
`); chmodSync(gh, 0o755);
    const result = run(root, `${intent(["schemas/**"])}\n\nFixes #77`, { PATH: `${fakeDir}:${process.env.PATH}` });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 0, output); assert.match(output, /PASS: governance-change-authorization/);
    rmSync(root, { recursive: true, force: true }); rmSync(fakeDir, { recursive: true, force: true });
  });
});
