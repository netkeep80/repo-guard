import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
const oldRef = "a".repeat(40);
const newRef = "b".repeat(40);
const otherRef = "c".repeat(40);
const workflowPath = ".github/workflows/repo-guard.yml";

function policy(ref, { includeIssuesPermission = true } = {}) {
  const permissions = { contents: "read", "pull-requests": "read" };
  if (includeIssuesPermission) permissions.issues = "read";
  return {
    policy_format_version: "0.3.0",
    repository_kind: "application",
    enforcement: { mode: "blocking" },
    integration: {
      workflows: [{
        id: "repo-guard-pr-gate",
        kind: "github_actions",
        path: workflowPath,
        role: "repo_guard_pr_gate",
        expect: {
          events: ["pull_request"],
          event_types: ["opened", "synchronize", "reopened", "ready_for_review"],
          action: { uses: "owner/repo-guard", ref, ref_pinning: "sha" },
          mode: "check-pr",
          enforcement: "blocking",
          permissions,
          token_env: ["GH_TOKEN"],
          summary: true,
          disallow: ["continue_on_error", "manual_clone", "direct_temp_cli_execution"],
        },
      }],
    },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: ["repo-policy.json", ".github/workflows/**"],
      operational_paths: [],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 },
    content_rules: [],
    cochange_rules: [],
  };
}

function workflow(ref, { includeIssuesPermission = true } = {}) {
  return `name: Policy\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n\npermissions:\n  contents: read\n${includeIssuesPermission ? "  issues: read\n" : ""}  pull-requests: read\n\njobs:\n  policy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n        with:\n          fetch-depth: 0\n      - id: guard\n        uses: owner/repo-guard@${ref}\n        with:\n          mode: check-pr\n          enforcement: blocking\n        env:\n          GH_TOKEN: \${{ github.token }}\n      - if: always()\n        run: echo ok >> \"$GITHUB_STEP_SUMMARY\"\n`;
}

function intent(changeType = "governance") {
  return `\`\`\`repo-guard-yaml
change_type: ${changeType}
scope:
  - repo-policy.json
  - ${workflowPath}
budgets:
  max_new_files: 0
  max_new_docs: 0
  max_net_added_lines: 20
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - repo-policy.json
  - ${workflowPath}
must_not_touch: []
expected_effects:
  - exact action pin changes atomically
\`\`\``;
}

function grant({ atomic = true, paths = ["repo-policy.json", workflowPath], relaxations = ["/integration/workflows/repo-guard-pr-gate"] } = {}) {
  return `\`\`\`repo-guard-grant
authorized_governance_paths:
${paths.map((path) => `  - ${path}`).join("\n")}
allow_policy_relaxation:
${relaxations.map((pointer) => `  - ${pointer}`).join("\n")}
allow_atomic_governance_cutover: ${atomic}
\`\`\``;
}

function createFixture({ basePolicy = policy(oldRef), baseWorkflow = workflow(oldRef) } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rg-atomic-repin-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@test.com");
  git(root, "config", "user.name", "Test");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(basePolicy, null, 2));
  writeFileSync(join(root, workflowPath), baseWorkflow);
  git(root, "add", "-A");
  git(root, "commit", "-m", "base exact pin");
  return root;
}

