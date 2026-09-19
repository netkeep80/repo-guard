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

const step = (name) => invalidator.steps?.find((candidate) => candidate.name === name);

const checkout = invalidator.steps?.find(
  (candidate) => typeof candidate.uses === "string" && candidate.uses.startsWith("actions/checkout@"),
);
assert.equal(
  checkout?.uses,
  "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  "issue invalidation must execute only accepted workflow source",
);
assert.equal(checkout?.with?.["persist-credentials"], false);

const detect = step("Detect GovernanceGrant change");
assert.ok(detect);
assert.match(detect.run ?? "", /GITHUB_EVENT_PATH/);
assert.match(detect.run ?? "", /extractGovernanceGrant/);

const resolveAffected = step("Resolve affected Ready PR heads");
assert.ok(resolveAffected);
assert.match(resolveAffected.run ?? "", /issues\/\$\{ISSUE_NUMBER\}\/timeline/);
assert.match(resolveAffected.run ?? "", /cross-referenced/);
assert.match(resolveAffected.run ?? "", /pull_request/);
assert.match(resolveAffected.run ?? "", /draft/);
assert.match(resolveAffected.run ?? "", /base\.ref/);

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
assert.doesNotMatch(source, /workflow_dispatch:/);

console.log("P3 linked-issue authority freshness contract passed");
