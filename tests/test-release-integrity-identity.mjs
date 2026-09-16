import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

console.log("Release integrity target identity contract passed");
