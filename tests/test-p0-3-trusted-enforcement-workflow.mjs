import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(root, ".github/workflows/trusted-enforcement.yml");

assert.equal(existsSync(workflowPath), true, "trusted enforcement workflow must exist outside candidate-controlled CI");
const workflow = readFileSync(workflowPath, "utf8");

assert.match(workflow, /pull_request_target:\s*\n/, "trusted enforcement must run from base-owned pull_request_target");
assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m, "trusted enforcement must not be sourced from pull_request candidate workflow");
assert.match(workflow, /^\s{2}trusted-enforcement:\s*$/m, "trusted workflow must have a distinct producer job");
assert.doesNotMatch(workflow, /^\s{2}validate:\s*$/m, "ordinary GitHub Actions validate must not be mistaken for the trusted branch gate");
assert.match(workflow, /^\s{4}environment:\s*trusted-enforcement\s*$/m,
  "the App private key must live behind the trusted-enforcement environment boundary");
assert.match(workflow, /vars\.TRUSTED_ENFORCEMENT_APP_CLIENT_ID/,
  "trusted enforcement must remain dormant until the dedicated App is configured");

assert.match(workflow, /^permissions:\s*\n\s{2}contents: read\s*\n\s{2}pull-requests: read\s*\n\s{2}issues: read\s*$/m,
  "base workflow GITHUB_TOKEN must be read-only and minimal");
assert.doesNotMatch(workflow, /^\s{2}[\w-]+:\s*write\s*$/m,
  "base workflow GITHUB_TOKEN must never request write permission");

assert.match(workflow, /uses: actions\\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/, "trusted enforcement must checkout accepted base source");
assert.match(workflow, /fetch-depth:\s*0/, "trusted enforcement needs complete history for exact B\/M\/H observation");
assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/,
  "trusted checkout must never switch to candidate head");
assert.doesNotMatch(workflow, /allow-unsafe-pr-checkout/, "trusted workflow must never opt into untrusted checkout");

assert.match(workflow, /PR_NUMBER:\s*\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/,
  "PR number must enter shell only through an environment variable");
assert.match(workflow, /EXPECTED_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
  "expected PR head must enter shell only through an environment variable");
assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/pull\/\$\{PR_NUMBER\}\/head/,
  "candidate head must be fetched only as a Git object");
assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/merge:refs\/remotes\/pull\/\$\{PR_NUMBER\}\/merge/,
  "the exact PR test-merge commit must be fetched as trusted evidence");
assert.match(workflow, /git rev-parse refs\/remotes\/pull\/\$\{PR_NUMBER\}\/head/,
  "fetched candidate object must be checked against event head identity");
assert.match(workflow, /git rev-parse refs\/remotes\/pull\/\$\{PR_NUMBER\}\/merge/,
  "trusted enforcement must observe the exact test-merge SHA");
assert.match(workflow, /head_sha=\$OBSERVED_HEAD/, "verified PR head SHA must be passed as structured step output");
assert.match(workflow, /merge_sha=\$MERGE_SHA/, "test-merge SHA must remain available as structured evidence");

assert.match(workflow, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/,
  "dedicated App token action must be immutable-pinned");
assert.match(workflow, /client-id:\s*\$\{\{\s*vars\.TRUSTED_ENFORCEMENT_APP_CLIENT_ID\s*\}\}/,
  "dedicated App client id must come from repository configuration");
assert.match(workflow, /private-key:\s*\$\{\{\s*secrets\.TRUSTED_ENFORCEMENT_APP_PRIVATE_KEY\s*\}\}/,
  "dedicated App private key must come only from protected environment secret");
assert.match(workflow, /permission-statuses:\s*write/, "dedicated App token must be limited to writing commit statuses");

assert.match(workflow, /id:\s*enforcement/, "accepted repo-guard result must have a stable step outcome");
assert.match(workflow, /uses:\s*\.\//, "trusted enforcement must execute accepted repo-guard from base checkout");
assert.match(workflow, /continue-on-error:\s*true/, "trusted result must be published even when accepted repo-guard rejects the PR");
assert.match(workflow, /context=trusted-enforcement/, "dedicated App must publish a unique trusted status context");
assert.match(workflow, /state=pending/, "trusted status must become pending before evaluation");
assert.match(workflow, /steps\.enforcement\.outcome/, "final trusted status must derive from process outcome, not prose parsing");
assert.match(workflow, /HEAD_SHA:\s*\$\{\{\s*steps\.evidence\.outputs\.head_sha\s*\}\}/,
  "status target must come from the verified PR head evidence");
assert.match(workflow, /statuses\/\$\{HEAD_SHA\}/,
  "dedicated App status must be attached to the PR head SHA that branch protection evaluates");
assert.doesNotMatch(workflow, /statuses\/\$\{MERGE_SHA\}/,
  "trusted required status must not be published only on the synthetic test-merge SHA");
assert.match(workflow, /steps\.app-token\.outputs\.token/,
  "status publication must authenticate as the dedicated App, not GITHUB_TOKEN");
assert.match(workflow, /test \"\$ENFORCEMENT_OUTCOME\" = \"success\"/,
  "workflow must still fail when accepted trusted enforcement fails");

assert.doesNotMatch(workflow, /npm\s+(?:ci|install|test|run)\b/, "trusted workflow must not execute candidate package scripts");
assert.doesNotMatch(workflow, /github\.event\.pull_request\.(?:title|body|head\.ref)/,
  "untrusted PR text or branch name must not be interpolated into trusted workflow commands");

console.log("P0.3 App-signed trusted enforcement workflow boundary: ok");
