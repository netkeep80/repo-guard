import { execFileSync } from "node:child_process";
import type { ParallelReadinessProvider } from "./parallel-readiness.mjs";

type Failure = { ok: false; error: string; message: string };
type AdapterError = { id: string; message: string };
type RunCommand = (command: string, args: string[], options?: { cwd?: string }) => string;
type RepositoryOwnerType = "User" | "Organization";

type BranchProtectionEnvelope = {
  complete: boolean;
  protected: boolean | null;
  data: Record<string, unknown> | null;
};

type ActiveBranchRulesEnvelope = {
  complete: boolean;
  rules: unknown[] | null;
};

type RulesetsEnvelope = {
  complete: boolean;
  items: unknown[] | null;
};

export type GitHubControlPlaneReadResult = Failure | {
  ok: true;
  provider: ParallelReadinessProvider;
  repository: string;
  repositoryOwnerType: RepositoryOwnerType | null;
  defaultBranch: string;
  branchProtection: BranchProtectionEnvelope;
  activeBranchRules: ActiveBranchRulesEnvelope;
  rulesets: RulesetsEnvelope;
  errors: AdapterError[];
};

interface ReadInput {
  repoRoot: string;
  provider: ParallelReadinessProvider;
  env?: Record<string, string | undefined>;
  run?: RunCommand;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PARALLEL_RULE_TYPES = new Set(["pull_request", "required_status_checks", "merge_queue"]);

function fail(error: string, message: string): Failure {
  return { ok: false, error, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultRun(command: string, args: string[], options: { cwd?: string } = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 30000,
  });
}

function errorText(error: unknown): string {
  if (!isRecord(error)) return String(error);
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const message = typeof error.message === "string" ? error.message.trim() : "";
  return [stderr, message].filter(Boolean).join("\n") || "unknown command failure";
}

function parseJson(text: string, label: string): { ok: true; value: unknown } | Failure {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (error: unknown) { return fail("malformed_github_response", `${label}: ${(error as Error).message}`); }
}

function repositoryFromRemote(remote: string): string | null {
  const value = remote.trim();
  for (const pattern of [
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  ]) {
    const match = pattern.exec(value);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

function resolveRepository(input: ReadInput, run: RunCommand): { ok: true; repository: string } | Failure {
  const fromEnv = input.env?.GITHUB_REPOSITORY;
  if (fromEnv !== undefined) {
    if (!REPOSITORY.test(fromEnv)) return fail("invalid_repository", "GITHUB_REPOSITORY must use owner/name form");
    return { ok: true, repository: fromEnv };
  }
  try {
    const repository = repositoryFromRemote(run("git", ["remote", "get-url", "origin"], { cwd: input.repoRoot }));
    return repository ? { ok: true, repository } : fail("repository_not_resolved", "origin must be a github.com owner/name repository");
  } catch (error: unknown) {
    return fail("repository_not_resolved", `cannot read origin: ${errorText(error)}`);
  }
}

function apiJson(run: RunCommand, repoRoot: string, endpoint: string, extraArgs: string[] = []) {
  try {
    const parsed = parseJson(run("gh", ["api", endpoint, ...extraArgs], { cwd: repoRoot }), endpoint);
    return parsed.ok ? parsed : parsed;
  } catch (error: unknown) {
    return fail("github_api_error", errorText(error));
  }
}

function readBranchProtection(run: RunCommand, repoRoot: string, repository: string, branch: string, errors: AdapterError[]): BranchProtectionEnvelope {
  const endpoint = `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`;
  try {
    const parsed = parseJson(run("gh", ["api", endpoint], { cwd: repoRoot }), endpoint);
    if (!parsed.ok || !isRecord(parsed.value)) {
      errors.push({ id: "branch_protection_api_error", message: parsed.ok ? "branch protection response must be an object" : parsed.message });
      return { complete: false, protected: null, data: null };
    }
    return { complete: true, protected: true, data: parsed.value };
  } catch (error: unknown) {
    const text = errorText(error);
    if (/Branch not protected/i.test(text) && /404/.test(text)) return { complete: true, protected: false, data: null };
    errors.push({ id: "branch_protection_api_error", message: text });
    return { complete: false, protected: null, data: null };
  }
}

function readActiveRules(run: RunCommand, repoRoot: string, repository: string, branch: string, errors: AdapterError[]): ActiveBranchRulesEnvelope {
  const endpoint = `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`;
  const response = apiJson(run, repoRoot, endpoint, ["--paginate", "--slurp"]);
  if (!response.ok) {
    errors.push({ id: "active_branch_rules_api_error", message: response.message });
    return { complete: false, rules: null };
  }
  if (!Array.isArray(response.value)) {
    errors.push({ id: "active_branch_rules_api_error", message: "active branch rules response must be an array" });
    return { complete: false, rules: null };
  }
  const pages = response.value;
  if (pages.every(Array.isArray)) return { complete: true, rules: (pages as unknown[][]).flat() };
  return { complete: true, rules: pages };
}

function activeRulesetIds(rules: unknown[]): number[] {
  const ids = new Set<number>();
  for (const rule of rules) {
    if (!isRecord(rule) || !PARALLEL_RULE_TYPES.has(rule.type as string)) continue;
    if (Number.isInteger(rule.ruleset_id) && (rule.ruleset_id as number) >= 0) ids.add(rule.ruleset_id as number);
  }
  return [...ids].sort((left, right) => left - right);
}

function readRulesets(run: RunCommand, repoRoot: string, repository: string, activeRules: ActiveBranchRulesEnvelope, errors: AdapterError[]): RulesetsEnvelope {
  if (!activeRules.complete || !activeRules.rules) return { complete: false, items: null };
  const ids = activeRulesetIds(activeRules.rules);
  const items: unknown[] = [];
  let complete = true;
  for (const id of ids) {
    const response = apiJson(run, repoRoot, `repos/${repository}/rulesets/${id}`);
    if (!response.ok) {
      complete = false;
      errors.push({ id: "ruleset_api_error", message: `ruleset ${id}: ${response.message}` });
      continue;
    }
    items.push(response.value);
  }
  return { complete, items: complete ? items : items };
}

function repositoryOwnerType(metadata: Record<string, unknown>): RepositoryOwnerType | null {
  const owner = metadata.owner;
  if (!isRecord(owner)) return null;
  return owner.type === "User" || owner.type === "Organization" ? owner.type : null;
}

export function readGitHubControlPlane(input: ReadInput): GitHubControlPlaneReadResult {
  if (input.provider !== "portable" && input.provider !== "github_merge_queue") {
    return fail("invalid_provider", "provider must be portable or github_merge_queue");
  }
  if (typeof input.repoRoot !== "string" || input.repoRoot.length === 0) return fail("invalid_repo_root", "repoRoot must be a non-empty string");
  const run = input.run ?? defaultRun;
  const repositoryResult = resolveRepository({ ...input, env: input.env ?? process.env }, run);
  if (!repositoryResult.ok) return repositoryResult;
  const repository = repositoryResult.repository;

  const metadata = apiJson(run, input.repoRoot, `repos/${repository}`);
  if (!metadata.ok) return fail("repository_metadata_api_error", metadata.message);
  if (!isRecord(metadata.value) || typeof metadata.value.default_branch !== "string" || metadata.value.default_branch.length === 0) {
    return fail("repository_metadata_malformed", "repository metadata must contain default_branch");
  }
  const defaultBranch = metadata.value.default_branch;
  const ownerType = repositoryOwnerType(metadata.value);
  const errors: AdapterError[] = [];
  const branchProtection = readBranchProtection(run, input.repoRoot, repository, defaultBranch, errors);
  const activeBranchRules = readActiveRules(run, input.repoRoot, repository, defaultBranch, errors);
  const rulesets = readRulesets(run, input.repoRoot, repository, activeBranchRules, errors);

  return {
    ok: true,
    provider: input.provider,
    repository,
    repositoryOwnerType: ownerType,
    defaultBranch,
    branchProtection,
    activeBranchRules,
    rulesets,
    errors,
  };
}
