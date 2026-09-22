import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const source = readFileSync(resolve(root, ".github/workflows/trusted-enforcement.yml"), "utf8");
const document = parseDocument(source);
assert.equal(document.errors.length, 0);
const workflow = document.toJS();

assert.deepEqual(
  workflow.on?.issues?.types,
  ["edited"],
  "trusted authority must react when a linked issue body is edited",
);

assert.equal(
  workflow.concurrency?.group,
  "trusted-enforcement-${{ github.event.pull_request.number || format('issue-{0}', github.event.issue.number) }}",
  "PR and issue authority events need independent stable concurrency keys",
);

assert.deepEqual(
  workflow.permissions,
  {
    contents: "read",
    "pull-requests": "read",
    issues: "read",
  },
  "GITHUB_TOKEN must remain read-only; status mutation belongs only to the dedicated App",
);

const evaluator = workflow.jobs?.["trusted-enforcement"];
assert.ok(evaluator);
assert.match(
  evaluator.if ?? "",
  /github\.event_name\s*==\s*'pull_request_target'/,
  "the normal trusted evaluator must remain scoped to PR events",
);

const invalidator = workflow.jobs?.["linked-issue-authority-invalidation"];
assert.ok(invalidator, "issue edits need one bounded stale-authority invalidation job");
assert.equal(invalidator.environment, "trusted-enforcement");
assert.match(invalidator.if ?? "", /github\.event_name\s*==\s*'issues'/);
assert.match(invalidator.if ?? "", /github\.event\.changes\.body\s*!=\s*null/);

const step = (name) => invalidator.steps?.find((candidate) => candidate.name === name);

