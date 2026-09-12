#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "netkeep80/repo-guard";
const GITHUB_API = "https://api.github.com";
const PASS = "PASS";
const FAIL = "FAIL";
const MAX_TAG_OBJECT_DEPTH = 16;

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultPackageRoot = resolve(__dirname, "..");

function missingFetchMessage() {
  return `No fetch implementation is available in ${process.version}; repo-guard requires Node >=20 for release verification`;
}

function loadPackageVersion(packageRoot) {
  const packagePath = resolve(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
  if (!packageJson.version || typeof packageJson.version !== "string") {
    throw new Error(`Cannot determine repo-guard package version from ${packagePath}`);
  }
  return packageJson.version;
}

function tokenHeaders(token) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "repo-guard-release-ref-verifier",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubGet(path, { repo, token, fetchImpl }) {
  const url = `${GITHUB_API}/repos/${repo}${path}`;
  let response;
  try {
    response = await fetchImpl(url, { headers: tokenHeaders(token) });
  } catch (e) {
    return { ok: false, status: 0, url, message: `request failed: ${e.message}` };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Some error responses may not be JSON. Keep the status as the diagnostic.
  }

  if (response.status === 200) return { ok: true, status: response.status, url, body };
  const message = body?.message || `HTTP ${response.status}`;
  return { ok: false, status: response.status, url, body, message };
}

function pass(name, message) {
  return { name, status: PASS, message };
}

function fail(name, message, hint = null) {
  return { name, status: FAIL, message, hint };
}

function runProcess(command, args, { cwd } = {}) {
  return execFileSync(command, args, { cwd, encoding: "utf-8" }).trim();
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed ${label}`);
  }
  return value;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be an exact 40-hex SHA`);
  }
  return value.toLowerCase();
}

function requireTagTarget(body, label) {
  const payload = requireObject(body, label);
  const object = requireObject(payload.object, `${label} object`);
  if (typeof object.type !== "string" || object.type.trim() === "") {
    throw new Error(`Malformed ${label}: missing object.type`);
  }
  return {
    type: object.type,
    sha: requireSha(object.sha, `${label} object.sha`),
  };
}

function githubRequestError(label, result) {
  const status = result.status ? ` (${result.status})` : "";
  const detail = result.message ? `: ${result.message}` : "";
  return new Error(`${label} failed${status}${detail}`);
}

async function resolveTagObjectToCommit({ repo, object, token, fetchImpl }) {
  let current = object;
  const visited = new Set();

  for (let depth = 0; ; depth += 1) {
    if (current.type === "commit") {
      return requireSha(current.sha, "tag commit");
    }
    if (current.type !== "tag") {
      throw new Error(`Unsupported object type for release tag: ${current.type}`);
    }
    if (depth >= MAX_TAG_OBJECT_DEPTH) {
      throw new Error(`Annotated tag depth exceeds ${MAX_TAG_OBJECT_DEPTH}`);
    }

    const objectSha = requireSha(current.sha, "annotated tag object");
    if (visited.has(objectSha)) {
      throw new Error("Annotated tag cycle detected");
    }
    visited.add(objectSha);

    const result = await githubGet(`/git/tags/${objectSha}`, { repo, token, fetchImpl });
    if (!result.ok) throw githubRequestError("GitHub annotated tag request", result);
    current = requireTagTarget(result.body, "annotated tag payload");
  }
}

function absentReleaseTruth(tag) {
  return {
    tag,
    tag_exists: false,
    tag_commit: null,
    release_exists: false,
    published: false,
    draft: null,
    prerelease: null,
    release_url: null,
  };
}

function validateReleasePayload(body, tag) {
  const release = requireObject(body, "release payload");
  if (typeof release.tag_name !== "string" || release.tag_name.trim() === "") {
    throw new Error("Malformed release payload: tag_name must be a non-empty string");
  }
  if (release.tag_name !== tag) {
    throw new Error(`Release payload tag_name ${release.tag_name} does not match ${tag}`);
  }
  if (typeof release.draft !== "boolean") {
    throw new Error("Malformed release payload: draft must be boolean");
  }
  if (typeof release.prerelease !== "boolean") {
    throw new Error("Malformed release payload: prerelease must be boolean");
  }
  if (typeof release.html_url !== "string" || release.html_url.trim() === "") {
    throw new Error("Malformed release payload: html_url must be a non-empty string");
  }
  return release;
}

export function expectedTagForVersion(version) {
  return `v${version}`;
}

export async function observeReleaseTruth({
  repo = DEFAULT_REPO,
  tag,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof repo !== "string" || repo.trim() === "") {
    throw new Error("Repository must be a non-empty owner/name string");
  }
  if (typeof tag !== "string" || tag.trim() === "") {
    throw new Error("Release tag must be a non-empty string");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error(missingFetchMessage());
  }

  const encodedTag = encodeURIComponent(tag);
  const tagResult = await githubGet(`/git/ref/tags/${encodedTag}`, { repo, token, fetchImpl });
  if (tagResult.status === 404) return absentReleaseTruth(tag);
  if (!tagResult.ok) throw githubRequestError("GitHub tag reference request", tagResult);

  const tagObject = requireTagTarget(tagResult.body, "tag reference payload");
  const tagCommit = await resolveTagObjectToCommit({
    repo,
    object: tagObject,
    token,
    fetchImpl,
  });

  const releaseResult = await githubGet(`/releases/tags/${encodedTag}`, { repo, token, fetchImpl });
  if (releaseResult.status === 404) {
    return {
      tag,
      tag_exists: true,
      tag_commit: tagCommit,
      release_exists: false,
      published: false,
      draft: null,
      prerelease: null,
      release_url: null,
    };
  }
  if (!releaseResult.ok) throw githubRequestError("GitHub release request", releaseResult);

  const release = validateReleasePayload(releaseResult.body, tag);
  return {
    tag,
    tag_exists: true,
    tag_commit: tagCommit,
    release_exists: true,
    published: !release.draft && !release.prerelease,
    draft: release.draft,
    prerelease: release.prerelease,
    release_url: release.html_url,
  };
}

