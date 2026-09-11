import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();

function policy(maxNewFiles = 20) {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "documentation",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
    },
    diff_rules: {
      max_new_docs: 5,
      max_new_files: maxNewFiles,
      max_net_added_lines: 500,
    },
    content_rules: [],
    cochange_rules: [],
  };
}

function retiredBasePolicy(maxNewFiles = 20) {
  const base = policy(maxNewFiles);
  base.integration = {
    workflows: [{
      id: "repo-guard-pr",
      kind: "github_actions",
      path: ".github/workflows/repo-guard.yml",
      role: "repo_guard_pr_gate",
    }],
  };
  base.evidence_bindings = [{
    id: "legacy-workflow-coverage",
    kind: "workflow_path_coverage",
    source: {
      document: "contract-conformance.current.conformance",
      pointer: "/requiredExecutableGates",
      projection: "array_items",
      type: "repository_path_set",
    },
    workflow: "project-ci",
    covers: ["tests/**"],
  }];
  return base;
}

function intent() {
  return `\`\`\`repo-guard-yaml
change_type: governance
scope:
  - repo-policy.json
budgets: {}
anchors: { affects: [], implements: [], verifies: [] }
must_touch:
  - repo-policy.json
must_not_touch: []
expected_effects:
  - migrate historical policy to the current repo-guard vocabulary
\`\`\``;
}

function grant(allowPolicyRelaxation = []) {
  return `\`\`\`repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
allow_policy_relaxation: ${JSON.stringify(allowPolicyRelaxation)}
\`\`\``;
}

function fakeGh(issueBody) {
  const root = mkdtempSync(join(tmpdir(), "rg-c3-10a-gh-"));
  const gh = join(root, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const a=process.argv.slice(2), i=a.indexOf('--jq'), q=i>=0?a[i+1]:'';
if(a.includes('--version')) console.log('gh 0.0');
else if(q==='.body') console.log(${JSON.stringify(issueBody)});
else if(q.includes('author_association')) console.log(JSON.stringify({body:${JSON.stringify(issueBody)},user:{login:'maintainer',type:'User'},author_association:'OWNER',labels:[]}));
else if(q.includes('permission')) console.log(JSON.stringify({permission:'write',role_name:'write'}));
else console.log(JSON.stringify({labels:[]}));
`);
  chmodSync(gh, 0o755);
  return root;
}

function externalCutoverRepo({ baseMaxNewFiles = 20, headMaxNewFiles = 20 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rg-c3-10a-external-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@test.com");
  git(root, "config", "user.name", "Test");

  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(retiredBasePolicy(baseMaxNewFiles), null, 2));
  writeFileSync(join(root, "README.md"), "consumer\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "historical external consumer policy");

  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(policy(headMaxNewFiles), null, 2));
  git(root, "add", "repo-policy.json");
  git(root, "commit", "-m", "migrate to current policy vocabulary");

  assert.equal(existsSync(join(root, "schemas")), false, "external consumer must not vendor repo-guard schemas");
  return root;
}

function run(root, issueBody) {
  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      number: 42,
      base: { sha: "HEAD~1" },
      head: { sha: "HEAD" },
      body: `${intent()}\n\nFixes #77`,
    },
    repository: { full_name: "owner/repo" },
  }));
  const fakeDir = fakeGh(issueBody);
  try {
    return spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], {
      cwd: root,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, PATH: `${fakeDir}:${process.env.PATH}` },
      encoding: "utf-8",
    });
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

{
  const root = externalCutoverRepo();
  try {
    const result = run(root, `${intent()}\n${grant()}`);
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /OK: repo-policy\.json \(PR head\)/);
    assert.doesNotMatch(output, /Base policy compilation failed/);
    assert.match(output, /PASS: governance-change-authorization/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = externalCutoverRepo({ baseMaxNewFiles: 5, headMaxNewFiles: 20 });
  try {
    const result = run(root, `${intent()}\n${grant()}`);
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 1, output);
    assert.doesNotMatch(output, /Base policy compilation failed/);
    assert.match(output, /FAIL: policy-relaxation/);
    assert.match(output, /\/diff_rules/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("C3.10a external historical BASE cutover regression passed");
