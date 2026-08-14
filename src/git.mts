import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

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

export interface BaseGovernancePathsResult {
  governancePaths: unknown[] | null;
  error: string | null;
}

function childProcessMessage(error: unknown): string {
  const failure = error as ChildProcessFailure | null | undefined;
  const stderr = failure?.stderr?.toString?.().trim();
  if (stderr) return stderr;
  const stdout = failure?.stdout?.toString?.().trim();
  if (stdout) return stdout;
  return failure?.message || "command failed";
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

function diffArgs(...args: string[]): string[] {
  return ["-c", "core.quotepath=false", "diff", ...args];
}

export function getDiff(base: string | null | undefined, head: string | null | undefined, cwd: string): string {
  if (base && head) {
    return runGit(diffArgs(`${base}...${head}`), { cwd });
  }
  const staged = runGit(diffArgs("--cached"), { cwd });
  if (staged.trim()) return staged;
  return runGit(diffArgs("HEAD"), { cwd });
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

function governancePathsFromPolicy(policy: unknown): unknown {
  if (policy === null || typeof policy !== "object") return undefined;
  const paths = (policy as Record<string, unknown>).paths;
  if (paths === null || typeof paths !== "object") return undefined;
  return (paths as Record<string, unknown>).governance_paths;
}

export function readBaseGovernancePaths(base: string | null | undefined, cwd: string, policyPath = "repo-policy.json"): BaseGovernancePathsResult {
  const result = readBasePolicy(base, cwd, policyPath);
  if (result.error) return { governancePaths: null, error: result.error };
  const list = governancePathsFromPolicy(result.policy);
  if (!Array.isArray(list)) return { governancePaths: [], error: null };
  return { governancePaths: list, error: null };
}
