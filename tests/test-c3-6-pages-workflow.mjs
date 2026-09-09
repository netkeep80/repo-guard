import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

const workflowPath = resolve(".github/workflows/pages.yml");
const source = readFileSync(workflowPath, "utf8");
const document = parseDocument(source);
assert.deepEqual(document.errors, []);
const workflow = document.toJS();

assert.equal(workflow.name, "Policy Observatory Pages");
assert.deepEqual(workflow.on?.workflow_run?.workflows, ["CI"]);
assert.deepEqual(workflow.on?.workflow_run?.types, ["completed"]);
assert.deepEqual(workflow.on?.workflow_run?.branches, ["main"]);
assert.deepEqual(workflow.permissions, {});
assert.equal(workflow.concurrency?.group, "pages");
assert.equal(workflow.concurrency?.["cancel-in-progress"], true);

const build = workflow.jobs?.build;
const deploy = workflow.jobs?.deploy;
assert.ok(build);
assert.ok(deploy);
assert.match(String(build.if), /workflow_run\.conclusion.*success/);
assert.deepEqual(build.permissions, {
  contents: "read",
  pages: "read",
});
assert.deepEqual(deploy.permissions, {
  contents: "read",
  pages: "write",
  "id-token": "write",
});
assert.equal(deploy.needs, "build");
assert.equal(deploy.environment?.name, "github-pages");

const buildText = JSON.stringify(build);
const deployText = JSON.stringify(deploy);
assert.match(buildText, /actions\/checkout@v6/);
assert.match(buildText, /actions\/setup-node@v6/);
assert.match(buildText, /actions\/configure-pages@v5/);
assert.match(buildText, /actions\/upload-pages-artifact@v4/);
assert.match(deployText, /actions\/deploy-pages@v4/);

assert.match(buildText, /workflow_run\.head_sha/);
assert.match(buildText, /git rev-parse HEAD/);
assert.match(buildText, /refs\/heads\/main/);
assert.match(deployText, /refs\/heads\/main/);
assert.equal((source.match(/refs\/heads\/main/g) ?? []).length, 2);

assert.match(buildText, /npm ci --omit=dev/);
assert.match(buildText, /scripts\/observatory\/collect\.mjs/);
assert.match(buildText, /--accepted-sha/);
assert.match(buildText, /--ci-run-id/);
assert.match(buildText, /--ci-run-url/);
assert.match(buildText, /--ci-conclusion/);
assert.match(buildText, /--repository/);
assert.match(buildText, /observatory\.snapshot\.json/);
assert.match(buildText, /scripts\/observatory\/render\.mjs/);
assert.match(buildText, /--output _site/);

for (const forbidden of [
  /npm test/,
  /npm run check:dist/,
  /npm run validate/,
  /repo-guard check-pr/,
  /smoke-pack/,
]) {
  assert.doesNotMatch(source, forbidden);
}

assert.doesNotMatch(source, /pull-requests:\s*write/);
assert.doesNotMatch(source, /issues:\s*write/);
assert.doesNotMatch(source, /actions:\s*write/);
assert.doesNotMatch(source, /workflows:\s*write/);
assert.doesNotMatch(source, /contents:\s*write/);

console.log("C3.6 Pages workflow contract passed");
