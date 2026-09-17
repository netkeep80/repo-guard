import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { observeImmutable } from "./support/immutable-observation.mjs";

const root = resolve(".");
const workflowSource = readFileSync(
  resolve(root, ".github/workflows/ci.yml"),
  "utf8",
);
const workflowDocument = parseDocument(workflowSource);
assert.equal(workflowDocument.errors.length, 0);
const workflow = workflowDocument.toJS();

assert.deepEqual(Object.keys(workflow.jobs ?? {}).sort(), ["smoke-pack", "validate"]);
const validate = workflow.jobs?.validate;
const smokePack = workflow.jobs?.["smoke-pack"];
assert.ok(validate);
assert.ok(smokePack);

const explicitDistIndexes = validate.steps
  .map((step, index) => ({ step, index }))
  .filter(({ step }) => (
    typeof step.run === "string"
    && /\bnpm\s+run\s+check:dist\b/.test(step.run)
  ));
assert.equal(explicitDistIndexes.length, 1);

const testIndex = validate.steps.findIndex(
  (step) => step.name === "Run discovered test suite",
);
assert.ok(testIndex > explicitDistIndexes[0].index);
assert.equal(validate.steps[testIndex].run, "node tests/run.mjs");
assert.doesNotMatch(validate.steps[testIndex].run, /\bnpm\s+test\b/);

const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
assert.equal(packageJson.scripts.pretest, "npm run check:dist");
assert.equal(packageJson.scripts.test, "node tests/run.mjs");
assert.equal(packageJson.scripts.prepack, "npm run build");

const npmCiSteps = (job) => (job.steps ?? []).filter((step) => step.run === "npm ci");
assert.equal(npmCiSteps(validate).length, 1);
assert.equal(npmCiSteps(smokePack).length, 0);

const smokeStep = smokePack.steps.find((step) => step.name === "Smoke-test packaged artifact");
assert.ok(smokeStep);
assert.match(smokeStep.run, /npm pack --ignore-scripts/);
assert.match(smokeStep.run, /npm install --prefix/);
assert.match(smokeStep.run, /node_modules\/\.bin\/repo-guard/);

const distStep = validate.steps.find((step) => step.name === "Verify generated dist freshness");
assert.ok(distStep);
assert.equal(distStep.run, "npm run check:dist");

