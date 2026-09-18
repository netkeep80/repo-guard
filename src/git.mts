import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { parseMachineDiff, type ParsedDiffFile } from "./diff/parser.mjs";

interface ChildProcessFailure {
  stderr?: { toString?: () => string } | null;
  stdout?: { toString?: () => string } | null;
  message?: string;
}

export interface RunGitOptions {
  cwd?: string;
  stdio?: ExecFileSyncOptionsWithStringEncoding["stdio"];
}

export interface BasePolicyReadResult {
  policy: unknown | null;
  error: string | null;
}

export interface GitDiffObservation {
  diffText: string;
  files: ParsedDiffFile[];
}

export interface PullRequestObservationInput {
  repository: string;
  baseRef?: string | null;
  eventBaseSha: string;
  headSha: string;
  cwd: string;
  remote?: string;
}

export interface RepositoryObservation {
  contract: "exact_head";
  repository: string;
  source: "github_pull_request";
  observed_at: string;
  base: {
    ref: string | null;
    event_sha: string;
    sha: string;
    tree_sha: string;
    advanced_since_event: boolean;
  };
  merge_base: { sha: string; tree_sha: string };
  head: { sha: string; tree_sha: string };
  evaluated: { commit_sha: string; tree_sha: string };
  checkout: {
    commit_sha: string;
    tree_sha: string;
    matches_head: boolean;
    dirty: boolean;
  };
  cache_key: string;
}

function childProcessMessage(error: unknown): string {
  const stderr = (error as ChildProcessFailure | null | undefined)?.stderr?.toString?.().trim();
  if (stderr) return stderr;
  const stdout = (error as ChildProcessFailure | null | undefined)?.stdout?.toString?.().trim();
  if (stdout) return stdout;
  return (error as ChildProcessFailure | null | undefined)?.message || "command failed";
}

function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") {
      i++;
      continue;
    }
    if (!args[i]!.startsWith("-")) return args[i]!;
  }
  return "";
}

export function runGit(args: string[], options: RunGitOptions = {}): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      cwd: options.cwd,
      stdio: options.stdio || "pipe",
    });
  } catch (error) {
    const command = gitSubcommand(args);
    const subcommand = command ? ` ${command}` : "";
    throw new Error(`git${subcommand} failed: ${childProcessMessage(error)}`);
  }
}

function exactCommit(ref: string, cwd: string, label: string): string {
  try {
    const sha = runGit(["rev-parse", "--verify", `${ref}^{commit}`], { cwd }).trim();
    if (!sha) throw new Error("empty object id");
    return sha;
  } catch (error: unknown) {
    throw new Error(`repository observation failed: cannot resolve ${label}: ${(error as Error).message}`);
  }
}

function exactTree(ref: string, cwd: string, label: string): string {
  try {
    const sha = runGit(["rev-parse", "--verify", `${ref}^{tree}`], { cwd }).trim();
    if (!sha) throw new Error("empty tree id");
    return sha;
  } catch (error: unknown) {
    throw new Error(`repository observation failed: cannot resolve ${label} tree: ${(error as Error).message}`);
  }
}

function refreshRemoteBaseRef(baseRef: string, cwd: string, remote: string): void {
  try {
    runGit(["check-ref-format", "--branch", baseRef], { cwd });
    runGit(["fetch", "--no-tags", "--prune", remote, `+refs/heads/${baseRef}:refs/remotes/${remote}/${baseRef}`], { cwd });
  } catch (error: unknown) {
    throw new Error(`repository observation failed: cannot refresh base ${remote}/${baseRef}: ${(error as Error).message}`);
  }
}

export function resolveRemoteBaseRef(baseRef: unknown, cwd: string, remote = "origin"): string {
  if (typeof baseRef !== "string" || baseRef.length === 0) {
    throw new Error("missing PR base ref");
  }
  const ref = `refs/remotes/${remote}/${baseRef}`;
  const sha = runGit(["rev-parse", "--verify", `${ref}^{commit}`], { cwd }).trim();
  if (!sha) {
    throw new Error(`current base ref ${ref} resolved to an empty object id`);
  }
  return sha;
}

export function listTrackedFilesAtRef(ref: string, cwd: string): string[] {
  const output = runGit(["ls-tree", "-r", "-z", "--name-only", ref], { cwd });
  return output.split("\0").filter(Boolean);
}

