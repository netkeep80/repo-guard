import { execFileSync } from "node:child_process";
import {
  runTrustedPortableCoordinator,
  type TrustedPortableCoordinatorEvidence,
} from "./trusted-command.mjs";

type MergeMethod = "merge" | "squash" | "rebase";
type OutputFormat = "text" | "json";
type RequiredCheck = { name: string };
type Failure = { ok: false; error: string; message: string };
type Success = {
  ok: true;
  value: {
    repository: string;
    readyLabel: string;
    mergeMethod: MergeMethod;
    requiredChecks: {
      transaction: RequiredCheck[];
      state: RequiredCheck[];
    };
    format: OutputFormat;
  };
};
type RunCommand = (command: string, args: string[]) => string;
type RuntimeDependencies = {
  run?: RunCommand;
  readReadyInventory?: () => Promise<unknown>;
  readCandidate?: (prNumber: number) => Promise<unknown>;
  mutationTransport?: unknown;
  writeOutput?: (text: string) => void;
};

export type PortableCoordinatorArgsResult = Failure | Success;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXACT_SHA = /^[0-9a-f]{40}$/i;
const MERGE_METHODS = new Set<MergeMethod>(["merge", "squash", "rebase"]);
const FORMATS = new Set<OutputFormat>(["text", "json"]);
const SINGLETON_OPTIONS = new Set(["--repository", "--ready-label", "--merge-method", "--format"]);
const REPEATABLE_OPTIONS = new Set(["--transaction-check", "--state-check"]);

function fail(error: string, message: string): Failure {
  return { ok: false, error, message };
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeChecks(values: string[]): RequiredCheck[] {
  return [...new Set(values)].sort().map((name) => ({ name }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !EXACT_SHA.test(value)) {
    throw new Error(`malformed_github_response: ${label} must be an exact commit SHA`);
  }
  return value;
}

function defaultRun(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 30000,
  });
}

function parseRuntimeJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`malformed_github_response: ${label}: ${message}`);
  }
}

function normalizeInventoryItem(value: unknown): unknown {
  if (!isObject(value) || value.mergeable !== undefined) return value;
  return { ...value, mergeable: null };
}

function createReadyInventoryReader(repository: string, run: RunCommand) {
  return async () => {
    const endpoint = `repos/${repository}/pulls?state=open&per_page=100`;
    const pages = parseRuntimeJson(
      run("gh", ["api", endpoint, "--paginate", "--slurp"]),
      endpoint,
    );
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error("malformed_github_response: PR inventory pagination must be an array of pages");
    }
    return {
      complete: true,
      pages: pages.map((page) => (page as unknown[]).map(normalizeInventoryItem)),
    };
  };
}

function createCandidateReader(repository: string, run: RunCommand) {
  return async (prNumber: number) => {
    const repositoryEndpoint = `repos/${repository}`;
    const metadata = parseRuntimeJson(
      run("gh", ["api", repositoryEndpoint]),
      repositoryEndpoint,
    );
    if (!isObject(metadata) || typeof metadata.default_branch !== "string" || metadata.default_branch.length === 0) {
      throw new Error("malformed_github_response: repository default_branch is required");
    }

    const branchEndpoint = `repos/${repository}/branches/${encodeURIComponent(metadata.default_branch)}`;
    const branch = parseRuntimeJson(
      run("gh", ["api", branchEndpoint]),
      branchEndpoint,
    );
    if (!isObject(branch) || !isObject(branch.commit)) {
      throw new Error("malformed_github_response: default branch commit is required");
    }
    const currentMainSha = exactSha(branch.commit.sha, "default branch commit sha");

    const pullEndpoint = `repos/${repository}/pulls/${prNumber}`;
    const pullRequest = parseRuntimeJson(
      run("gh", ["api", pullEndpoint]),
      pullEndpoint,
    );
    if (!isObject(pullRequest) || !isObject(pullRequest.head)) {
      throw new Error("malformed_github_response: pull request head is required");
    }
    const headSha = exactSha(pullRequest.head.sha, "pull request head sha");

    const compareEndpoint = `repos/${repository}/compare/${currentMainSha}...${headSha}`;
    const comparison = parseRuntimeJson(
      run("gh", ["api", compareEndpoint]),
      compareEndpoint,
    );
    if (!isObject(comparison)) {
      throw new Error("malformed_github_response: compare response must be an object");
    }

    const checksEndpoint = `repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=100`;
    const checkPages = parseRuntimeJson(
      run("gh", ["api", checksEndpoint, "--paginate", "--slurp"]),
      checksEndpoint,
    );
    if (!Array.isArray(checkPages) || checkPages.length === 0) {
      throw new Error("malformed_github_response: check-runs pagination must be a non-empty array of pages");
    }

    let totalCount: number | null = null;
    const runs: unknown[] = [];
    for (const page of checkPages) {
      if (!isObject(page) || !Number.isInteger(page.total_count) || (page.total_count as number) < 0 || !Array.isArray(page.check_runs)) {
        throw new Error("malformed_github_response: each check-runs page requires total_count and check_runs");
      }
      if (totalCount === null) totalCount = page.total_count as number;
      else if (page.total_count !== totalCount) {
        throw new Error("malformed_github_response: check-runs pages disagree on total_count");
      }
      runs.push(...page.check_runs);
    }
    if (runs.length !== totalCount) {
      throw new Error("incomplete_github_response: check-runs pagination is incomplete");
    }

    return {
      currentMainSha,
      pullRequest,
      compare: {
        mainSha: currentMainSha,
        headSha,
        status: comparison.status,
      },
      checkRuns: {
        complete: true,
        headSha,
        runs,
      },
    };
  };
}

