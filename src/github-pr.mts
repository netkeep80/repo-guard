import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getDiff, readBasePolicy, resolveRemoteBaseRef } from "./git.mjs";
import { extractChangeIntent, extractGovernanceGrant, extractLinkedIssueNumbers, resolveChangeIntent } from "./change-intent.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { loadPolicyRuntime, loadPolicyRuntimeFromObject, validationCheck } from "./runtime/validation.mjs";
import { runPolicyPipeline } from "./runtime/pipeline.mjs";
import { resolveTrustedAuthorizer } from "./trusted-authorizer.mjs";

type PolicyRuntime = ReturnType<typeof loadPolicyRuntime>;
type RuntimePolicy = PolicyRuntime["policy"];
type CheckPrRoots = Parameters<typeof loadPolicyRuntime>[0] & {
  enforcementMode?: Parameters<typeof resolveEnforcementMode>[0]["cliValue"];
};
type GovernanceGrantResult = ReturnType<typeof extractGovernanceGrant>;

interface GitHubRefProjection { sha?: unknown; ref?: unknown; }
interface GitHubPullRequestProjection {
  base?: GitHubRefProjection | null;
  head?: GitHubRefProjection | null;
  body?: unknown;
  number?: unknown;
}
interface GitHubEventProjection {
  pull_request?: GitHubPullRequestProjection | null;
  repository?: { full_name?: unknown } | null;
}
type GitHubEventResult =
  | { ok: false; error: string; message: string }
  | { ok: true; base: unknown; baseRef: unknown; head: unknown; prBody: unknown; prNumber: unknown; repoFullName: unknown };

interface ResolvePRChangeIntentInput {
  prBody: unknown;
  issueBody?: unknown;
  linkedIssueCount?: number | null;
}
interface PRFactsCommon { linkedIssues: number[]; grantResult: GovernanceGrantResult; }
type PRChangeIntentFacts =
  | ({ ok: true; changeIntent: unknown; changeIntentSource: "pr body" | "linked issue" } & PRFactsCommon)
  | ({ ok: false; error: string; message: string; changeIntentSource: "pr body" | "none" } & PRFactsCommon);
interface InitialCheck { name: string; check: unknown; }

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, ISSUE = /^[1-9][0-9]*$/;
export function loadGitHubEvent(): GitHubEventResult {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return { ok: false, error: "no_event", message: "GITHUB_EVENT_PATH not set; not running in GitHub Actions" };
  try {
    const event: unknown = JSON.parse(readFileSync(eventPath, "utf-8")), pr = (event as GitHubEventProjection).pull_request;
    if (!pr) return { ok: false, error: "not_pr_event", message: "GitHub event does not contain pull_request data" };
    return { ok: true, base: pr.base?.sha, baseRef: pr.base?.ref, head: pr.head?.sha, prBody: pr.body || "", prNumber: pr.number, repoFullName: (event as GitHubEventProjection).repository?.full_name || process.env.GITHUB_REPOSITORY || "" };
  } catch (error: unknown) { return { ok: false, error: "event_read_error", message: `Cannot read event file: ${(error as Error).message}` }; }
}
export function fetchIssueBody(repo: unknown, number: unknown): string | null {
  if (!REPO.test(repo as string) || !ISSUE.test(String(number))) return null;
  try { return execFileSync("gh", ["api", `repos/${repo as string}/issues/${number as string | number | bigint}`, "--jq", ".body"], { encoding: "utf-8", timeout: 30000 }).trim() || null; }
  catch { return null; }
}
function cliAvailable(command: string): boolean { try { execFileSync(command, ["--version"], { encoding: "utf-8", stdio: "pipe" }); return true; } catch { return false; } }
export function checkPrerequisites(): string[] {
  return [!process.env.GITHUB_EVENT_PATH && "GITHUB_EVENT_PATH env var (set automatically by GitHub Actions)", !cliAvailable("git") && "git CLI (required for diff analysis)"].filter(Boolean) as string[];
}
export const checkIssueFallbackPrerequisites = (): string[] => cliAvailable("gh") ? [] : ["gh CLI (required for linked issue fallback)"];

