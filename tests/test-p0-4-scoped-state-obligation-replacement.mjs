import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
const OLD_SHA = "be59be254eddf753e938f62ba1d749ec7a37fe8a";
const NEW_SHA = "f4e77cb58cd01274a4cecb6374c71b04f288c44a";
const ACTION_PIN_POINTER = "/document_relations/rules/pack:repo-guard-workflow:action-pin";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
const commit = (cwd, message) => { git(cwd, "add", "-A"); git(cwd, "commit", "-m", message); return git(cwd, "rev-parse", "HEAD"); };

function policy(sha) {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [], canonical_docs: [], operational_paths: [],
      governance_paths: ["repo-policy.json", ".github/workflows/repo-guard.yml"],
    },
    diff_rules: { max_new_docs: 0, max_new_files: 0, max_net_added_lines: 100 },
    packs: {
      "version-governance": {
        authority: { path: "package.json", pointer: "/version" },
        advance: "semver",
        mirrors: [
          { path: "package-lock.json", pointer: "/version" },
          { path: "package-lock.json", pointer: "/packages//version" },
        ],
      },
      "repo-guard-workflow": { path: ".github/workflows/repo-guard.yml", sha },
    },
    content_rules: [], cochange_rules: [],
    cochange_groups: [{ id: "application-version-metadata", members: ["package.json", "package-lock.json"] }],
  };
}

function workflow(sha) {
  return `name: Repo Guard\non: [pull_request]\npermissions:\n  contents: read\n  issues: read\n  pull-requests: read\njobs:\n  policy-check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n      - uses: netkeep80/repo-guard@${sha}\n        with:\n          mode: check-pr\n          enforcement: blocking\n`;
}

function writeVersionFiles(root, version) {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer", version }, null, 2));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "consumer", version, lockfileVersion: 3, requires: true,
    packages: { "": { name: "consumer", version } },
  }, null, 2));
}

function changeIntent() {
  return `\`\`\`repo-guard-yaml
change_type: governance
scope:
  - .github/workflows/repo-guard.yml
  - repo-policy.json
  - package.json
  - package-lock.json
budgets:
  max_new_files: 0
  max_new_docs: 0
  max_net_added_lines: 100
anchors: { affects: [], implements: [], verifies: [] }
must_touch:
  - .github/workflows/repo-guard.yml
  - repo-policy.json
must_not_touch: []
expected_effects:
  - replace one exact repo-guard Action pin under trusted governance
  - preserve version-governance as an independent BASE transaction obligation
\`\`\``;
}

function grant() {
  return `\`\`\`repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
  - .github/workflows/repo-guard.yml
allow_policy_relaxation:
  - ${ACTION_PIN_POINTER}
allow_atomic_governance_cutover: true
\`\`\``;
}

function fakeGh(issueBody, permission = "write") {
  const root = mkdtempSync(join(tmpdir(), "rg-p0-4-gh-"));
  const gh = join(root, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const a = process.argv.slice(2), q = a[a.indexOf('--jq') + 1] || '';
if (a.includes('--version')) console.log('gh 0.0');
else if (a.some((item) => item.includes('/collaborators/'))) console.log(JSON.stringify({permission:${JSON.stringify(permission)},role_name:${JSON.stringify(permission)}}));
else if (q.includes('author_association')) console.log(JSON.stringify({body:${JSON.stringify(issueBody)},user:{login:'maintainer',type:'User'},author_association:'OWNER',labels:[]}));
else if (q === '.body') console.log(${JSON.stringify(issueBody)});
else console.log(JSON.stringify({}));
`);
  chmodSync(gh, 0o755);
  return root;
}

function setup({ bumpVersion }) {
  const sandbox = mkdtempSync(join(tmpdir(), "rg-p0-4-state-cutover-"));
  const remote = join(sandbox, "origin.git"), root = join(sandbox, "worker");
  git(sandbox, "init", "--bare", remote);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(policy(OLD_SHA), null, 2));
  writeFileSync(join(root, ".github/workflows/repo-guard.yml"), workflow(OLD_SHA));
  writeVersionFiles(root, "0.5.1");
  const base = commit(root, "accepted consumer baseline");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-u", "origin", "main");
  git(root, "switch", "-c", "repin");
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(policy(NEW_SHA), null, 2));
  writeFileSync(join(root, ".github/workflows/repo-guard.yml"), workflow(NEW_SHA));
  if (bumpVersion) writeVersionFiles(root, "0.5.2");
  const head = commit(root, bumpVersion ? "repin with version bump" : "repin without version bump");
  return { sandbox, root, base, head };
}

function runScenario({ bumpVersion, permission = "write" }) {
  const fixture = setup({ bumpVersion });
  const issueBody = grant();
  const fakeDir = fakeGh(issueBody, permission);
  const eventPath = join(fixture.root, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      number: 77,
      base: { sha: fixture.base, ref: "main" },
      head: { sha: fixture.head },
      body: `${changeIntent()}\n\nFixes #77`,
    },
    repository: { full_name: "owner/repo" },
  }));
  try {
    const result = spawnSync(process.execPath, [cli, "--repo-root", fixture.root, "--enforcement", "blocking", "check-pr"], {
      cwd: fixture.root,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, PATH: `${fakeDir}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    return { result, output: `${result.stdout || ""}${result.stderr || ""}` };
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(fixture.sandbox, { recursive: true, force: true });
  }
}

{
  const { result, output } = runScenario({ bumpVersion: false });
  assert.equal(result.status, 1, output);
  assert.match(output, /FAIL: document-relation:pack:version-governance:advance/);
  assert.doesNotMatch(output, /FAIL: document-relation:pack:repo-guard-workflow:action-pin/,
    "trusted exact state replacement must not leave the obsolete BASE action pin as a veto");
  assert.doesNotMatch(output, /FAIL: policy-relaxation/);
  assert.doesNotMatch(output, /FAIL: governance-change-authorization/);
}

{
  const { result, output } = runScenario({ bumpVersion: true });
  assert.equal(result.status, 0, output);
  assert.match(output, /State obligation plan: replaced 1 exact BASE state constraint\(s\): document-relation:pack:repo-guard-workflow:action-pin/);
  assert.match(output, /PASS: proposed-policy:document-relation:pack:repo-guard-workflow:action-pin/);
  assert.doesNotMatch(output, /FAIL: document-relation:pack:repo-guard-workflow:action-pin/);
  assert.doesNotMatch(output, /FAIL: policy-relaxation/);
  assert.doesNotMatch(output, /FAIL: governance-change-authorization/);
}

console.log("P0.4 scoped state-obligation replacement regression passed");
