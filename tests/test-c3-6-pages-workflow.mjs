import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseDocument } from "yaml";

const workflowPath = resolve(".github/workflows/pages.yml");
const source = readFileSync(workflowPath, "utf8");
const document = parseDocument(source);
assert.deepEqual(document.errors, []);
const workflow = document.toJS();

assert.equal(workflow.name, "Policy Observatory Pages");
assert.deepEqual(
  [...(workflow.on?.workflow_run?.workflows ?? [])].sort(),
  ["CI", "Release integrity"],
);
assert.deepEqual(workflow.on?.workflow_run?.types, ["completed"]);
assert.equal(workflow.on?.workflow_run?.branches, undefined, "Release integrity must not inherit CI branch filtering");
assert.deepEqual(workflow.permissions, {});
assert.equal(workflow.concurrency, undefined, "a late stale S must not cancel a newer T run globally");

const build = workflow.jobs?.build;
const deploy = workflow.jobs?.deploy;
assert.ok(build);
assert.ok(deploy);
assert.deepEqual(build.permissions, {
  actions: "read",
  contents: "read",
  pages: "read",
});
assert.deepEqual(deploy.permissions, {
  contents: "read",
  pages: "write",
  "id-token": "write",
});
assert.equal(deploy.needs, "build");
assert.match(String(deploy.if), /needs\.build\.outputs\.deploy.*true/);
assert.equal(deploy.environment?.name, "github-pages");
assert.deepEqual(deploy.concurrency, {
  group: "pages-${{ needs.build.outputs.target_sha }}",
  "cancel-in-progress": false,
});
assert.match(String(build.outputs?.target_sha), /steps\.freshness\.outputs\.target_sha/);
assert.match(String(build.outputs?.deploy), /steps\.freshness\.outputs\.deploy/);

const steps = build.steps ?? [];
const stepIndex = (name) => steps.findIndex((step) => step.name === name);
const originIndex = stepIndex("Verify refresh workflow origin");
const downloadIndex = stepIndex("Download exact release integrity evidence");
const targetIndex = stepIndex("Resolve accepted target before checkout");
const checkoutIndex = stepIndex("Checkout exact accepted target");
const setupIndex = stepIndex("Set up Node.js");
const installIndex = stepIndex("Install runtime dependencies");
const collectIndex = stepIndex("Collect Observatory snapshot");
const renderIndex = stepIndex("Render Observatory site");
const freshnessIndex = stepIndex("Verify current main before upload");
const uploadIndex = stepIndex("Upload Pages artifact");
for (const index of [
  originIndex,
  downloadIndex,
  targetIndex,
  checkoutIndex,
  setupIndex,
  installIndex,
  collectIndex,
  renderIndex,
  freshnessIndex,
  uploadIndex,
]) {
  assert.ok(index >= 0, "required Pages build step is missing");
}
assert.ok(originIndex < downloadIndex);
assert.ok(downloadIndex < targetIndex);
assert.ok(targetIndex < checkoutIndex, "trusted identity must be resolved before checkout");
assert.ok(checkoutIndex < setupIndex && setupIndex < installIndex);
assert.ok(installIndex < collectIndex && collectIndex < renderIndex);
assert.ok(renderIndex < freshnessIndex && freshnessIndex < uploadIndex);

const origin = steps[originIndex];
const download = steps[downloadIndex];
const target = steps[targetIndex];
const checkout = steps[checkoutIndex];
const collect = steps[collectIndex];
const freshness = steps[freshnessIndex];
const upload = steps[uploadIndex];
const originRun = String(origin.run ?? "");
const targetRun = String(target.run ?? "");
const collectRun = String(collect.run ?? "");
const freshnessRun = String(freshness.run ?? "");

assert.match(originRun, /SOURCE_REPOSITORY/);
assert.match(originRun, /SOURCE_WORKFLOW_PATH/);
assert.match(originRun, /SOURCE_EVENT/);
assert.match(originRun, /\.github\/workflows\/ci\.yml/);
assert.match(originRun, /\.github\/workflows\/release-integrity\.yml/);
assert.match(originRun, /workflow_dispatch/);
assert.match(String(download.if), /steps\.origin\.outputs\.kind.*release_integrity/);
assert.equal(download["continue-on-error"], true, "pre-identity verifier failures must become no-deploy, not false attribution");
assert.match(String(download.uses), /actions\/download-artifact@v5/);
assert.match(String(download.with?.["run-id"]), /workflow_run\.id/);
assert.match(String(download.with?.pattern), /release-integrity/);
assert.equal(download.with?.["merge-multiple"], true);

