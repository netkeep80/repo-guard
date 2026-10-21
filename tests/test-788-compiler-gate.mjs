import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(project, ".github/workflows/compiler-gate.yml");
const workflow = readFileSync(workflowPath, "utf8");

// C2-04/C2-05/C2-07/C2-09: the required evaluator is base-owned and candidate code is data only.
assert.match(workflow, /^\s{2}pull_request_target:\s*$/m);
assert.doesNotMatch(workflow, /^\s{2}pull_request:\s*$/m);
assert.match(workflow, /^permissions:\s*\n\s{2}contents: read\s*$/m);
assert.doesNotMatch(workflow, /^\s{2}[\w-]+:\s*write\s*$/m);
assert.match(workflow, /^\s{2}compiler-gate:\s*$/m);
assert.match(workflow, /^\s{4}name:\s*compiler-gate\s*$/m);
assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}/);
assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
assert.match(workflow, /persist-credentials:\s*false/);
assert.match(workflow, /fetch-depth:\s*0/);
assert.doesNotMatch(workflow, /allow-unsafe-pr-checkout/);
assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/repo-guard\/candidate/);
assert.match(workflow, /OBSERVED_HEAD=.*refs\/remotes\/repo-guard\/candidate/);
assert.match(workflow, /test "\$OBSERVED_HEAD" = "\$HEAD_SHA"/);
assert.match(workflow, /EVALUATOR_SHA="\$\(git rev-parse HEAD\)"/);
assert.match(workflow, /test "\$EVALUATOR_SHA" = "\$BASE_SHA"/);
assert.match(workflow, /npm ci --omit=dev --ignore-scripts/);
assert.match(workflow, /node dist\/repo-guard\.mjs check[\s\S]*--base "\$BASE_SHA"[\s\S]*--head "\$HEAD_SHA"[\s\S]*--format summary/);
assert.doesNotMatch(workflow, /uses:\s*\.\//);
assert.doesNotMatch(workflow, /create-github-app-token/);
assert.doesNotMatch(workflow, /secrets\./);
assert.doesNotMatch(workflow, /GH_TOKEN/);
assert.doesNotMatch(workflow, /github\.event\.pull_request\.(?:body|title|head\.ref)/);
assert.doesNotMatch(workflow, /npm\s+(?:test|run|exec|start)\b/);

// C2-01/C2-02/C2-03/C2-06/C2-08: exact compiler semantics are the C1 path and ignore PR metadata.
const root = mkdtempSync(join(tmpdir(), "repo-guard-c2-"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const put = (path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
};
const commit = (message) => {
  git("add", "-A");
  git("-c", "user.name=C2 Fixture", "-c", "user.email=c2@example.invalid", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
};
const requirement = (target = "src/a.txt") => `format: repo-guard/requirement-v1
id: CORE
normative: "C2 fixture"
relations:
  - predicates: [implemented_by]
    target:
      kind: artifact
      path: "${target}"
`;

try {
  git("init", "-q");
  put("requirements/core.rg.yaml", requirement());
  put("src/a.txt", "base\n");
  const base = commit("base");

  put("src/a.txt", "valid\n");
  const head = commit("valid");

  const cli = resolve(project, "dist/repo-guard.mjs");
  const run = (env) => JSON.parse(execFileSync(process.execPath, [
    cli, "--repo-root", root, "check", "--base", base, "--head", head, "--format", "json",
  ], { cwd: root, encoding: "utf8", env }));

  const clean = run({ PATH: process.env.PATH });
  assert.equal(clean.ok, true, "C2-01 valid transition must be GREEN");

  const metadata = run({
    PATH: process.env.PATH,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_PATH: "/not/read.json",
    GITHUB_HEAD_REF: "candidate",
    PR_TITLE: "metadata edit must not matter",
    PR_BODY: "no ChangeIntent, WorkIntent, GovernanceGrant or TransitionReceipt",
  });
  assert.deepEqual(metadata, clean, "C2-03/C2-06/C2-08 exact report must ignore CI/PR metadata");

  put("orphan.tmp", "unjustified\n");
  const redHead = commit("semantic red");
  const red = spawnSync(process.execPath, [
    cli, "--repo-root", root, "check", "--base", head, "--head", redHead, "--format", "json",
  ], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(red.status, 1, "C2-02 semantic violation must fail the process");
  assert.equal(JSON.parse(red.stdout).ok, false, "C2-02 semantic violation must be RED");

  console.log("C2 ordinary compiler gate adversarial matrix: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
// C2 live probe: harmless Requirement-owned verifier comment; no legacy PR metadata.