const prPolicyStep = validate.steps.find(
  (step) => step.name === "Run PR policy check",
);
assert.ok(prPolicyStep);
assert.equal(prPolicyStep.uses, undefined);
assert.equal(prPolicyStep.run, "node dist/repo-guard.mjs --enforcement blocking check-pr --format json");
assert.equal(prPolicyStep.env?.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");

const checkoutStep = validate.steps.find(
  (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
);
assert.ok(checkoutStep);
assert.equal(checkoutStep.with?.["fetch-depth"], 1);
assert.doesNotMatch(workflowSource, /fetch-depth:\s*0/);

const evidenceStep = validate.steps.find((step) => step.name === "Acquire minimal Git evidence");
assert.ok(evidenceStep);
assert.equal(typeof evidenceStep.run, "string");
assert.match(evidenceStep.run, /github\.event_name/);
assert.match(evidenceStep.run, /--unshallow/);
assert.match(evidenceStep.run, /--no-tags/);
assert.match(evidenceStep.run, /refs\/heads\/\$\{\{ github\.base_ref \}\}:refs\/remotes\/origin\/\$\{\{ github\.base_ref \}\}/);
assert.match(evidenceStep.run, /refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge:refs\/remotes\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge/);
assert.match(evidenceStep.run, /refs\/heads\/\$\{\{ github\.ref_name \}\}:refs\/remotes\/origin\/\$\{\{ github\.ref_name \}\}/);
assert.doesNotMatch(evidenceStep.run, /refs\/heads\/\*/);
assert.doesNotMatch(evidenceStep.run, /92432809fcddc290080beb51ba151e13a5761869/);

const evidenceIndex = validate.steps.indexOf(evidenceStep);
for (const name of [
  "Report architecture compression metrics",
  "Run doctor diagnostics on self",
  "Run discovered test suite",
  "Run PR policy check",
]) {
  const index = validate.steps.findIndex((step) => step.name === name);
  assert.ok(index > evidenceIndex, `${name} must run after minimal Git evidence acquisition`);
}

const metrics = JSON.parse(observeImmutable(
  process.execPath,
  ["scripts/compression-metrics.mjs", "--ref", "HEAD"],
  { cwd: root },
));
assert.equal(metrics.ci.test_runs, 1);
assert.equal(metrics.ci.explicit_check_dist_runs, 1);
assert.equal(metrics.ci.effective_check_dist_runs, 1);
assert.equal(metrics.ci.npm_ci_runs, 1);
assert.equal(metrics.ci.full_history_checkouts, 0);

const releaseWorkflowSource = readFileSync(
  resolve(root, ".github/workflows/release.yml"),
  "utf8",
);
const releaseWorkflowDocument = parseDocument(releaseWorkflowSource);
assert.equal(releaseWorkflowDocument.errors.length, 0);
const releaseWorkflow = releaseWorkflowDocument.toJS();

assert.deepEqual(releaseWorkflow.permissions ?? {}, {});
assert.deepEqual(
  releaseWorkflow.on?.repository_dispatch?.types,
  ["release"],
  "release transaction must be dispatched through the default-branch repository_dispatch workflow",
);
assert.deepEqual(Object.keys(releaseWorkflow.jobs ?? {}).sort(), ["preflight", "publish"]);

const releasePreflight = releaseWorkflow.jobs.preflight;
const releasePublish = releaseWorkflow.jobs.publish;
assert.deepEqual(releasePreflight.permissions, {
  actions: "read",
  contents: "read",
});
assert.deepEqual(releasePublish.permissions, { contents: "write" });
assert.equal(releasePublish.needs, "preflight");

const releaseCheckout = releasePreflight.steps.find(
  (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
);
assert.ok(releaseCheckout);
assert.equal(releaseCheckout.with?.ref, "${{ github.event.client_payload.sha }}");
assert.equal(releaseCheckout.with?.["fetch-depth"], 1);
assert.equal(releaseCheckout.with?.["persist-credentials"], false);
assert.equal(npmCiSteps(releasePreflight).length, 1);

const proofStep = releasePreflight.steps.find((step) => step.id === "proof");
assert.ok(proofStep);
assert.match(proofStep.run, /node scripts\/release-preflight\.mjs/);
assert.match(proofStep.run, /GITHUB_OUTPUT/);
for (const key of ["sha", "version", "tag"]) {
  assert.equal(releasePreflight.outputs?.[key], `\${{ steps.proof.outputs.${key} }}`);
}

for (const step of releasePublish.steps ?? []) {
  assert.equal(step.uses, undefined, "publish must not execute any repository or third-party Action code");
}
const publishSource = (releasePublish.steps ?? [])
  .map((step) => step.run ?? "")
  .join("\n");
assert.match(publishSource, /\bgh\s+api\b/);
assert.doesNotMatch(publishSource, /\bnpm\b/);
assert.doesNotMatch(publishSource, /\bnode\b/);
assert.doesNotMatch(publishSource, /(?:^|[\s;&|])git\s+/m);
assert.doesNotMatch(publishSource, /scripts\//);
assert.doesNotMatch(publishSource, /(?:^|[\s;&|])\.\//m);
assert.doesNotMatch(publishSource, /github\.event\.client_payload/);
assert.match(JSON.stringify(releasePublish.env ?? {}), /needs\.preflight\.outputs\.sha/);
assert.match(JSON.stringify(releasePublish.env ?? {}), /needs\.preflight\.outputs\.version/);
assert.match(JSON.stringify(releasePublish.env ?? {}), /needs\.preflight\.outputs\.tag/);
assert.match(publishSource, /refs\/tags/);
assert.match(publishSource, /releases/);
assert.match(
  publishSource,
  /git\/ref\/tags\/\$\{TAG\}/,
  "publish must observe the exact refs/tags namespace, not an ambiguous commit-ish name",
);
assert.doesNotMatch(
  publishSource,
  /commits\/\$\{TAG\}/,
  "publish must not resolve tag identity through an ambiguous branch-or-tag commit endpoint",
);

const acceptedSha = "a".repeat(40);
const rejectedSha = "b".repeat(40);
const annotatedObjectSha = "c".repeat(40);

function field(args, name) {
  const prefix = `${name}=`;
  const entry = args.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

function runPublish(initialState) {
  const sandbox = mkdtempSync(join(tmpdir(), "repo-guard-release-publish-"));
  const statePath = join(sandbox, "state.json");
  const ghPath = join(sandbox, "gh");
  writeFileSync(statePath, JSON.stringify({ calls: [], ...initialState }), "utf8");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.GH_FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(90);
let method = "GET";
let endpoint = null;
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === "--method") {
    method = args[i + 1];
    i += 1;
  } else if (!args[i].startsWith("-") && endpoint === null) {
    endpoint = args[i];
  }
}
state.calls.push({ method, endpoint, args });
const save = () => writeFileSync(statePath, JSON.stringify(state), "utf8");
const field = (name) => {
  const prefix = name + "=";
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
};
const fail = () => { save(); process.exit(1); };

if (method === "GET" && endpoint?.includes("/git/ref/tags/")) {
  if (!state.tag) fail();
  process.stdout.write(JSON.stringify({ object: state.tag }));
  save();
  process.exit(0);
}
if (method === "GET" && endpoint?.includes("/git/tags/")) {
  const objectSha = endpoint.split("/").at(-1);
  const object = state.tagObjects?.[objectSha];
  if (!object) fail();
  process.stdout.write(JSON.stringify({ object }));
  save();
  process.exit(0);
}
if (method === "POST" && endpoint?.endsWith("/git/refs")) {
  if (state.tag) fail();
  const sha = field("sha");
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail();
  state.tag = { type: "commit", sha };
  save();
  process.exit(0);
}
if (method === "GET" && endpoint?.includes("/releases/tags/")) {
  if (!state.release) fail();
  if (args.includes("--jq")) {
    process.stdout.write(state.release.tag_name + "\\t" + String(state.release.draft) + "\\t" + String(state.release.prerelease));
  } else {
    process.stdout.write(JSON.stringify(state.release));
  }
  save();
  process.exit(0);
}
if (method === "POST" && endpoint?.endsWith("/releases")) {
  if (state.release) fail();
  state.release = {
    tag_name: field("tag_name"),
    draft: false,
    prerelease: false,
  };
  if (state.mutateTagAfterRelease) {
    state.tag = { type: "commit", sha: state.mutateTagAfterRelease };
  }
  save();
  process.exit(0);
}
fail();
`,
    "utf8",
  );
  chmodSync(ghPath, 0o755);

  const result = spawnSync("bash", ["-c", publishSource], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sandbox}:${process.env.PATH}`,
      GH_FAKE_STATE: statePath,
      GH_TOKEN: "test-token",
      REPOSITORY: "netkeep80/repo-guard",
      TARGET_SHA: acceptedSha,
      VERSION: "2.3.4",
      TAG: "v2.3.4",
    },
  });
  return {
    result,
    state: JSON.parse(readFileSync(statePath, "utf8")),
  };
}

function assertSuccess(execution, label) {
  assert.equal(
    execution.result.status,
    0,
    `${label}: ${execution.result.stderr || execution.result.stdout}`,
  );
}

{
  const execution = runPublish({ tag: null, release: null });
  assertSuccess(execution, "absent tag/release publication");
  assert.deepEqual(execution.state.tag, { type: "commit", sha: acceptedSha });
  assert.deepEqual(execution.state.release, {
    tag_name: "v2.3.4",
    draft: false,
    prerelease: false,
  });
  assert.ok(execution.state.calls.some(({ method, endpoint }) => method === "POST" && endpoint.endsWith("/git/refs")));
  assert.ok(execution.state.calls.some(({ method, endpoint }) => method === "POST" && endpoint.endsWith("/releases")));
}

{
  const execution = runPublish({
    tag: { type: "commit", sha: acceptedSha },
    release: { tag_name: "v2.3.4", draft: false, prerelease: false },
  });
  assertSuccess(execution, "idempotent existing publication");
  assert.equal(execution.state.calls.some(({ method }) => method === "POST"), false);
}

{
  const execution = runPublish({
    tag: { type: "tag", sha: annotatedObjectSha },
    tagObjects: {
      [annotatedObjectSha]: { type: "commit", sha: acceptedSha },
    },
    release: { tag_name: "v2.3.4", draft: false, prerelease: false },
  });
  assertSuccess(execution, "annotated tag publication");
  assert.equal(execution.state.calls.some(({ method }) => method === "POST"), false);
}

{
  const execution = runPublish({
    tag: { type: "commit", sha: rejectedSha },
    release: null,
  });
  assert.notEqual(execution.result.status, 0);
  assert.equal(execution.state.release, null);
  assert.equal(
    execution.state.calls.some(({ method, endpoint }) => method === "POST" && endpoint.endsWith("/releases")),
    false,
  );
}

{
  const execution = runPublish({
    tag: { type: "commit", sha: acceptedSha },
    release: { tag_name: "v2.3.4", draft: true, prerelease: false },
  });
  assert.notEqual(execution.result.status, 0);
  assert.equal(execution.state.release.draft, true);
  assert.equal(execution.state.calls.some(({ method }) => method === "POST"), false);
}

{
  const execution = runPublish({
    tag: null,
    release: null,
    mutateTagAfterRelease: rejectedSha,
  });
  assert.notEqual(execution.result.status, 0);
  assert.equal(execution.state.release.tag_name, "v2.3.4");
  assert.deepEqual(execution.state.tag, { type: "commit", sha: rejectedSha });
}

console.log("Current CI and atomic release workflow contracts passed");
