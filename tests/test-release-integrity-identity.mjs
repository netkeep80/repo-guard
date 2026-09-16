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
    assert.equal(upload.uses, "actions/upload-artifact@v4");
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

console.log("Release integrity target identity contract passed");
