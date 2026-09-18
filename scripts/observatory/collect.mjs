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

import {
  createPolicyNormalizationContext,
  normalizePolicy,
} from "../../dist/runtime/validation.mjs";
import {
  expectedTagForVersion,
  observeReleaseTruth,
} from "../verify-release-ref.mjs";

export const C3_BASELINE_SHA =
  "92432809fcddc290080beb51ba151e13a5761869";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACCEPTED_CI_WORKFLOW = "CI";
const ACCEPTED_CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const ACCEPTED_CI_EVENT = "push";
const ACCEPTED_CI_BRANCH = "main";
const RELEASE_INTEGRITY_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
]);

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
    concurrency: workflow.concurrency ?? null,
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

function requireAcceptedCi(ci, acceptedSha) {
  if (
    !ci
    || ci.workflow !== ACCEPTED_CI_WORKFLOW
    || ci.workflow_path !== ACCEPTED_CI_WORKFLOW_PATH
    || ci.event !== ACCEPTED_CI_EVENT
    || ci.branch !== ACCEPTED_CI_BRANCH
    || ci.head_sha !== acceptedSha
    || ci.conclusion !== "success"
  ) {
    throw new Error("accepted CI metadata requires exact successful CI workflow observation for accepted SHA");
  }
  if (!Number.isInteger(ci.run_id) || ci.run_id <= 0) {
    throw new Error("accepted CI metadata requires positive run_id");
  }
  if (typeof ci.run_url !== "string" || !ci.run_url) {
    throw new Error("accepted CI metadata requires run_url");
  }
}

function requireObservedAt(observedAt) {
  if (
    typeof observedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt))
  ) {
    throw new Error("observed_at must be a UTC ISO-8601 timestamp");
  }
  return observedAt;
}

function normalizeReleaseIntegrity(releaseIntegrity, acceptedSha, expectedTag) {
  if (releaseIntegrity === null || releaseIntegrity === undefined) return null;
  if (!releaseIntegrity || typeof releaseIntegrity !== "object" || Array.isArray(releaseIntegrity)) {
    throw new Error("release integrity evidence must be an object or null");
  }
  if (releaseIntegrity.target_sha !== acceptedSha) {
    throw new Error("release integrity target_sha must equal accepted SHA");
  }
  if (releaseIntegrity.tag !== expectedTag) {
    throw new Error("release integrity tag must equal expected release tag");
  }
  for (const field of ["run_id", "run_attempt"]) {
    if (!Number.isInteger(releaseIntegrity[field]) || releaseIntegrity[field] <= 0) {
      throw new Error(`release integrity ${field} must be a positive integer`);
    }
  }
  if (typeof releaseIntegrity.run_url !== "string" || !releaseIntegrity.run_url) {
    throw new Error("release integrity run_url must be a non-empty string");
  }
  if (!RELEASE_INTEGRITY_CONCLUSIONS.has(releaseIntegrity.conclusion)) {
    throw new Error("release integrity conclusion is unsupported");
  }
  return {
    target_sha: releaseIntegrity.target_sha,
    tag: releaseIntegrity.tag,
    run_id: releaseIntegrity.run_id,
    run_attempt: releaseIntegrity.run_attempt,
    run_url: releaseIntegrity.run_url,
    conclusion: releaseIntegrity.conclusion,
  };
}

export async function collectObservatorySnapshot({
  repoRoot,
  acceptedSha,
  observedAt,
  ci,
  releaseIntegrity = null,
  repository,
  token,
  fetchImpl = globalThis.fetch,
  run = runProcess,
}) {
  const head = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (head !== acceptedSha) {
    throw new Error(`accepted SHA mismatch: expected ${acceptedSha}, got ${head}`);
  }
  requireAcceptedCi(ci, acceptedSha);
  const normalizedObservedAt = requireObservedAt(observedAt);
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new Error("repository must use owner/name form");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }

  const packageJson = readJson(resolve(repoRoot, "package.json"));
  const policy = readJson(resolve(repoRoot, "repo-policy.json"));
  const normalizationContext = createPolicyNormalizationContext({ packageRoot, repoRoot });
  const normalizedPolicy = normalizePolicy(normalizationContext, policy, {
    quiet: true,
    label: "repo-policy.json (Observatory)",
  });
  if (!normalizedPolicy.ok || !normalizedPolicy.constraintProgram) {
    throw new Error(`Policy normalization failed for Observatory: ${normalizedPolicy.errors.map((error) => `${error.group}: ${error.message}`).join("; ")}`);
  }
  const expectedReleaseTag = expectedTagForVersion(String(packageJson.version));
  const releaseTruth = await observeReleaseTruth({
    repo: repository,
    tag: expectedReleaseTag,
    token,
    fetchImpl,
  });
  const normalizedReleaseIntegrity = normalizeReleaseIntegrity(
    releaseIntegrity,
    acceptedSha,
    expectedReleaseTag,
  );
  const scenarios = collectScenarios(repoRoot, acceptedSha);
  const architecture = collectCompressionMetrics(repoRoot, run, acceptedSha);
  const constraintProgram = normalizedPolicy.constraintProgram;

  return {
    schema_version: 2,
    observed_at: normalizedObservedAt,
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
      expected_release_tag: expectedReleaseTag,
    },
    release: {
      tag_exists: releaseTruth.tag_exists,
      tag_commit: releaseTruth.tag_commit,
      release_exists: releaseTruth.release_exists,
      draft: releaseTruth.draft,
      prerelease: releaseTruth.prerelease,
      stable_published: releaseTruth.published,
      release_url: releaseTruth.release_url,
      tag_matches_accepted_sha: releaseTruth.tag_commit === null
        ? null
        : releaseTruth.tag_commit === acceptedSha,
    },
    release_integrity: normalizedReleaseIntegrity,
    policy: {
      source: "repo-policy.json",
      accepted: policy,
      constraint_program: constraintProgram,
      normalization: normalizedPolicy.provenance,
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
      "dist/runtime/validation.mjs",
      "examples/scenarios/**",
      "package.json",
      "repo-policy.json",
      "scripts/compression-metrics.mjs",
      "scripts/verify-release-ref.mjs",
    ].sort(),
  };
}

function parseArgs(argv) {
  const required = new Set([
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
    "--output",
  ]);
  const optional = new Set(["--release-integrity-file"]);
  const allowed = new Set([...required, ...optional]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined) {
      throw new Error(`Unknown or incomplete collector argument: ${key ?? "<missing>"}`);
    }
    values[key] = value;
  }
  for (const key of required) {
    if (!(key in values)) throw new Error(`Missing collector argument: ${key}`);
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(".");
  const outputPath = resolve(repoRoot, args["--output"]);
  const releaseIntegrity = args["--release-integrity-file"]
    ? readJson(resolve(repoRoot, args["--release-integrity-file"]))
    : null;
  const snapshot = await collectObservatorySnapshot({
    repoRoot,
    acceptedSha: args["--accepted-sha"],
    observedAt: args["--observed-at"],
    ci: {
      workflow: "CI",
      workflow_path: args["--ci-workflow-path"],
      event: args["--ci-event"],
      branch: args["--ci-branch"],
      head_sha: args["--ci-head-sha"],
      run_id: Number(args["--ci-run-id"]),
      run_url: args["--ci-run-url"],
      conclusion: args["--ci-conclusion"],
    },
    releaseIntegrity,
    repository: args["--repository"],
    token: process.env.GITHUB_TOKEN,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, stableJson(snapshot));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
