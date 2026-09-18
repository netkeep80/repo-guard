import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";

import { verifyReleaseRef } from "../scripts/verify-release-ref.mjs";

const exactSha = "a".repeat(40);
const otherSha = "b".repeat(40);

function makePackageRoot(version = "2.3.4") {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-release-integrity-identity-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }), "utf8");
  return root;
}

function runAt(sha, calls = []) {
  return (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return sha;
    throw new Error(`unexpected process call: ${command} ${args.join(" ")}`);
  };
}

function networkMustNotRun(calls = []) {
  return async (url) => {
    calls.push(url);
    throw new Error(`network must not run before target identity is proved: ${url}`);
  };
}

describe("release integrity target identity", () => {
  it("rejects checkout T when automatic verification expects exact target S before release observation", async () => {
    const networkCalls = [];
    const result = await verifyReleaseRef({
      packageRoot: makePackageRoot(),
      repo: "netkeep80/repo-guard",
      tag: "v2.3.4",
      expectedSha: exactSha,
      run: runAt(otherSha),
      fetchImpl: networkMustNotRun(networkCalls),
    });

    assert.equal(result.ok, false);
    assert.equal(networkCalls.length, 0);
    assert.ok(result.checks.some((check) => (
      check.name === "release-target-sha"
      && check.status === "FAIL"
      && check.message.includes(exactSha)
      && check.message.includes(otherSha)
    )));
  });

  it("rejects malformed expected target before checkout or GitHub observation", async () => {
    const processCalls = [];
    const networkCalls = [];
    const result = await verifyReleaseRef({
      packageRoot: makePackageRoot(),
      repo: "netkeep80/repo-guard",
      tag: "v2.3.4",
      expectedSha: "main",
      run: runAt(exactSha, processCalls),
      fetchImpl: networkMustNotRun(networkCalls),
    });

    assert.equal(result.ok, false);
    assert.equal(processCalls.length, 0);
    assert.equal(networkCalls.length, 0);
    assert.ok(result.checks.some((check) => (
      check.name === "release-target-sha"
      && check.status === "FAIL"
      && /40-hex SHA/i.test(check.message)
    )));
  });

  it("exposes expected target identity through the CLI", () => {
    const result = spawnSync(process.execPath, [
      resolve("scripts/verify-release-ref.mjs"),
      "--tag",
      "v3.1.0",
      "--expected-sha",
      "main",
    ], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /release-target-sha/);
    assert.match(result.stdout, /40-hex SHA/i);
    assert.doesNotMatch(result.stderr, /Unknown option/);
  });
});

