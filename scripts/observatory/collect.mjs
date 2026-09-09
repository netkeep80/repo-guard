import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { compileConstraintProgram } from "../../dist/checks/constraint-program.mjs";

export const C3_BASELINE_SHA =
  "92432809fcddc290080beb51ba151e13a5761869";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readYaml(path) {
  const document = parseDocument(readFileSync(path, "utf8"));
  if (document.errors.length) {
    throw new Error(
      `YAML parse failed for ${path}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS();
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function runProcess(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    ...options,
  }).trim();
}

function assertScenario(scenario, path) {
  for (const field of ["id", "title_ru", "summary_ru", "command"]) {
    if (typeof scenario?.[field] !== "string" || !scenario[field]) {
      throw new Error(`Scenario ${path} requires non-empty ${field}`);
    }
  }
  if (!Array.isArray(scenario.cases) || scenario.cases.length === 0) {
    throw new Error(`Scenario ${path} requires non-empty cases`);
  }
}

function collectScenarios(repoRoot, acceptedSha) {
  const root = resolve(repoRoot, "examples/scenarios");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const relativePath = `examples/scenarios/${entry.name}/scenario.json`;
      const scenario = readJson(resolve(repoRoot, relativePath));
      assertScenario(scenario, relativePath);
      return {
        ...scenario,
        provenance: {
          origin: "accepted_commit",
          source: relativePath,
          sha: acceptedSha,
        },
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function collectCompressionMetrics(repoRoot, run, acceptedSha) {
  const output = run(
    process.execPath,
    [
      resolve(repoRoot, "scripts/compression-metrics.mjs"),
      "--compare",
      C3_BASELINE_SHA,
    ],
    { cwd: repoRoot },
  );
  return {
    ...JSON.parse(output),
    provenance: {
      origin: "accepted_commit",
      source: "scripts/compression-metrics.mjs",
      sha: acceptedSha,
    },
  };
}

function collectCiWiring(repoRoot, acceptedSha) {
  const source = ".github/workflows/ci.yml";
  const workflow = readYaml(resolve(repoRoot, source));
  const triggerObject = workflow.on && typeof workflow.on === "object"
    ? workflow.on
    : {};
  const jobs = workflow.jobs && typeof workflow.jobs === "object"
    ? workflow.jobs
    : {};

  return {
    source,
    name: String(workflow.name ?? ""),
    triggers: Object.keys(triggerObject).sort(),
    jobs: Object.keys(jobs).sort().map((id) => ({
      id,
      steps: Array.isArray(jobs[id]?.steps)
        ? jobs[id].steps.map((step) => String(step.name ?? step.uses ?? step.run ?? ""))
        : [],
    })),
    provenance: {
      origin: "accepted_commit",
      source,
      sha: acceptedSha,
    },
  };
}

function validateReleasePayload(release, tag) {
  if (
    !release
    || typeof release !== "object"
    || release.tag_name !== tag
    || typeof release.draft !== "boolean"
    || (
      release.draft === false
      && (typeof release.html_url !== "string" || !release.html_url)
    )
  ) {
    throw new Error("malformed GitHub release observation");
  }
}

async function observeMatchingRelease({ repository, tag, token, fetchImpl }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    { headers },
  );

  if (response.status === 404) {
    return {
      tag,
      matching_published_release: false,
      release_url: null,
    };
  }
  if (!response.ok) {
    throw new Error(
      `GitHub release observation failed with status ${response.status}`,
    );
  }

  const release = await response.json();
  validateReleasePayload(release, tag);
  const published = !release.draft;
  return {
    tag,
    matching_published_release: published,
    release_url: published ? release.html_url : null,
  };
}

function requireAcceptedCi(ci) {
  if (!ci || ci.workflow !== "CI" || ci.conclusion !== "success") {
    throw new Error("accepted CI metadata requires successful CI workflow");
  }
  if (!Number.isInteger(ci.run_id) || ci.run_id <= 0) {
    throw new Error("accepted CI metadata requires positive run_id");
  }
  if (typeof ci.run_url !== "string" || !ci.run_url) {
    throw new Error("accepted CI metadata requires run_url");
  }
}

export async function collectObservatorySnapshot({
  repoRoot,
  acceptedSha,
  ci,
  repository,
  token,
  fetchImpl = globalThis.fetch,
  run = runProcess,
}) {
  const head = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (head !== acceptedSha) {
    throw new Error(`accepted SHA mismatch: expected ${acceptedSha}, got ${head}`);
  }
  requireAcceptedCi(ci);
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new Error("repository must use owner/name form");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }

  const packageJson = readJson(resolve(repoRoot, "package.json"));
  const policy = readJson(resolve(repoRoot, "repo-policy.json"));
  const matchingReleaseTag = `v${packageJson.version}`;
  const release = await observeMatchingRelease({
    repository,
    tag: matchingReleaseTag,
    token,
    fetchImpl,
  });
  const scenarios = collectScenarios(repoRoot, acceptedSha);
  const architecture = collectCompressionMetrics(repoRoot, run, acceptedSha);
  const constraintProgram = compileConstraintProgram(policy, null);

  return {
    schema_version: 1,
    repository: {
      full_name: repository,
      provenance: {
        origin: "github_observation",
        source: "repository",
        sha: acceptedSha,
      },
    },
    accepted: {
      sha: acceptedSha,
      ci: {
        workflow: ci.workflow,
        run_id: ci.run_id,
        run_url: ci.run_url,
        conclusion: ci.conclusion,
      },
      provenance: {
        origin: "accepted_ci",
        sha: acceptedSha,
      },
    },
    version: {
      package_version: String(packageJson.version),
      matching_release_tag: matchingReleaseTag,
      matching_published_release: release.matching_published_release,
      release_url: release.release_url,
      release_truth_status: release.matching_published_release
        ? "published"
        : "package_only",
      provenance: {
        origin: "github_observation",
        source: `releases/tags/${matchingReleaseTag}`,
        sha: acceptedSha,
      },
    },
    policy: {
      source: "repo-policy.json",
      accepted: policy,
      constraint_program: constraintProgram,
      provenance: {
        origin: "accepted_commit",
        source: "repo-policy.json",
        sha: acceptedSha,
      },
    },
    architecture,
    ci: collectCiWiring(repoRoot, acceptedSha),
    scenarios,
    sources: [
      ".github/workflows/ci.yml",
      "dist/checks/constraint-program.mjs",
      "examples/scenarios/**",
      "package.json",
      "repo-policy.json",
      "scripts/compression-metrics.mjs",
    ].sort(),
  };
}

function parseArgs(argv) {
  const allowed = new Set([
    "--accepted-sha",
    "--ci-run-id",
    "--ci-run-url",
    "--ci-conclusion",
    "--repository",
    "--output",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined) {
      throw new Error(`Unknown or incomplete collector argument: ${key ?? "<missing>"}`);
    }
    values[key] = value;
  }
  for (const key of allowed) {
    if (!(key in values)) throw new Error(`Missing collector argument: ${key}`);
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(".");
  const outputPath = resolve(repoRoot, args["--output"]);
  const snapshot = await collectObservatorySnapshot({
    repoRoot,
    acceptedSha: args["--accepted-sha"],
    ci: {
      workflow: "CI",
      run_id: Number(args["--ci-run-id"]),
      run_url: args["--ci-run-url"],
      conclusion: args["--ci-conclusion"],
    },
    repository: args["--repository"],
    token: process.env.GITHUB_TOKEN,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, stableJson(snapshot));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
