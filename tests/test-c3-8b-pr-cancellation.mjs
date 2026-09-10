import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

import { collectObservatorySnapshot } from "../scripts/observatory/collect.mjs";
import { renderObservatory } from "../scripts/observatory/render.mjs";

const repoRoot = resolve(".");
const workflowSource = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const workflowDocument = parseDocument(workflowSource);
assert.equal(workflowDocument.errors.length, 0);
const workflow = workflowDocument.toJS();

assert.deepEqual(Object.keys(workflow.jobs ?? {}).sort(), ["smoke-pack", "validate"]);
assert.deepEqual(Object.keys(workflow.on ?? {}).sort(), ["pull_request", "push"]);
assert.deepEqual(workflow.on?.push?.branches, ["main"]);
assert.deepEqual(workflow.on?.pull_request?.branches, ["main"]);
assert.deepEqual(
  [...(workflow.on?.pull_request?.types ?? [])].sort(),
  ["opened", "ready_for_review", "reopened", "synchronize"],
);
assert.deepEqual(Object.keys(workflow.concurrency ?? {}).sort(), ["cancel-in-progress", "group"]);
assert.equal(
  workflow.concurrency?.group,
  "ci-${{ github.head_ref || github.run_id }}",
);
assert.equal(workflow.concurrency?.["cancel-in-progress"], true);

const acceptedSha = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: repoRoot, encoding: "utf8" },
).trim();
const snapshot = await collectObservatorySnapshot({
  repoRoot,
  acceptedSha,
  ci: {
    workflow: "CI",
    run_id: 123,
    run_url: "https://example.invalid/runs/123",
    conclusion: "success",
  },
  repository: "netkeep80/repo-guard",
  token: "test-token",
  fetchImpl: async () => ({
    status: 404,
    ok: false,
    async json() { return {}; },
  }),
});

assert.deepEqual(snapshot.ci.concurrency, workflow.concurrency);
const html = renderObservatory(snapshot);
assert.match(html, /Управление параллельностью/);
assert.ok(html.includes("ci-${{ github.head_ref || github.run_id }}"));
assert.ok(html.includes('&quot;cancel-in-progress&quot;: true'));
assert.ok(!html.includes("github.event.pull_request.number"));

console.log("C3.8b PR supersession concurrency contract passed");