export function resolvePRChangeIntentFacts({ prBody, issueBody = null, linkedIssueCount = null }: ResolvePRChangeIntentInput): PRChangeIntentFacts {
  const linkedIssues = extractLinkedIssueNumbers(prBody), grantResult = extractGovernanceGrant(issueBody);
  const prResult = extractChangeIntent(prBody);
  const common = { linkedIssues, grantResult };
  if (prResult.ok) return { ok: true, changeIntent: prResult.changeIntent, changeIntentSource: "pr body", ...common };
  if (prResult.error !== "change_intent_not_found") return { ok: false, error: prResult.error, message: prResult.message, changeIntentSource: "pr body", ...common };
  const count = linkedIssueCount ?? linkedIssues.length;
  if (count > 1) return { ok: false, error: "issue_link_ambiguous", message: `PR body references ${count} issues (${linkedIssues.map((n) => `#${n}`).join(", ")}); expected exactly one`, changeIntentSource: "none", ...common };
  const issueResult = resolveChangeIntent(prBody, issueBody);
  return issueResult.ok
    ? { ok: true, changeIntent: issueResult.changeIntent, changeIntentSource: "linked issue", ...common }
    : { ok: false, error: issueResult.error, message: issueResult.message, changeIntentSource: "none", ...common };
}

function loadRuntime(load: () => PolicyRuntime, label: string, failure: string): PolicyRuntime | null {
  try { const runtime = load(); if (runtime.ok) return runtime; }
  catch (error: unknown) { console.error(`FAIL: ${label}\n  ${(error as Error).message}`); }
  console.error(`\n${failure}`); return null;
}
function printMissing(title: string, missing: readonly string[]) { console.error(title); for (const item of missing) console.error(`  - ${item}`); }
function fetchLinkedIssue({ prBody, repoFullName }: { prBody: unknown; repoFullName: unknown }) {
  const linkedIssues = extractLinkedIssueNumbers(prBody), pr = extractChangeIntent(prBody);
  const hasChangeIntent = pr.ok, needsFallback = !hasChangeIntent && pr.error === "change_intent_not_found" && linkedIssues.length === 1;
  if (linkedIssues.length !== 1 || (!needsFallback && !hasChangeIntent)) return { linkedIssues, issueBody: null, fatal: false };
  console.log(needsFallback ? `No ChangeIntent in PR body; trying linked issue #${linkedIssues[0]}...` : `Fetching linked issue #${linkedIssues[0]} for GovernanceGrant...`);
  const missing = checkIssueFallbackPrerequisites();
  if (missing.length) {
    if (needsFallback) { printMissing("ERROR: linked issue fallback prerequisites not met:", missing); return { linkedIssues, issueBody: null, fatal: true }; }
    console.warn("WARN: linked issue lookup unavailable; GovernanceGrant cannot be established"); return { linkedIssues, issueBody: null, fatal: false };
  }
  const issueBody = fetchIssueBody(repoFullName, linkedIssues[0]);
  if (issueBody === null && hasChangeIntent) console.warn(`WARN: could not fetch linked issue #${linkedIssues[0]}; GovernanceGrant unavailable`);
  return { linkedIssues, issueBody, fatal: false };
}

export function runCheckPR(roots: CheckPrRoots, args: string[] = []) {
  if (args.length) { console.error(`Unexpected argument for check-pr: ${args[0]}`); return 1; }
  const prereqs = checkPrerequisites();
  if (prereqs.length) { printMissing("ERROR: check-pr prerequisites not met:", prereqs); return 1; }
  const event = loadGitHubEvent();
  if (!event.ok) { console.error(`ERROR: ${event.message}`); return 1; }
  const { base: eventBase, baseRef, head, prBody, prNumber, repoFullName } = event;
  if (!eventBase || !head) { console.error("ERROR: pull_request event missing base/head SHA"); return 1; }

  let base = eventBase as string;
  if (baseRef) {
    try { base = resolveRemoteBaseRef(baseRef, roots.repoRoot); }
    catch (error: unknown) { console.error(`ERROR: cannot resolve current PR base ref ${baseRef as string}: ${(error as Error).message}`); return 1; }
    if (base !== eventBase) console.log(`Base ref ${baseRef as string} advanced from event snapshot ${(eventBase as string).slice(0, 7)} to ${base.slice(0, 7)}; using current base`);
  }
  console.log(`PR #${prNumber as string | number}: checking ChangeIntent and diff (${base.slice(0, 7)}..${(head as string).slice(0, 7)})`);

  const headRuntime = loadRuntime(() => loadPolicyRuntime(roots, { label: "repo-policy.json (PR head)" }), "repo-policy.json (PR head)", "Proposed policy compilation failed");
  if (!headRuntime) return 1;
  const initialChecks: InitialCheck[] = [], baseRead = readBasePolicy(base, roots.repoRoot);
  let runtime = headRuntime, basePolicy: RuntimePolicy | null = null, trustedGovernancePaths: unknown = [];
  if (baseRead.error) initialChecks.push({ name: "governance-trusted-boundary", check: { ok: false, message: `cannot establish trusted governance boundary: ${baseRead.error}`, details: [`base_ref: ${base}`] } });
  else {
    runtime = loadRuntime(() => loadPolicyRuntimeFromObject(roots, baseRead.policy, { label: "repo-policy.json (base)" }), "repo-policy.json (base)", "Base policy compilation failed") as PolicyRuntime;
    if (!runtime) return 1;
    basePolicy = runtime.policy; trustedGovernancePaths = (basePolicy as RuntimePolicy & { paths?: { governance_paths?: unknown } }).paths?.governance_paths ?? [];
  }

  const { ajv, policy, changeIntentSchema, governanceGrantSchema } = runtime;
  const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy } as Parameters<typeof resolveEnforcementMode>[0]);
  if (!enforcement.ok) { console.error(`ERROR: ${enforcement.message}`); return 1; }
  const linked = fetchLinkedIssue({ prBody, repoFullName });
  if (linked.fatal) return 1;
  const { linkedIssues, issueBody } = linked;
  let resolved = resolvePRChangeIntentFacts({ prBody, issueBody });
  if (!resolved.ok && resolved.linkedIssues.length === 1 && issueBody === null && resolved.error !== "issue_link_ambiguous") resolved = { ...resolved, error: "issue_fetch_failed", message: `Could not fetch issue #${resolved.linkedIssues[0]} body` };

  let changeIntent: unknown = null, changeIntentSource = resolved.changeIntentSource || "none";
  if (!resolved.ok) initialChecks.push({ name: "change-intent", check: { ok: false, message: `[${resolved.error}]: ${resolved.message}` } });
  else {
    const check = validationCheck(ajv, changeIntentSchema, resolved.changeIntent, "change-intent (from markdown)");
    initialChecks.push({ name: "change-intent", check });
    if (check.ok) changeIntent = resolved.changeIntent;
  }

  let governanceGrant: unknown = null;
  if (resolved.grantResult && !resolved.grantResult.ok) initialChecks.push({ name: "governance-grant", check: { ok: false, message: `[${resolved.grantResult.error}]: ${resolved.grantResult.message}` } });
  else if ((resolved.grantResult as { grant?: unknown } | null | undefined)?.grant) {
    const check = validationCheck(ajv, governanceGrantSchema, (resolved.grantResult as { grant?: unknown }).grant, "governance-grant (linked issue)");
    initialChecks.push({ name: "governance-grant", check });
    if (check.ok) governanceGrant = (resolved.grantResult as { grant?: unknown }).grant;
  }

  let diffText: string;
  try { diffText = getDiff(base, head as string, roots.repoRoot); }
  catch (error: unknown) { console.error(`ERROR: ${(error as Error).message}`); return 1; }
  let trustedAuthorizer: ReturnType<typeof resolveTrustedAuthorizer> | null = null;
  if (basePolicy && repoFullName) try { trustedAuthorizer = resolveTrustedAuthorizer({ repoFullName, issueNumber: linkedIssues.length === 1 ? linkedIssues[0] : null, prNumber }); } catch {}

  return runPolicyPipeline({
    mode: "check-pr", repositoryRoot: roots.repoRoot, policy, basePolicy, headPolicy: headRuntime.policy,
    changeIntent, changeIntentSource, governanceGrant, trustedGovernancePaths, trustedAuthorizer, enforcement, diffText, initialChecks,
  } as Parameters<typeof runPolicyPipeline>[0]).exitCode;
}