function renderText(evidence: TrustedPortableCoordinatorEvidence): string {
  const lines = [
    "repo-guard portable-coordinator",
    `provider: ${evidence.provider}`,
    `kind: ${evidence.kind}`,
    `repository: ${evidence.repository ?? "unknown"}`,
    `main_sha: ${evidence.main_sha ?? "unknown"}`,
    `pr: ${evidence.pr ?? "none"}`,
    `head_sha: ${evidence.head_sha ?? "unknown"}`,
    `decision: ${evidence.decision ?? "none"}`,
    `mutation: ${evidence.mutation}`,
  ];
  if (evidence.reason !== null) lines.push(`reason: ${evidence.reason}`);
  if (evidence.error !== undefined) lines.push(`error: ${evidence.error}`);
  if (evidence.message !== undefined) lines.push(`message: ${evidence.message}`);
  return lines.join("\n");
}

function exitCode(evidence: TrustedPortableCoordinatorEvidence): number {
  if (evidence.error !== undefined) return 1;
  if (isObject(evidence.result) && evidence.result.ok === false) return 1;
  return 0;
}

export function parsePortableCoordinatorArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): PortableCoordinatorArgsResult {
  const singletons = new Map<string, string>();
  const transaction: string[] = [];
  const state: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!SINGLETON_OPTIONS.has(option) && !REPEATABLE_OPTIONS.has(option)) {
      return fail("unknown_option", `unknown portable coordinator option: ${option}`);
    }
    const value = args[++index];
    if (!nonEmpty(value) || value.startsWith("--")) {
      return fail("missing_option_value", `${option} requires a value`);
    }

    if (option === "--transaction-check") {
      transaction.push(value);
      continue;
    }
    if (option === "--state-check") {
      state.push(value);
      continue;
    }
    if (singletons.has(option)) {
      return fail("duplicate_option", `${option} may be specified only once`);
    }
    singletons.set(option, value);
  }

  const repository = singletons.get("--repository") ?? env.GITHUB_REPOSITORY;
  if (!nonEmpty(repository)) {
    return fail("missing_repository", "repository must be provided explicitly or by GITHUB_REPOSITORY");
  }
  if (!REPOSITORY.test(repository)) {
    return fail("malformed_repository", "repository identity must be owner/name");
  }

  const readyLabel = singletons.get("--ready-label");
  if (!nonEmpty(readyLabel)) {
    return fail("missing_ready_label", "READY label must be provided explicitly");
  }

  const mergeMethod = singletons.get("--merge-method");
  if (!nonEmpty(mergeMethod) || !MERGE_METHODS.has(mergeMethod as MergeMethod)) {
    return fail("invalid_merge_method", "merge method must be merge, squash, or rebase");
  }

  const transactionChecks = normalizeChecks(transaction);
  if (transactionChecks.length === 0) {
    return fail("missing_transaction_checks", "at least one transaction check is required");
  }
  const stateChecks = normalizeChecks(state);
  if (stateChecks.length === 0) {
    return fail("missing_state_checks", "at least one state check is required");
  }

  const rawFormat = singletons.get("--format") ?? "text";
  if (!FORMATS.has(rawFormat as OutputFormat)) {
    return fail("invalid_format", "format must be text or json");
  }

  return {
    ok: true,
    value: {
      repository,
      readyLabel,
      mergeMethod: mergeMethod as MergeMethod,
      requiredChecks: {
        transaction: transactionChecks,
        state: stateChecks,
      },
      format: rawFormat as OutputFormat,
    },
  };
}

export async function runPortableCoordinatorCommand(
  _roots: unknown,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  dependencies: RuntimeDependencies = {},
): Promise<number> {
  const parsed = parsePortableCoordinatorArgs(args, env);
  if (!parsed.ok) throw new Error(`${parsed.error}: ${parsed.message}`);

  const run = dependencies.run ?? defaultRun;
  const readReadyInventory = dependencies.readReadyInventory
    ?? createReadyInventoryReader(parsed.value.repository, run);
  const readCandidate = dependencies.readCandidate
    ?? createCandidateReader(parsed.value.repository, run);

  const evidence = await runTrustedPortableCoordinator({
    repository: parsed.value.repository,
    readyLabel: parsed.value.readyLabel,
    mergeMethod: parsed.value.mergeMethod,
    requiredChecks: parsed.value.requiredChecks,
    readReadyInventory,
    readCandidate,
    mutationTransport: dependencies.mutationTransport,
  });

  const output = parsed.value.format === "json"
    ? JSON.stringify(evidence)
    : renderText(evidence);
  (dependencies.writeOutput ?? console.log)(output);
  return exitCode(evidence);
}
