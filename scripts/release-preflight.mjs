import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectedTagForVersion,
  observeReleaseTruth,
} from "./verify-release-ref.mjs";

const EXACT_SHA = /^[0-9a-f]{40}$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TRUSTED_REPOSITORY = "netkeep80/repo-guard";
const AUTHORIZED_RELEASE_ACTOR = "netkeep80";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
export const ELIGIBILITY_SCHEMA_VERSION = 2;

function runProcess(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    ...options,
  }).trim();
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson({ repo, path, token, fetchImpl }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
    headers: githubHeaders(token),
  });
  if (response.status !== 200) {
    const detail = typeof response.text === "function" ? await response.text() : "";
    throw new Error(`GitHub API ${response.status} for ${path}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

function exactSha(value, label) {
  if (typeof value !== "string" || !EXACT_SHA.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-hex SHA`);
  }
  return value;
}

function positiveInteger(value, label) {
  const number = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return number;
}

function requireRepository(repo) {
  if (repo !== TRUSTED_REPOSITORY) {
    throw new Error(`release repository must be ${TRUSTED_REPOSITORY}`);
  }
  return repo;
}

function requireAuthorizedDispatcher(actor, repositoryOwner) {
  if (repositoryOwner !== AUTHORIZED_RELEASE_ACTOR || actor !== AUTHORIZED_RELEASE_ACTOR) {
    throw new Error(`unauthorized release dispatcher: ${String(actor)}`);
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readTargetJson({ repoRoot, sha, path, run }) {
  const raw = run("git", ["show", `${sha}:${path}`], { cwd: repoRoot });
  return parseJson(raw, `${sha}:${path}`);
}

function requireLockVersion(lock, version) {
  if (lock?.version !== version || lock?.packages?.[""]?.version !== version) {
    throw new Error(
      `package-lock version mismatch: package.json=${version}, root=${String(lock?.version)}, packages[""].version=${String(lock?.packages?.[""]?.version)}`,
    );
  }
}

function requireTargetPackage({ repoRoot, sha, run }) {
  const packageJson = readTargetJson({ repoRoot, sha, path: "package.json", run });
  const packageLock = readTargetJson({ repoRoot, sha, path: "package-lock.json", run });
  const version = packageJson?.version;
  if (typeof version !== "string" || !STABLE_SEMVER.test(version)) {
    throw new Error("Release package version must be a stable semantic version X.Y.Z");
  }
  requireLockVersion(packageLock, version);
  return { version, tag: expectedTagForVersion(version) };
}

function requireEvaluatorCheckout({ repoRoot, evaluatorSha, run, label = "trusted evaluator" }) {
  const expected = exactSha(evaluatorSha, `${label} SHA`);
  const checkout = exactSha(run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }), `${label} checkout`);
  if (checkout !== expected) {
    throw new Error(`${label} checkout ${checkout} does not match ${expected}`);
  }
  return checkout;
}

function requireWorkflowMetadata(workflow) {
  if (
    !workflow
    || workflow.path !== CI_WORKFLOW_PATH
    || !Number.isSafeInteger(workflow.id)
    || workflow.id <= 0
  ) {
    throw new Error("CI workflow identity is invalid");
  }
  return workflow;
}

function exactCiCandidate(run, expected) {
  return run
    && run.workflow_id === expected.workflowId
    && run.path === CI_WORKFLOW_PATH
    && run.event === "push"
    && run.head_branch === "main"
    && run.head_sha === expected.sha;
}