export async function verifyReleaseRef({
  packageRoot = defaultPackageRoot,
  repo = DEFAULT_REPO,
  tag = null,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  fetchImpl = globalThis.fetch,
  run = runProcess,
} = {}) {
  const checks = [];
  let packageVersion = null;
  let expectedTag = null;

  if (!fetchImpl) {
    checks.push(fail("github-api-client", missingFetchMessage()));
    return { ok: false, packageVersion, expectedTag, repo, checks };
  }

  try {
    packageVersion = loadPackageVersion(packageRoot);
    expectedTag = expectedTagForVersion(packageVersion);
    checks.push(pass("package-version", `package.json version is ${packageVersion}`));
  } catch (e) {
    checks.push(fail("package-version", e.message));
    return { ok: false, packageVersion, expectedTag, repo, checks };
  }

  const suppliedTag = tag?.trim() || expectedTag;
  if (suppliedTag !== expectedTag) {
    checks.push(fail(
      "release-tag-matches-package",
      `Release tag ${suppliedTag} does not match package.json version ${packageVersion}`,
      `Publish or verify ${expectedTag}, or bump package.json.version to match ${suppliedTag}`
    ));
    return { ok: false, packageVersion, expectedTag, repo, checks };
  }
  checks.push(pass("release-tag-matches-package", `${suppliedTag} matches package.json.version`));

  let checkoutSha;
  try {
    checkoutSha = requireSha(
      run("git", ["rev-parse", "HEAD"], { cwd: packageRoot }),
      "checkout HEAD",
    );
    checks.push(pass("release-checkout", `Current checkout is ${checkoutSha}`));
  } catch (e) {
    checks.push(fail("release-checkout", e.message));
    return { ok: false, packageVersion, expectedTag, repo, checks };
  }

  let truth;
  try {
    truth = await observeReleaseTruth({
      repo,
      tag: expectedTag,
      token,
      fetchImpl,
    });
  } catch (e) {
    checks.push(fail("release-observation", e.message));
    return { ok: false, packageVersion, expectedTag, repo, checks };
  }

  if (!truth.tag_exists) {
    checks.push(fail(
      "published-git-tag",
      `Git tag ${expectedTag} was not found in ${repo}`,
      `Push the release tag before publishing package version ${packageVersion}`
    ));
    return { ok: false, packageVersion, expectedTag, repo, checks };
  }
  checks.push(pass("published-git-tag", `Git tag ${expectedTag} exists in ${repo}`));

  if (truth.tag_commit === checkoutSha) {
    checks.push(pass(
      "release-tag-resolves-to-checkout",
      `${expectedTag} resolves to current checkout ${checkoutSha}`,
    ));
  } else {
    checks.push(fail(
      "release-tag-resolves-to-checkout",
      `${expectedTag} resolves to ${truth.tag_commit}, current checkout is ${checkoutSha}`,
      "Verify the exact release commit before publishing",
    ));
  }

  if (!truth.release_exists) {
    checks.push(fail(
      "published-github-release",
      `GitHub release ${expectedTag} was not found in ${repo}`,
      `Create and publish the GitHub release before publishing package version ${packageVersion}`
    ));
  } else if (!truth.published) {
    const state = truth.draft ? "draft" : "prerelease";
    checks.push(fail(
      "published-github-release",
      `GitHub release ${expectedTag} exists but is ${state}`,
      "Publish a non-draft, non-prerelease GitHub release before publishing the npm package",
    ));
  } else {
    checks.push(pass("published-github-release", `GitHub release ${expectedTag} is published in ${repo}`));
  }

  return {
    ok: checks.every((check) => check.status === PASS),
    packageVersion,
    expectedTag,
    repo,
    checks,
  };
}

function usage() {
  return `Usage: node scripts/verify-release-ref.mjs [--repo <owner/repo>] [--tag <vX.Y.Z>] [--package-root <path>]

Checks the release invariant used by repo-guard init:
  package.json.version -> exact Git tag commit -> current checkout -> published GitHub release v<version>
`;
}

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--repo" && args[i + 1]) {
      opts.repo = args[++i];
    } else if (arg === "--tag" && args[i + 1]) {
      opts.tag = args[++i];
    } else if (arg === "--package-root" && args[i + 1]) {
      opts.packageRoot = resolve(args[++i]);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function printResult(result) {
  console.log("repo-guard release ref verification\n");
  console.log(`Repository: ${result.repo}`);
  if (result.packageVersion) console.log(`package.json version: ${result.packageVersion}`);
  if (result.expectedTag) {
    console.log(`Expected Action ref: ${result.repo}@${result.expectedTag}`);
  }
  console.log("");

  for (const check of result.checks) {
    console.log(`${check.status}: ${check.name}`);
    console.log(`  ${check.message}`);
    if (check.hint) console.log(`  hint: ${check.hint}`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(usage());
    process.exit(2);
  }

  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }

  const result = await verifyReleaseRef(opts);
  printResult(result);
  process.exit(result.ok ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  });
}