describe("atomic release target transport", () => {
  const source = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  const document = parseDocument(source);
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  const preflight = workflow.jobs?.preflight;
  const publish = workflow.jobs?.publish;

  it("records the proved target as a non-executable data artifact in read-only preflight", () => {
    assert.ok(preflight);
    assert.deepEqual(preflight.permissions, { actions: "read", contents: "read" });

    const proofIndex = preflight.steps.findIndex((step) => step.id === "proof");
    const recordIndex = preflight.steps.findIndex((step) => step.name === "Record exact release target identity");
    const uploadIndex = preflight.steps.findIndex((step) => step.name === "Upload exact release target identity");
    assert.ok(proofIndex >= 0);
    assert.ok(recordIndex > proofIndex);
    assert.ok(uploadIndex > recordIndex);

    const record = preflight.steps[recordIndex];
    assert.equal(typeof record.run, "string");
    const recordEnv = JSON.stringify(record.env ?? {});
    assert.match(recordEnv, /steps\.proof\.outputs\.sha/);
    assert.match(recordEnv, /steps\.proof\.outputs\.tag/);
    assert.match(recordEnv, /github\.run_id/);
    assert.match(recordEnv, /github\.run_attempt/);
    for (const variable of ["TARGET_SHA", "TAG", "SOURCE_RUN_ID", "SOURCE_RUN_ATTEMPT"]) {
      assert.match(record.run, new RegExp(`\\$${variable}\\b`));
    }
    assert.match(record.run, /schema_version/);
    assert.match(record.run, /target_sha/);
    assert.match(record.run, /source_run_id/);
    assert.match(record.run, /source_run_attempt/);
    assert.match(record.run, /release-target\.json/);
    assert.doesNotMatch(record.run, /\$\{\{/);
    assert.doesNotMatch(record.run, /client_payload/);

    const upload = preflight.steps[uploadIndex];
    assert.equal(upload.uses, "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    assert.equal(upload.with?.name, "release-target-${{ github.run_id }}-${{ github.run_attempt }}");
    assert.equal(upload.with?.path, "release-target.json");
    assert.equal(upload.with?.["if-no-files-found"], "error");
  });

  it("keeps the privileged publish job free of Actions and repository execution", () => {
    assert.ok(publish);
    assert.deepEqual(publish.permissions, { contents: "write" });
    for (const step of publish.steps ?? []) assert.equal(step.uses, undefined);
    const text = (publish.steps ?? []).map((step) => step.run ?? "").join("\n");
    assert.doesNotMatch(text, /\bnpm\b/);
    assert.doesNotMatch(text, /\bnode\b/);
    assert.doesNotMatch(text, /scripts\//);
  });
});

describe("automatic release integrity workflow", () => {
  const source = readFileSync(resolve(".github/workflows/release-integrity.yml"), "utf8");
  const document = parseDocument(source);
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();

  it("uses Atomic release completion as the automatic transport and keeps manual verification", () => {
    assert.deepEqual(workflow.on?.workflow_run?.workflows, ["Atomic release"]);
    assert.deepEqual(workflow.on?.workflow_run?.types, ["completed"]);
    assert.ok(workflow.on?.workflow_dispatch?.inputs?.tag);
    assert.equal(workflow.on?.release, undefined);
    assert.deepEqual(workflow.permissions, {});
  });

  it("establishes and validates target identity before any target checkout", () => {
    const resolveTarget = workflow.jobs?.["resolve-automatic-target"];
    assert.ok(resolveTarget);
    assert.deepEqual(resolveTarget.permissions, { actions: "read", contents: "read" });
    const text = JSON.stringify(resolveTarget);
    assert.doesNotMatch(text, /actions\/checkout/);
    assert.doesNotMatch(text, /actions\/setup-node/);
    assert.doesNotMatch(text, /npm\s/);
    assert.doesNotMatch(text, /scripts\//);
    assert.match(text, /workflow_run\.path/);
    assert.match(text, /workflow_run\.event/);
    assert.match(text, /workflow_run\.id/);
    assert.match(text, /workflow_run\.run_attempt/);
    assert.match(text, /\.github\/workflows\/release\.yml/);
    assert.match(text, /repository_dispatch/);
    assert.match(text, /actions\/download-artifact@v5/);
    assert.match(text, /release-target-/);
    assert.match(text, /release-target\.json/);
    assert.match(text, /schema_version/);
    assert.match(text, /target_sha/);
    assert.match(text, /source_run_id/);
    assert.match(text, /source_run_attempt/);
  });

  it("checks out only the established target and binds verifier CLI to target SHA and tag", () => {
    const verify = workflow.jobs?.["verify-automatic"];
    assert.ok(verify);
    assert.equal(verify.needs, "resolve-automatic-target");
    assert.deepEqual(verify.permissions, { contents: "read" });
    const text = JSON.stringify(verify);
    assert.match(text, /needs\.resolve-automatic-target\.outputs\.target_sha/);
    assert.match(text, /needs\.resolve-automatic-target\.outputs\.tag/);
    assert.match(text, /actions\\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
    assert.match(text, /persist-credentials/);
    assert.match(text, /--expected-sha/);
    assert.match(text, /--tag/);
  });

  it("records identity-bound verifier evidence even when verification fails", () => {
    const record = workflow.jobs?.["record-automatic-evidence"];
    assert.ok(record);
    assert.deepEqual(record.needs, ["resolve-automatic-target", "verify-automatic"]);
    assert.match(String(record.if), /always\(\)/);
    assert.match(String(record.if), /resolve-automatic-target.*success/);
    assert.doesNotMatch(JSON.stringify(record), /actions\/checkout/);

    const text = JSON.stringify(record);
    assert.match(text, /needs\.verify-automatic\.result/);
    assert.match(text, /target_sha/);
    assert.match(text, /source_release_run_id/);
    assert.match(text, /source_release_run_attempt/);
    assert.match(text, /github\.run_id/);
    assert.match(text, /github\.run_attempt/);
    assert.match(text, /run_url/);
    assert.match(text, /actions\/upload-artifact@v4/);
    assert.match(text, /release-integrity-/);
  });

  it("keeps manual tag verification separate from automatic accepted-target evidence", () => {
    const manual = workflow.jobs?.["verify-manual"];
    assert.ok(manual);
    assert.match(String(manual.if), /workflow_dispatch/);
    const text = JSON.stringify(manual);
    assert.match(text, /inputs\.tag/);
    assert.match(text, /actions\\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
    assert.match(text, /--tag/);
    assert.doesNotMatch(text, /--expected-sha/);
  });
});

console.log("Release integrity target identity contract passed");