function requireAuthoritativeCiRun(runs, expected) {
  if (!Array.isArray(runs)) {
    throw new Error("post-merge CI evidence requires workflow_runs array");
  }
  const candidates = runs.filter((run) => exactCiCandidate(run, expected));
  if (candidates.length === 0) {
    throw new Error(`post-merge CI evidence for accepted SHA ${expected.sha} is missing`);
  }
  candidates.sort((a, b) => {
    const aId = Number.isSafeInteger(a.id) ? a.id : -1;
    const bId = Number.isSafeInteger(b.id) ? b.id : -1;
    if (aId !== bId) return bId - aId;
    const aAttempt = Number.isSafeInteger(a.run_attempt) ? a.run_attempt : -1;
    const bAttempt = Number.isSafeInteger(b.run_attempt) ? b.run_attempt : -1;
    return bAttempt - aAttempt;
  });
  const current = candidates[0];
  positiveInteger(current.id, "CI run id");
  positiveInteger(current.run_attempt, "CI run attempt");
  if (current.status !== "completed" || current.conclusion !== "success") {
    throw new Error(`authoritative post-merge CI for accepted SHA ${expected.sha} is not successful`);
  }
  return current;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

export function validateEligibilityEvidence(value, expected = {}) {
  const keys = [
    "schema_version",
    "eligibility",
    "repository",
    "target_sha",
    "version",
    "tag",
    "evaluator_sha",
    "ci_run_id",
    "ci_run_attempt",
    "source_release_run_id",
    "source_release_run_attempt",
  ];
  exactKeys(value, keys, "release eligibility evidence");
  if (value.schema_version !== ELIGIBILITY_SCHEMA_VERSION) {
    throw new Error("release eligibility evidence schema_version is invalid");
  }
  if (value.eligibility !== "eligible") {
    throw new Error("release eligibility conclusion is invalid");
  }
  requireRepository(value.repository);
  exactSha(value.target_sha, "release eligibility target");
  exactSha(value.evaluator_sha, "release eligibility evaluator");
  if (typeof value.version !== "string" || !STABLE_SEMVER.test(value.version)) {
    throw new Error("release eligibility version is invalid");
  }
  if (value.tag !== expectedTagForVersion(value.version)) {
    throw new Error("release eligibility tag/version mismatch");
  }
  positiveInteger(value.ci_run_id, "release eligibility CI run id");
  positiveInteger(value.ci_run_attempt, "release eligibility CI run attempt");
  positiveInteger(value.source_release_run_id, "release eligibility source run id");
  positiveInteger(value.source_release_run_attempt, "release eligibility source run attempt");

  const expectedMap = {
    repository: expected.repository,
    target_sha: expected.targetSha,
    evaluator_sha: expected.evaluatorSha,
    source_release_run_id: expected.sourceRunId,
    source_release_run_attempt: expected.sourceRunAttempt,
  };
  for (const [field, expectedValue] of Object.entries(expectedMap)) {
    if (expectedValue !== undefined && value[field] !== expectedValue) {
      throw new Error(`release eligibility evidence ${field} mismatch`);
    }
  }
  return value;
}

function requireObservedRunIdentity(run, expected, label) {
  if (!run || run.id !== expected.id || run.run_attempt !== expected.attempt) {
    throw new Error(`${label} run identity mismatch`);
  }
  if (run.repository?.full_name !== TRUSTED_REPOSITORY) {
    throw new Error(`${label} repository identity mismatch`);
  }
  if (run.path !== expected.path || run.event !== expected.event) {
    throw new Error(`${label} workflow identity mismatch`);
  }
  if (run.status !== "completed") {
    throw new Error(`${label} run is not completed`);
  }
  if (expected.headSha !== undefined && run.head_sha !== expected.headSha) {
    throw new Error(`${label} head SHA mismatch`);
  }
  if (expected.headBranch !== undefined && run.head_branch !== expected.headBranch) {
    throw new Error(`${label} head branch mismatch`);
  }
  if (expected.conclusion !== undefined && run.conclusion !== expected.conclusion) {
    throw new Error(`${label} conclusion mismatch`);
  }
  return run;
}

export async function preflightRelease({
  repoRoot,
  repo,
  sha,
  evaluatorSha,
  actor,
  repositoryOwner,
  sourceRunId,
  sourceRunAttempt,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  fetchImpl = globalThis.fetch,
  run = runProcess,
}) {
  requireRepository(repo);
  requireAuthorizedDispatcher(actor, repositoryOwner);
  const targetSha = exactSha(sha, "Release target");
  const trustedEvaluatorSha = exactSha(evaluatorSha, "Evaluator");
  const sourceReleaseRunId = positiveInteger(sourceRunId, "source release run id");
  const sourceReleaseRunAttempt = positiveInteger(sourceRunAttempt, "source release run attempt");
  if (typeof repoRoot !== "string" || !repoRoot) throw new Error("repoRoot is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  requireEvaluatorCheckout({ repoRoot, evaluatorSha: trustedEvaluatorSha, run });
  run("git", ["cat-file", "-e", `${targetSha}^{commit}`], { cwd: repoRoot });
  const { version, tag } = requireTargetPackage({ repoRoot, sha: targetSha, run });

  const mainRef = await githubJson({ repo, path: "/git/ref/heads/main", token, fetchImpl });
  if (mainRef?.object?.type !== "commit" || mainRef.object.sha !== targetSha) {
    throw new Error(`main does not match requested SHA ${targetSha}`);
  }

  const workflow = requireWorkflowMetadata(await githubJson({
    repo,
    path: "/actions/workflows/ci.yml",
    token,
    fetchImpl,
  }));
  const ci = await githubJson({
    repo,
    path: `/actions/workflows/${workflow.id}/runs?branch=main&event=push&head_sha=${targetSha}&per_page=100`,
    token,
    fetchImpl,
  });
  const ciRun = requireAuthoritativeCiRun(ci?.workflow_runs, {
    workflowId: workflow.id,
    sha: targetSha,
  });

  const release = await observeReleaseTruth({ repo, tag, token, fetchImpl });
  if (release.tag_exists && release.tag_commit !== targetSha) {
    throw new Error(`release tag ${tag} points to a different SHA: expected ${targetSha}, got ${release.tag_commit}`);
  }
  if (release.release_exists && !release.published) {
    throw new Error(`Release ${tag} exists but is not published non-draft/non-prerelease state`);
  }

  return validateEligibilityEvidence({
    schema_version: ELIGIBILITY_SCHEMA_VERSION,
    eligibility: "eligible",
    repository: repo,
    target_sha: targetSha,
    version,
    tag,
    evaluator_sha: trustedEvaluatorSha,
    ci_run_id: positiveInteger(ciRun.id, "CI run id"),
    ci_run_attempt: positiveInteger(ciRun.run_attempt, "CI run attempt"),
    source_release_run_id: sourceReleaseRunId,
    source_release_run_attempt: sourceReleaseRunAttempt,
  }, {
    repository: repo,
    targetSha,
    evaluatorSha: trustedEvaluatorSha,
    sourceRunId: sourceReleaseRunId,
    sourceRunAttempt: sourceReleaseRunAttempt,
  });
}

export async function verifyPublishedReleaseEvidence({
  repoRoot,
  evidence,
  verifierSha,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  fetchImpl = globalThis.fetch,
  run = runProcess,
}) {
  const validated = validateEligibilityEvidence(evidence, { repository: TRUSTED_REPOSITORY });
  const trustedVerifierSha = exactSha(verifierSha, "integrity verifier");
  if (typeof repoRoot !== "string" || !repoRoot) throw new Error("repoRoot is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  requireEvaluatorCheckout({ repoRoot, evaluatorSha: trustedVerifierSha, run, label: "integrity verifier" });
  run("git", ["cat-file", "-e", `${validated.target_sha}^{commit}`], { cwd: repoRoot });
  const targetPackage = requireTargetPackage({ repoRoot, sha: validated.target_sha, run });
  if (targetPackage.version !== validated.version || targetPackage.tag !== validated.tag) {
    throw new Error("published target package identity does not match eligibility evidence");
  }

  const sourceRun = await githubJson({
    repo: validated.repository,
    path: `/actions/runs/${validated.source_release_run_id}`,
    token,
    fetchImpl,
  });
  requireObservedRunIdentity(sourceRun, {
    id: validated.source_release_run_id,
    attempt: validated.source_release_run_attempt,
    path: RELEASE_WORKFLOW_PATH,
    event: "repository_dispatch",
    headSha: validated.evaluator_sha,
  }, "source release");

  const ciRun = await githubJson({
    repo: validated.repository,
    path: `/actions/runs/${validated.ci_run_id}`,
    token,
    fetchImpl,
  });
  requireObservedRunIdentity(ciRun, {
    id: validated.ci_run_id,
    attempt: validated.ci_run_attempt,
    path: CI_WORKFLOW_PATH,
    event: "push",
    headSha: validated.target_sha,
    headBranch: "main",
    conclusion: "success",
  }, "eligibility CI");

  const truth = await observeReleaseTruth({
    repo: validated.repository,
    tag: validated.tag,
    token,
    fetchImpl,
  });
  if (!truth.tag_exists || truth.tag_commit !== validated.target_sha) {
    throw new Error(`published tag ${validated.tag} does not resolve to eligible target ${validated.target_sha}`);
  }
  if (!truth.release_exists || !truth.published) {
    throw new Error(`GitHub Release ${validated.tag} is not stable and published`);
  }

  return {
    repository: validated.repository,
    target_sha: validated.target_sha,
    version: validated.version,
    tag: validated.tag,
    eligibility_evaluator_sha: validated.evaluator_sha,
    verifier_sha: trustedVerifierSha,
    source_release_run_id: validated.source_release_run_id,
    source_release_run_attempt: validated.source_release_run_attempt,
  };
}

function parseArgs(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "eligibility";
  if (mode === "eligibility") {
    const args = parseArgs(argv, new Set([
      "--sha", "--repo", "--evaluator-sha", "--actor", "--repository-owner",
      "--source-run-id", "--source-run-attempt",
    ]));
    const result = await preflightRelease({
      repoRoot: process.cwd(),
      repo: args.repo || process.env.GITHUB_REPOSITORY,
      sha: args.sha,
      evaluatorSha: args["evaluator-sha"],
      actor: args.actor,
      repositoryOwner: args["repository-owner"],
      sourceRunId: args["source-run-id"],
      sourceRunAttempt: args["source-run-attempt"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (mode === "integrity") {
    const args = parseArgs(argv, new Set([
      "--repo", "--sha", "--version", "--tag", "--evaluator-sha", "--verifier-sha",
      "--ci-run-id", "--ci-run-attempt", "--source-run-id", "--source-run-attempt",
    ]));
    const evidence = validateEligibilityEvidence({
      schema_version: ELIGIBILITY_SCHEMA_VERSION,
      eligibility: "eligible",
      repository: args.repo,
      target_sha: args.sha,
      version: args.version,
      tag: args.tag,
      evaluator_sha: args["evaluator-sha"],
      ci_run_id: positiveInteger(args["ci-run-id"], "CI run id"),
      ci_run_attempt: positiveInteger(args["ci-run-attempt"], "CI run attempt"),
      source_release_run_id: positiveInteger(args["source-run-id"], "source run id"),
      source_release_run_attempt: positiveInteger(args["source-run-attempt"], "source run attempt"),
    });
    const result = await verifyPublishedReleaseEvidence({
      repoRoot: process.cwd(),
      evidence,
      verifierSha: args["verifier-sha"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
