import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  preflightRelease,
  validateEligibilityEvidence,
  verifyPublishedReleaseEvidence,
} from "../scripts/release-preflight.mjs";

const repo = "netkeep80/repo-guard";
const exactSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const evaluatorSha = "e".repeat(40);
const verifierSha = "f".repeat(40);
const ciWorkflowId = 777;
const sourceRunId = 501;
const sourceRunAttempt = 1;
const ciRunId = 101;
const ciRunAttempt = 1;

const response = (status, body = {}) => ({
  status,
  async json() { return body; },
  async text() { return JSON.stringify(body); },
});

function fakeFetch(entries, calls = []) {
  return async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const match = entries.find(([suffix]) => parsed.pathname.endsWith(suffix));
    return match ? response(match[1], match[2]) : response(404, { message: "not found" });
  };
}

const workflowRun = (overrides = {}) => ({
  id: ciRunId,
  run_attempt: ciRunAttempt,
  workflow_id: ciWorkflowId,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: exactSha,
  status: "completed",
  conclusion: "success",
  html_url: "https://example.invalid/run/101",
  ...overrides,
});

const publishedRelease = (tag = "v5.0.0", overrides = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://example.invalid/releases/${tag}`,
  ...overrides,
});

function preflightRoutes({
  mainSha = exactSha,
  workflow = { id: ciWorkflowId, path: ".github/workflows/ci.yml", state: "active" },
  ciRuns = [workflowRun()],
  version = "5.0.0",
  tagStatus = 404,
  tagSha = exactSha,
  releaseStatus = 404,
  release = {},
} = {}) {
  const tag = `v${version}`;
  return [
    ["/git/ref/heads/main", 200, { object: { type: "commit", sha: mainSha } }],
    ["/actions/workflows/ci.yml", 200, workflow],
    [`/actions/workflows/${ciWorkflowId}/runs`, 200, { workflow_runs: ciRuns }],
    [`/git/ref/tags/${tag}`, tagStatus, { object: { type: "commit", sha: tagSha } }],
    [`/releases/tags/${tag}`, releaseStatus, release],
  ];
}

