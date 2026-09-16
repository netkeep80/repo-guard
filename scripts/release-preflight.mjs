import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectedTagForVersion,
  observeReleaseTruth,
} from "./verify-release-ref.mjs";

const EXACT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

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
    const detail = typeof response.text === "function"
      ? await response.text()
      : "";
    throw new Error(`GitHub API ${response.status} for ${path}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

function requireExactWorkflowRun(runs, expected, label) {
  if (!Array.isArray(runs)) {
    throw new Error(`${label} evidence requires workflow_runs array`);
  }

  const run = runs.find((candidate) =>
    candidate
    && candidate.path === expected.path
    && candidate.event === expected.event
    && candidate.head_branch === "main"
    && candidate.head_sha === expected.sha
    && candidate.status === "completed"
  );

  if (!run || run.conclusion !== "success") {
    throw new Error(`${label} evidence for accepted SHA ${expected.sha} is not successful`);
  }
  return run;
}

function requireLockVersion(lock, version) {
  if (
    lock?.version !== version
    || lock?.packages?.[""]?.version !== version
  ) {
    throw new Error(
      `package-lock version mismatch: package.json=${version}, root=${String(lock?.version)}, packages[\"\"].version=${String(lock?.packages?.[""]?.version)}`,
    );
  }
}

export async function preflightRelease({
  repoRoot,
  repo,
  sha,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  fetchImpl = globalThis.fetch,
  run = runProcess,
}) {
  if (typeof sha !== "string" || !EXACT_SHA.test(sha)) {
    throw new Error("Release target must be an exact lowercase 40-hex SHA");
  }
  if (typeof repoRoot !== "string" || !repoRoot) {
    throw new Error("repoRoot is required");
  }
  if (typeof repo !== "string" || !REPOSITORY.test(repo)) {
    throw new Error("repository must use owner/name form");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }

  const checkoutSha = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (checkoutSha !== sha) {
    throw new Error(`checkout does not match requested SHA: expected ${sha}, got ${checkoutSha}`);
  }

  const packageJson = readJson(resolve(repoRoot, "package.json"));
  const packageLock = readJson(resolve(repoRoot, "package-lock.json"));
  const version = packageJson?.version;
  const tag = expectedTagForVersion(version);
  requireLockVersion(packageLock, version);

  run("npm", ["run", "check:dist"], { cwd: repoRoot });

  const mainRef = await githubJson({
    repo,
    path: "/git/ref/heads/main",
    token,
    fetchImpl,
  });
  if (
    mainRef?.object?.type !== "commit"
    || mainRef.object.sha !== sha
  ) {
    throw new Error(`main does not match requested SHA ${sha}`);
  }

  const ci = await githubJson({
    repo,
    path: `/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&status=completed&per_page=100`,
    token,
    fetchImpl,
  });
  requireExactWorkflowRun(
    ci?.workflow_runs,
    { path: ".github/workflows/ci.yml", event: "push", sha },
    "post-merge CI",
  );

  const pages = await githubJson({
    repo,
    path: `/actions/workflows/pages.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&status=completed&per_page=100`,
    token,
    fetchImpl,
  });
  requireExactWorkflowRun(
    pages?.workflow_runs,
    { path: ".github/workflows/pages.yml", event: "workflow_run", sha },
    "Pages-on-accepted-SHA",
  );

  const release = await observeReleaseTruth({
    repo,
    tag,
    token,
    fetchImpl,
  });

  if (release.tag_exists && release.tag_commit !== sha) {
    throw new Error(
      `release tag ${tag} points to a different SHA: expected ${sha}, got ${release.tag_commit}`,
    );
  }
  if (release.release_exists && !release.published) {
    throw new Error(`Release ${tag} exists but is not published non-draft/non-prerelease state`);
  }

  return { sha, version, tag };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== "--sha" && key !== "--repo") {
      throw new Error(`Unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await preflightRelease({
    repoRoot: process.cwd(),
    repo: args.repo || process.env.GITHUB_REPOSITORY,
    sha: args.sha,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
