import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(root, ".github/workflows/trusted-enforcement.yml");

assert.equal(
  existsSync(workflowPath),
  true,
  "trusted enforcement workflow must exist outside candidate-controlled CI",
);

const workflow = readFileSync(workflowPath, "utf8");

assert.match(workflow, /pull_request_target:\s*\n/, "trusted enforcement must run from base-owned pull_request_target");
assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m, "trusted enforcement must not be sourced from pull_request candidate workflow");
assert.match(workflow, /^\s{2}validate:\s*$/m, "trusted workflow must own the existing required validate check");

assert.match(workflow, /^permissions:\s*\n\s{2}contents: read\s*\n\s{2}pull-requests: read\s*\n\s{2}issues: read\s*$/m,
  "trusted enforcement token must be read-only and minimal");
assert.doesNotMatch(workflow, /:\s*write\b/, "trusted enforcement must not request write permissions");

assert.match(workflow, /uses: actions\/checkout@v6/, "trusted enforcement must checkout accepted base source");
assert.match(workflow, /fetch-depth:\s*0/, "trusted enforcement needs complete history for exact B\/M\/H observation");
assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/,
  "trusted checkout must never switch to the candidate head");
assert.doesNotMatch(workflow, /allow-unsafe-pr-checkout/, "trusted workflow must never opt into untrusted checkout");

assert.match(workflow, /PR_NUMBER:\s*\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/,
  "PR number must enter shell only through an environment variable");
assert.match(workflow, /EXPECTED_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
  "expected PR head must enter shell only through an environment variable");
assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/pull\/\$\{PR_NUMBER\}\/head/,
  "candidate head must be fetched only as a Git object");
assert.match(workflow, /git rev-parse refs\/remotes\/pull\/\$\{PR_NUMBER\}\/head/,
  "fetched candidate object must be checked against event head identity");
assert.match(workflow, /uses:\s*\.\//, "trusted enforcement must execute accepted repo-guard from base checkout");

assert.doesNotMatch(workflow, /npm\s+(?:ci|install|test|run)\b/, "trusted workflow must not execute candidate package scripts");
assert.doesNotMatch(workflow, /github\.event\.pull_request\.(?:title|body|head\.ref)/,
  "untrusted PR text or branch name must not be interpolated into trusted workflow commands");

console.log("P0.3 trusted enforcement workflow boundary: ok");