function evaluatorRun({
  checkout = evaluatorSha,
  version = "5.0.0",
  lockVersion = version,
  calls = [],
} = {}) {
  return (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    if (command !== "git") throw new Error(`unexpected executable: ${command}`);
    if (args[0] === "rev-parse" && args[1] === "HEAD") return checkout;
    if (args[0] === "cat-file" && args[1] === "-e") return "";
    if (args[0] === "show" && args[1].endsWith(":package.json")) {
      return JSON.stringify({ name: "repo-guard", version });
    }
    if (args[0] === "show" && args[1].endsWith(":package-lock.json")) {
      return JSON.stringify({
        name: "repo-guard",
        version: lockVersion,
        lockfileVersion: 3,
        packages: { "": { name: "repo-guard", version: lockVersion } },
      });
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

async function runPreflight(overrides = {}) {
  const version = overrides.version ?? "5.0.0";
  return preflightRelease({
    repoRoot: "/trusted-evaluator",
    repo: overrides.repo ?? repo,
    sha: overrides.sha ?? exactSha,
    evaluatorSha: overrides.evaluatorSha ?? evaluatorSha,
    actor: overrides.actor ?? "netkeep80",
    repositoryOwner: overrides.repositoryOwner ?? "netkeep80",
    sourceRunId: overrides.sourceRunId ?? sourceRunId,
    sourceRunAttempt: overrides.sourceRunAttempt ?? sourceRunAttempt,
    fetchImpl: fakeFetch(overrides.routes ?? preflightRoutes({ version }), overrides.fetchCalls),
    run: overrides.run ?? evaluatorRun({
      checkout: overrides.checkout ?? evaluatorSha,
      version,
      lockVersion: overrides.lockVersion ?? version,
      calls: overrides.runCalls,
    }),
  });
}

const exactEvidence = (overrides = {}) => ({
  schema_version: 2,
  eligibility: "eligible",
  repository: repo,
  target_sha: exactSha,
  version: "5.0.0",
  tag: "v5.0.0",
  evaluator_sha: evaluatorSha,
  ci_run_id: ciRunId,
  ci_run_attempt: ciRunAttempt,
  source_release_run_id: sourceRunId,
  source_release_run_attempt: sourceRunAttempt,
  ...overrides,
});

describe("#835 independently trusted release eligibility", () => {
  it("F4 authorized dispatcher is accepted only with all eligibility gates", async () => {
    const result = await runPreflight();
    assert.equal(result.eligibility, "eligible");
    assert.equal(result.repository, repo);
  });

  it("F5 unauthorized dispatcher is rejected", async () => {
    await assert.rejects(runPreflight({ actor: "mallory" }), /unauthorized release dispatcher/i);
  });

  it("F6 malformed target SHA is rejected before target observation", async () => {
    await assert.rejects(runPreflight({ sha: "main" }), /40-hex SHA/i);
  });

  it("F7 authorized non-main target is rejected", async () => {
    await assert.rejects(
      runPreflight({ routes: preflightRoutes({ mainSha: otherSha }) }),
      /main does not match requested SHA/i,
    );
  });

  it("F8 stale former-main SHA is rejected", async () => {
    await assert.rejects(
      runPreflight({
        sha: otherSha,
        routes: preflightRoutes({ mainSha: exactSha }),
      }),
      /main does not match requested SHA/i,
    );
  });

  it("F9 missing exact post-merge CI is rejected", async () => {
    await assert.rejects(
      runPreflight({ routes: preflightRoutes({ ciRuns: [] }) }),
      /post-merge CI.*missing/i,
    );
  });

  it("F10 newer failing CI cannot be hidden by an older success", async () => {
    const older = workflowRun({ id: 100, conclusion: "success" });
    const newer = workflowRun({ id: 101, conclusion: "failure" });
    await assert.rejects(
      runPreflight({ routes: preflightRoutes({ ciRuns: [older, newer] }) }),
      /authoritative post-merge CI.*not successful/i,
    );
  });

  it("F11 newer cancelled CI cannot be hidden by an older success", async () => {
    const older = workflowRun({ id: 100, conclusion: "success" });
    const newer = workflowRun({ id: 101, conclusion: "cancelled" });
    await assert.rejects(
      runPreflight({ routes: preflightRoutes({ ciRuns: [older, newer] }) }),
      /authoritative post-merge CI.*not successful/i,
    );
  });

  it("F12 pending CI cannot be hidden by an older success", async () => {
    const older = workflowRun({ id: 100, conclusion: "success" });
    const newer = workflowRun({ id: 101, status: "in_progress", conclusion: null });
    await assert.rejects(
      runPreflight({ routes: preflightRoutes({ ciRuns: [older, newer] }) }),
      /authoritative post-merge CI.*not successful/i,
    );
  });

  it("F13 wrong-SHA CI is rejected", async () => {
    await assert.rejects(
      runPreflight({ routes: preflightRoutes({ ciRuns: [workflowRun({ head_sha: otherSha })] }) }),
      /post-merge CI.*missing/i,
    );
  });

  it("F14 workflow name alone cannot substitute for the exact CI workflow", async () => {
    await assert.rejects(
      runPreflight({
        routes: preflightRoutes({
          ciRuns: [workflowRun({ name: "CI", path: ".github/workflows/forged.yml" })],
        }),
      }),
      /post-merge CI.*missing/i,
    );
  });

  it("F15 wrong-event CI is rejected", async () => {
    await assert.rejects(
      runPreflight({ routes: preflightRoutes({ ciRuns: [workflowRun({ event: "pull_request" })] }) }),
      /post-merge CI.*missing/i,
    );
  });

  it("F16 package version is read from target data and bound to the tag", async () => {
    const result = await runPreflight({ version: "5.0.0" });
    assert.equal(result.version, "5.0.0");
    assert.equal(result.tag, "v5.0.0");
  });

  it("F17 package-lock version drift is rejected", async () => {
    await assert.rejects(
      runPreflight({ lockVersion: "5.0.1" }),
      /package-lock version mismatch/i,
    );
  });

  it("F18 unstable or invalid SemVer is rejected", async () => {
    await assert.rejects(
      runPreflight({
        version: "5.0.0-beta.1",
        routes: preflightRoutes({ version: "5.0.0-beta.1" }),
      }),
      /stable semantic version/i,
    );
  });

  it("F19 existing tag at another SHA is rejected", async () => {
    await assert.rejects(
      runPreflight({
        routes: preflightRoutes({ tagStatus: 200, tagSha: otherSha }),
      }),
      /tag.*different SHA/i,
    );
  });

  it("F20 incompatible existing Release is rejected", async () => {
    await assert.rejects(
      runPreflight({
        routes: preflightRoutes({
          tagStatus: 200,
          releaseStatus: 200,
          release: publishedRelease("v5.0.0", { draft: true }),
        }),
      }),
      /Release.*not published/i,
    );
  });

  it("F21 evaluator substitution is rejected", async () => {
    await assert.rejects(
      runPreflight({ checkout: verifierSha }),
      /trusted evaluator checkout.*does not match/i,
    );
    assert.throws(
      () => validateEligibilityEvidence(exactEvidence({ evaluator_sha: verifierSha }), { evaluatorSha }),
      /evaluator_sha mismatch/i,
    );
  });

  it("F22 stale target evidence is rejected", () => {
    assert.throws(
      () => validateEligibilityEvidence(exactEvidence(), { targetSha: otherSha }),
      /target_sha mismatch/i,
    );
  });

  it("F23 stale source run evidence is rejected", () => {
    assert.throws(
      () => validateEligibilityEvidence(exactEvidence(), { sourceRunId: sourceRunId + 1 }),
      /source_release_run_id mismatch/i,
    );
  });

  it("F24 stale source run attempt evidence is rejected", () => {
    assert.throws(
      () => validateEligibilityEvidence(exactEvidence(), { sourceRunAttempt: 2 }),
      /source_release_run_attempt mismatch/i,
    );
  });

  it("F25 repository substitution is rejected", async () => {
    await assert.rejects(runPreflight({ repo: "mallory/repo" }), /release repository/i);
    assert.throws(
      () => validateEligibilityEvidence(exactEvidence({ repository: "mallory/repo" })),
      /release repository/i,
    );
  });

  it("F26 target verifier substitution is ineffective because target scripts are never executed", async () => {
    const calls = [];
    const result = await runPreflight({ runCalls: calls });
    assert.equal(result.eligibility, "eligible");
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.command === "git"));
    const observed = calls.map((call) => call.args.join(" "));
    assert.ok(observed.some((text) => text.endsWith(":package.json")));
    assert.ok(observed.some((text) => text.endsWith(":package-lock.json")));
    assert.ok(observed.every((text) => !text.includes("scripts/release-preflight.mjs")));
    assert.ok(observed.every((text) => !text.includes("scripts/verify-release-ref.mjs")));
  });

  it("F27 target workflow substitution is ineffective because target workflow bytes are not read", async () => {
    const calls = [];
    await runPreflight({ runCalls: calls });
    const observed = calls.map((call) => call.args.join(" "));
    assert.ok(observed.every((text) => !text.includes(".github/workflows/release.yml")));
    assert.ok(observed.every((text) => !text.includes(".github/workflows/release-integrity.yml")));
  });

  it("F28 fully synthetic exact release fixture is eligible", async () => {
    const result = await runPreflight({
      version: "5.0.0",
      sourceRunId: 9001,
      sourceRunAttempt: 3,
    });
    assert.deepEqual(result, {
      schema_version: 2,
      eligibility: "eligible",
      repository: repo,
      target_sha: exactSha,
      version: "5.0.0",
      tag: "v5.0.0",
      evaluator_sha: evaluatorSha,
      ci_run_id: ciRunId,
      ci_run_attempt: ciRunAttempt,
      source_release_run_id: 9001,
      source_release_run_attempt: 3,
    });
  });

  it("strict eligibility parsing rejects forged legacy payloads and ambiguous extras", () => {
    assert.throws(
      () => validateEligibilityEvidence({ sha: exactSha, version: "5.0.0", tag: "v5.0.0" }),
      /unexpected fields/i,
    );
    assert.throws(
      () => validateEligibilityEvidence({ ...exactEvidence(), extra: true }),
      /unexpected fields/i,
    );
    assert.throws(
      () => validateEligibilityEvidence({ ...exactEvidence(), schema_version: 1 }),
      /schema_version/i,
    );
  });
});

function automaticRoutes({
  evidence = exactEvidence(),
  sourceRunOverrides = {},
  ciRunOverrides = {},
  tagSha = exactSha,
  release = publishedRelease(),
} = {}) {
  return [
    [`/actions/runs/${evidence.source_release_run_id}`, 200, {
      id: evidence.source_release_run_id,
      run_attempt: evidence.source_release_run_attempt,
      repository: { full_name: repo },
      path: ".github/workflows/release.yml",
      event: "repository_dispatch",
      status: "completed",
      conclusion: "success",
      head_sha: evidence.evaluator_sha,
      ...sourceRunOverrides,
    }],
    [`/actions/runs/${evidence.ci_run_id}`, 200, {
      id: evidence.ci_run_id,
      run_attempt: evidence.ci_run_attempt,
      repository: { full_name: repo },
      path: ".github/workflows/ci.yml",
      event: "push",
      status: "completed",
      conclusion: "success",
      head_sha: evidence.target_sha,
      head_branch: "main",
      ...ciRunOverrides,
    }],
    [`/git/ref/tags/${evidence.tag}`, 200, { object: { type: "commit", sha: tagSha } }],
    [`/releases/tags/${evidence.tag}`, 200, release],
  ];
}

describe("#835 independent post-release integrity", () => {
  it("verifies published identity from trusted evidence without requiring current main", async () => {
    const evidence = exactEvidence();
    const fetchCalls = [];
    const result = await verifyPublishedReleaseEvidence({
      repoRoot: "/trusted-integrity-evaluator",
      evidence,
      verifierSha,
      fetchImpl: fakeFetch(automaticRoutes({ evidence }), fetchCalls),
      run: evaluatorRun({ checkout: verifierSha, version: evidence.version }),
    });
    assert.equal(result.target_sha, exactSha);
    assert.equal(result.eligibility_evaluator_sha, evaluatorSha);
    assert.equal(result.verifier_sha, verifierSha);
    assert.equal(fetchCalls.some((url) => url.includes("/git/ref/heads/main")), false);
  });

  it("rejects source release provenance substitution", async () => {
    const evidence = exactEvidence();
    await assert.rejects(
      verifyPublishedReleaseEvidence({
        repoRoot: "/trusted-integrity-evaluator",
        evidence,
        verifierSha,
        fetchImpl: fakeFetch(automaticRoutes({
          evidence,
          sourceRunOverrides: { path: ".github/workflows/evil.yml" },
        })),
        run: evaluatorRun({ checkout: verifierSha, version: evidence.version }),
      }),
      /source release workflow identity mismatch/i,
    );
  });

  it("rejects eligibility evaluator identity not bound to the source release run", async () => {
    const evidence = exactEvidence();
    await assert.rejects(
      verifyPublishedReleaseEvidence({
        repoRoot: "/trusted-integrity-evaluator",
        evidence,
        verifierSha,
        fetchImpl: fakeFetch(automaticRoutes({
          evidence,
          sourceRunOverrides: { head_sha: otherSha },
        })),
        run: evaluatorRun({ checkout: verifierSha, version: evidence.version }),
      }),
      /source release head SHA mismatch/i,
    );
  });

  it("rejects stale CI identity recorded in eligibility evidence", async () => {
    const evidence = exactEvidence();
    await assert.rejects(
      verifyPublishedReleaseEvidence({
        repoRoot: "/trusted-integrity-evaluator",
        evidence,
        verifierSha,
        fetchImpl: fakeFetch(automaticRoutes({
          evidence,
          ciRunOverrides: { run_attempt: evidence.ci_run_attempt + 1 },
        })),
        run: evaluatorRun({ checkout: verifierSha, version: evidence.version }),
      }),
      /eligibility CI run identity mismatch/i,
    );
  });

  it("rejects publication tag or Release drift", async () => {
    const evidence = exactEvidence();
    await assert.rejects(
      verifyPublishedReleaseEvidence({
        repoRoot: "/trusted-integrity-evaluator",
        evidence,
        verifierSha,
        fetchImpl: fakeFetch(automaticRoutes({ evidence, tagSha: otherSha })),
        run: evaluatorRun({ checkout: verifierSha, version: evidence.version }),
      }),
      /published tag.*does not resolve/i,
    );
    await assert.rejects(
      verifyPublishedReleaseEvidence({
        repoRoot: "/trusted-integrity-evaluator",
        evidence,
        verifierSha,
        fetchImpl: fakeFetch(automaticRoutes({
          evidence,
          release: publishedRelease(evidence.tag, { prerelease: true }),
        })),
        run: evaluatorRun({ checkout: verifierSha, version: evidence.version }),
      }),
      /not stable and published/i,
    );
  });
});

console.log("#835 trusted release eligibility matrix passed");