function installFakeGh(issueBody, { trusted = true } = {}) {
  const fakeDir = mkdtempSync(join(tmpdir(), "rg-atomic-repin-gh-"));
  const gh = join(fakeDir, "gh");
  const association = trusted ? "OWNER" : "NONE";
  const permission = trusted ? "write" : "read";
  writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
const jqIndex = args.indexOf('--jq');
const jq = jqIndex >= 0 ? args[jqIndex + 1] : '';
if (args.includes('--version')) console.log('gh 0.0');
else if (jq === '.body') console.log(${JSON.stringify(issueBody)});
else if (jq.includes('author_association')) console.log(JSON.stringify({ user: { login: 'maintainer', type: 'User' }, author_association: '${association}', labels: [] }));
else if (jq.includes('permission')) console.log(JSON.stringify({ permission: '${permission}', role_name: '${permission}' }));
else console.log(JSON.stringify({ labels: [] }));
`);
  chmodSync(gh, 0o755);
  return fakeDir;
}

function runRepin(root, issueBody, { changeType = "governance", trusted = true } = {}) {
  const fakeDir = installFakeGh(issueBody, { trusted });
  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    pull_request: { number: 42, base: { sha: "HEAD~1" }, head: { sha: "HEAD" }, body: `${intent(changeType)}\n\nCloses #77` },
    repository: { full_name: "owner/repo" },
  }));
  const result = spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], {
    cwd: root,
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath, PATH: `${fakeDir}:${process.env.PATH}` },
    encoding: "utf-8",
  });
  rmSync(fakeDir, { recursive: true, force: true });
  return result;
}

function commitRepin(root, { nextPolicy = policy(newRef), nextWorkflow = workflow(newRef) } = {}) {
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(nextPolicy, null, 2));
  writeFileSync(join(root, workflowPath), nextWorkflow);
  git(root, "add", "-A");
  git(root, "commit", "-m", "atomic repin");
}

function outputOf(result) {
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function expectRejected(result) {
  assert.equal(result.status, 1, outputOf(result));
}

describe("trusted atomic integration repin", () => {
  it("accepts an exact Action ref transition when base and head wiring are atomically replaced under a trusted narrow grant", () => {
    const root = createFixture();
    try {
      commitRepin(root);
      const result = runRepin(root, grant());
      const output = outputOf(result);
      assert.match(output, /PASS: governance-change-authorization/);
      assert.match(output, /PASS: policy-relaxation/);
      assert.match(output, /PASS: proposed-policy:integration-workflows/);
      assert.equal(result.status, 0, output);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the same repin without explicit atomic-cutover opt-in", () => {
    const root = createFixture();
    try {
      commitRepin(root);
      expectRejected(runRepin(root, grant({ atomic: false })));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an atomic repin when the linked-issue authorizer is not trusted", () => {
    const root = createFixture();
    try {
      commitRepin(root);
      expectRejected(runRepin(root, grant(), { trusted: false }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an atomic repin when a changed governance path is not authorized", () => {
    const root = createFixture();
    try {
      commitRepin(root);
      expectRejected(runRepin(root, grant({ paths: ["repo-policy.json"] })));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an atomic repin when the grant does not cover the actual policy delta", () => {
    const root = createFixture();
    try {
      commitRepin(root);
      expectRejected(runRepin(root, grant({ relaxations: ["/integration/workflows/some-other-gate"] })));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an atomic repin when the HEAD workflow does not satisfy the HEAD exact ref", () => {
    const root = createFixture();
    try {
      commitRepin(root, { nextWorkflow: workflow(otherRef) });
      const result = runRepin(root, grant());
      assert.match(outputOf(result), /FAIL: proposed-policy:integration-workflows/);
      expectRejected(result);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps unrelated integration failures blocking during an atomic repin", () => {
    const root = createFixture({ baseWorkflow: workflow(oldRef, { includeIssuesPermission: false }) });
    try {
      commitRepin(root, { nextWorkflow: workflow(newRef, { includeIssuesPermission: false }) });
      const result = runRepin(root, grant());
      assert.match(outputOf(result), /permission issues: read/);
      expectRejected(result);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let HEAD policy erase an unrelated BASE integration expectation", () => {
    const root = createFixture();
    try {
      commitRepin(root, {
        nextPolicy: policy(newRef, { includeIssuesPermission: false }),
        nextWorkflow: workflow(newRef, { includeIssuesPermission: false }),
      });
      const result = runRepin(root, grant());
      assert.match(outputOf(result), /PASS: proposed-policy:integration-workflows/);
      expectRejected(result);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an atomic repin under a non-governance ChangeIntent", () => {
    const root = createFixture();
    try {
      commitRepin(root);
      expectRejected(runRepin(root, grant(), { changeType: "bugfix" }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