const resolveAffected = step("Resolve affected Ready PR heads");
assert.ok(resolveAffected);
assert.equal(resolveAffected.env?.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
assert.equal(resolveAffected.env?.ISSUE_NUMBER, "${{ github.event.issue.number }}");
assert.match(resolveAffected.run ?? "", /issues\/\$\{ISSUE_NUMBER\}\/timeline/);
assert.match(resolveAffected.run ?? "", /cross-referenced/);
assert.match(resolveAffected.run ?? "", /source\.issue\.pull_request/);
assert.match(resolveAffected.run ?? "", /source\.issue\.state == "open"/);
assert.match(resolveAffected.run ?? "", /\.draft/);
assert.match(resolveAffected.run ?? "", /\.base\.ref/);
assert.match(resolveAffected.run ?? "", /\.head\.sha/);
assert.match(resolveAffected.run ?? "", /PR_BODY/);
assert.match(resolveAffected.run ?? "", /Fixes\|Closes\|Resolves\|Part\\s\+of/);
assert.match(resolveAffected.run ?? "", /REPOSITORY/);
assert.match(resolveAffected.run ?? "", /BASE_REF" != "main"/);
assert.match(resolveAffected.run ?? "", /DRAFT" != "false"/);

const appToken = step("Mint dedicated trusted-enforcement App token");
assert.ok(appToken);
assert.equal(
  appToken.uses,
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
);
assert.equal(appToken.with?.["permission-statuses"], "write");

const invalidate = step("Invalidate stale trusted enforcement");
assert.ok(invalidate);
assert.match(invalidate.run ?? "", /state=pending/);
assert.match(invalidate.run ?? "", /context=trusted-enforcement/);
assert.match(invalidate.run ?? "", /statuses\/\$\{HEAD_SHA\}/);
assert.match(
  JSON.stringify(invalidate.env ?? {}),
  /steps\.app-token\.outputs\.token/,
  "pending invalidation must be signed by the dedicated App",
);

assert.doesNotMatch(source, /^\s{2}actions:\s*write\s*$/m);
assert.doesNotMatch(source, /^\s{2}(?:checks|statuses|pull-requests|contents):\s*write\s*$/m);
assert.doesNotMatch(source, /workflow_dispatch:/);

const refreshCheckout = step("Checkout accepted enforcement source for unambiguous refresh");
assert.ok(refreshCheckout);
assert.equal(
  refreshCheckout.if,
  "${{ steps.affected.outputs.count == '1' && steps.app-token.outcome == 'success' }}",
  "automatic reevaluation must be bounded to one affected Ready PR",
);
assert.equal(
  refreshCheckout.uses,
  "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  "issue refresh must execute only accepted default-branch source",
);
assert.equal(refreshCheckout.with?.["fetch-depth"], 0);
assert.equal(refreshCheckout.with?.["persist-credentials"], false);

const refreshEvidence = step("Acquire exact single-PR refresh evidence");
assert.ok(refreshEvidence);
assert.equal(refreshEvidence.env?.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
assert.equal(refreshEvidence.env?.AFFECTED_PATH, "${{ steps.affected.outputs.path }}");
assert.match(refreshEvidence.if ?? "", /steps\.affected\.outputs\.count == '1'/);
assert.match(refreshEvidence.run ?? "", /pulls\/\$\{PR_NUMBER\}/);
assert.match(refreshEvidence.run ?? "", /test \"\$CURRENT_HEAD\" = \"\$EXPECTED_HEAD_SHA\"/);
assert.match(refreshEvidence.run ?? "", /refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/pull\/\$\{PR_NUMBER\}\/head/);
assert.match(refreshEvidence.run ?? "", /refs\/pull\/\$\{PR_NUMBER\}\/merge:refs\/remotes\/pull\/\$\{PR_NUMBER\}\/merge/);
assert.match(refreshEvidence.run ?? "", /test \"\$MERGE_HEAD\" = \"\$EXPECTED_HEAD_SHA\"/);
assert.match(refreshEvidence.run ?? "", /test \"\$MERGE_BASE\" = \"\$CURRENT_BASE\"/);
assert.match(refreshEvidence.run ?? "", /linked-issue-refresh-pull-request\.json/);
assert.match(refreshEvidence.run ?? "", /body: \(\$pr\[0\]\.body \/\/ \"\"\)/);
assert.match(refreshEvidence.run ?? "", /event_path=\$EVENT_PATH/);
assert.match(refreshEvidence.run ?? "", /head_sha=\$OBSERVED_HEAD/);

const refreshEvaluator = step("Re-evaluate accepted repo-guard on unchanged PR head");
assert.ok(refreshEvaluator);
assert.equal(refreshEvaluator.uses, "./");
assert.equal(refreshEvaluator["continue-on-error"], true);
assert.equal(refreshEvaluator.with?.mode, "check-pr");
assert.equal(refreshEvaluator.with?.enforcement, "blocking");
assert.equal(refreshEvaluator.env?.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
assert.equal(refreshEvaluator.env?.RG_EVENT_PATH, "${{ steps.refresh-evidence.outputs.event_path }}");
assert.equal(refreshEvaluator.env?.GITHUB_EVENT_PATH, undefined, "workflow must not attempt to override reserved GitHub event context");
assert.match(refreshEvaluator.if ?? "", /steps\.affected\.outputs\.count == '1'/);
assert.match(refreshEvaluator.if ?? "", /steps\.refresh-evidence\.outcome == 'success'/);

const refreshPublish = step("Publish refreshed trusted enforcement result");
assert.ok(refreshPublish);
assert.equal(refreshPublish.env?.GH_TOKEN, "${{ steps.app-token.outputs.token }}");
assert.equal(refreshPublish.env?.HEAD_SHA, "${{ steps.refresh-evidence.outputs.head_sha }}");
assert.equal(refreshPublish.env?.ENFORCEMENT_OUTCOME, "${{ steps.refresh-enforcement.outcome }}");
assert.match(refreshPublish.run ?? "", /context=trusted-enforcement/);
assert.match(refreshPublish.run ?? "", /statuses\/\$\{HEAD_SHA\}/);
assert.match(refreshPublish.run ?? "", /STATE=success/);
assert.match(refreshPublish.run ?? "", /STATE=failure/);

const refreshEnforce = step("Enforce refreshed trusted result");
assert.ok(refreshEnforce);
assert.match(refreshEnforce.if ?? "", /steps\.affected\.outputs\.count == '1'/);
assert.match(refreshEnforce.run ?? "", /test \"\$ENFORCEMENT_OUTCOME\" = \"success\"/);

const invalidatorSource = JSON.stringify(invalidator);
assert.doesNotMatch(invalidatorSource, /npm\s+(?:ci|install|test|run)\b/);
assert.equal(
  invalidatorSource.includes('"uses":"./"'),
  true,
  "issue refresh must reuse the accepted repo-guard evaluator rather than add a second evaluator",
);
assert.doesNotMatch(
  invalidatorSource,
  /ref:\"?\$\{\{\s*github\.event\.pull_request\.head/,
  "candidate head must never become the checkout source",
);

console.log("P3 linked-issue authority freshness contract passed");