assert.match(targetRun, /RI_FILE/);
assert.match(targetRun, /candidate=false/);
assert.match(targetRun, /schema_version/);
assert.match(targetRun, /atomic_release/);
assert.match(targetRun, /target_sha/);
assert.match(targetRun, /run_id/);
assert.match(targetRun, /run_attempt/);
assert.match(targetRun, /SOURCE_RUN_ID/);
assert.match(targetRun, /SOURCE_RUN_ATTEMPT/);
assert.match(targetRun, /success\|failure\|cancelled\|skipped/);
assert.match(targetRun, /gh api/);
assert.match(targetRun, /actions\/workflows\/ci\.yml\/runs/);
assert.match(targetRun, /\.github\/workflows\/ci\.yml/);
assert.match(targetRun, /head_sha/);
assert.match(targetRun, /head_branch/);
assert.match(targetRun, /conclusion/);
assert.match(targetRun, /refs\/heads\/main/);
assert.match(targetRun, /candidate=true/);

assert.match(String(checkout.if), /steps\.target\.outputs\.candidate.*true/);
assert.match(String(checkout.with?.ref), /steps\.target\.outputs\.target_sha/);
assert.equal(checkout.with?.["persist-credentials"], false);
assert.match(collectRun, /scripts\/observatory\/collect\.mjs/);
for (const argument of [
  "--accepted-sha",
  "--observed-at",
  "--ci-workflow-path",
  "--ci-event",
  "--ci-branch",
  "--ci-head-sha",
  "--ci-run-id",
  "--ci-run-url",
  "--ci-conclusion",
  "--repository",
  "--release-integrity-file",
  "--output",
]) {
  assert.ok(collectRun.includes(argument), `collector argument is missing: ${argument}`);
}
assert.match(String(collect.if), /steps\.target\.outputs\.candidate.*true/);
assert.match(String(freshness.if), /steps\.target\.outputs\.candidate.*true/);
assert.match(freshnessRun, /git ls-remote/);
assert.match(freshnessRun, /refs\/heads\/main/);
assert.match(freshnessRun, /deploy=false/);
assert.match(freshnessRun, /deploy=true/);
assert.match(String(upload.if), /steps\.freshness\.outputs\.deploy.*true/);
assert.match(String(upload.uses), /actions\/upload-pages-artifact@v4/);

const deploySteps = deploy.steps ?? [];
const deployFreshness = deploySteps.find((step) => step.name === "Verify current main before deploy");
const deployAction = deploySteps.find((step) => step.name === "Deploy Pages");
assert.ok(deployFreshness);
assert.ok(deployAction);
assert.match(String(deployFreshness.run), /git ls-remote/);
assert.match(String(deployFreshness.run), /deploy=false/);
assert.match(String(deployFreshness.run), /deploy=true/);
assert.match(String(deployAction.if), /steps\.freshness\.outputs\.deploy.*true/);
assert.match(String(deployAction.uses), /actions\/deploy-pages@v4/);

function executeFreshness(runScript, { mainSha, targetSha }) {
  const tempRoot = mkdtempSync(join(tmpdir(), "repo-guard-pages-freshness-"));
  try {
    const fakeGit = join(tempRoot, "git");
    const output = join(tempRoot, "output.txt");
    writeFileSync(fakeGit, `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$1" == "ls-remote" ]]; then\n  printf '%s\\trefs/heads/main\\n' "${mainSha}"\n  exit 0\nfi\nexit 99\n`, { mode: 0o755 });
    writeFileSync(output, "", "utf8");
    execFileSync("bash", ["-c", runScript], {
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        ACCEPTED_SHA: targetSha,
        REPOSITORY: "netkeep80/repo-guard",
      },
      stdio: "pipe",
    });
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=", 2)),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const staleSha = "a".repeat(40);
const newerSha = "b".repeat(40);
const lateStale = executeFreshness(String(deployFreshness.run), {
  mainSha: newerSha,
  targetSha: staleSha,
});
const currentNewer = executeFreshness(String(deployFreshness.run), {
  mainSha: newerSha,
  targetSha: newerSha,
});
assert.equal(lateStale.deploy, "false", "late stale S must become a normal no-deploy");
assert.equal(currentNewer.deploy, "true", "newer accepted T remains deployable after late stale S");

const buildText = JSON.stringify(build);
const deployText = JSON.stringify(deploy);
assert.match(buildText, /actions\/checkout@v6/);
assert.match(buildText, /actions\/setup-node@v6/);
assert.match(buildText, /actions\/configure-pages@v5/);
assert.match(deployText, /actions\/deploy-pages@v4/);
assert.match(buildText, /npm ci --omit=dev/);
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

console.log("C3.7 trusted dual-source Pages refresh contract passed");