export function acquirePullRequestObservation(input: PullRequestObservationInput): RepositoryObservation {
  const remote = input.remote || "origin";
  if (!input.repository) throw new Error("repository observation failed: missing repository identity");
  if (!input.eventBaseSha) throw new Error("repository observation failed: missing event base SHA");
  if (!input.headSha) throw new Error("repository observation failed: missing PR head SHA");

  const eventBase = exactCommit(input.eventBaseSha, input.cwd, "event BASE");
  if (input.baseRef) refreshRemoteBaseRef(input.baseRef, input.cwd, remote);
  const base = input.baseRef
    ? exactCommit(`refs/remotes/${remote}/${input.baseRef}`, input.cwd, "current BASE")
    : eventBase;
  const head = exactCommit(input.headSha, input.cwd, "PR HEAD");

  let mergeBase: string;
  try {
    mergeBase = runGit(["merge-base", base, head], { cwd: input.cwd }).trim();
  } catch {
    throw new Error("repository observation failed: missing merge base");
  }
  if (!mergeBase) throw new Error("repository observation failed: missing merge base");

  const baseTree = exactTree(base, input.cwd, "BASE");
  const mergeBaseTree = exactTree(mergeBase, input.cwd, "merge base");
  const headTree = exactTree(head, input.cwd, "PR HEAD");
  const checkoutCommit = exactCommit("HEAD", input.cwd, "checkout HEAD");
  const checkoutTree = exactTree(checkoutCommit, input.cwd, "checkout");
  let dirty: boolean;
  try {
    dirty = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: input.cwd }).length > 0;
  } catch (error: unknown) {
    throw new Error(`repository observation failed: cannot inspect checkout state: ${(error as Error).message}`);
  }

  return {
    contract: "exact_head",
    repository: input.repository,
    source: "github_pull_request",
    observed_at: new Date().toISOString(),
    base: {
      ref: input.baseRef || null,
      event_sha: eventBase,
      sha: base,
      tree_sha: baseTree,
      advanced_since_event: base !== eventBase,
    },
    merge_base: { sha: mergeBase, tree_sha: mergeBaseTree },
    head: { sha: head, tree_sha: headTree },
    evaluated: { commit_sha: head, tree_sha: headTree },
    checkout: {
      commit_sha: checkoutCommit,
      tree_sha: checkoutTree,
      matches_head: checkoutCommit === head,
      dirty,
    },
    cache_key: `${input.repository}:${headTree}`,
  };
}

function diffArgs(...args: string[]): string[] {
  return ["-c", "core.quotepath=false", "diff", ...args];
}

function selectedDiffOperands(base: string | null | undefined, head: string | null | undefined, cwd: string): string[] {
  if (base && head) return [`${base}...${head}`];
  const staged = runGit(diffArgs("--cached"), { cwd });
  return staged.trim() ? ["--cached"] : ["HEAD"];
}

export function getDiff(base: string | null | undefined, head: string | null | undefined, cwd: string): string {
  if (base && head) {
    return runGit(diffArgs(`${base}...${head}`), { cwd });
  }
  const staged = runGit(diffArgs("--cached"), { cwd });
  if (staged.trim()) return staged;
  return runGit(diffArgs("HEAD"), { cwd });
}

export function getDiffObservation(base: string | null | undefined, head: string | null | undefined, cwd: string): GitDiffObservation {
  const operands = selectedDiffOperands(base, head, cwd);
  const diffText = runGit(diffArgs(...operands), { cwd });
  const nameStatusZ = runGit(["diff", "--name-status", "-z", ...operands], { cwd });
  return { diffText, files: parseMachineDiff(diffText, nameStatusZ) };
}

export function readFileAtRef(ref: string | null | undefined, path: string | null | undefined, cwd: string): string | null {
  if (!ref || !path) return null;
  return runGit(["show", `${ref}:${path}`], { cwd });
}

export function readBasePolicy(base: string | null | undefined, cwd: string, policyPath = "repo-policy.json"): BasePolicyReadResult {
  if (!base) return { policy: null, error: "no_base_ref" };
  let raw: string | null;
  try {
    raw = readFileAtRef(base, policyPath, cwd);
  } catch (e) {
    return { policy: null, error: `git_show_failed: ${(e as Error).message}` };
  }
  if (raw == null) return { policy: null, error: "empty_base_policy" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { policy: null, error: `base_policy_parse_error: ${(e as Error).message}` };
  }
  return { policy: parsed, error: null };
}

