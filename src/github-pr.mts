import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { parseJson, parseYaml } from "./document-facts.mjs";
import { acquirePullRequestObservation, getDiffObservation, listTrackedFilesAtRef, readFileAtRef, type RepositoryObservation } from "./git.mjs";
import { createImmutableSnapshotDocumentCache } from "./immutable-snapshot-cache.mjs";
import { extractChangeIntent, extractGovernanceGrant, extractLinkedIssueNumbers, extractLinkedIssueReferences, resolveChangeIntent } from "./change-intent.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { loadPolicyRuntimeFromObject, validationCheck } from "./runtime/validation.mjs";
import { evaluatePolicyPipeline } from "./runtime/pipeline.mjs";
import { createAnalysisCollector } from "./runtime/analysis-report.mjs";
import { createAnalysisTextPresenter, renderAnalysisReport } from "./reporting/renderers.mjs";
import { fetchIssueAuthorContext, resolveTrustedAuthorizer } from "./trusted-authorizer.mjs";

type PolicyRuntime = ReturnType<typeof loadPolicyRuntimeFromObject>;
type RuntimePolicy = PolicyRuntime["policy"];
type CheckPrRoots = Parameters<typeof loadPolicyRuntimeFromObject>[0] & { enforcementMode?: Parameters<typeof resolveEnforcementMode>[0]["cliValue"] };
type GovernanceGrantResult = ReturnType<typeof extractGovernanceGrant>;
type Format = "text" | "json" | "summary";
type SnapshotReader = (ref: string, path: string) => string | null;
type PipelineInput = Parameters<typeof evaluatePolicyPipeline>[0];
type PipelineOptions = Parameters<typeof evaluatePolicyPipeline>[1];
interface GitHubRefProjection { sha?: unknown; ref?: unknown; }
interface GitHubPullRequestProjection { base?: GitHubRefProjection | null; head?: GitHubRefProjection | null; body?: unknown; number?: unknown; }
interface GitHubEventProjection { pull_request?: GitHubPullRequestProjection | null; repository?: { full_name?: unknown } | null; }
type GitHubEventResult = { ok: false; error: string; message: string } | { ok: true; base: unknown; baseRef: unknown; head: unknown; prBody: unknown; prNumber: unknown; repoFullName: unknown };
interface ResolvePRChangeIntentInput { prBody: unknown; issueBody?: unknown; linkedIssueCount?: number | null; }
interface PRFactsCommon { linkedIssues: number[]; grantResult: GovernanceGrantResult; }
type PRChangeIntentFacts = ({ ok: true; changeIntent: unknown; changeIntentSource: "pr body" | "linked issue" } & PRFactsCommon) | ({ ok: false; error: string; message: string; changeIntentSource: "pr body" | "none" } & PRFactsCommon);
interface InitialCheck { name: string; check: unknown; }

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, ISSUE = /^[1-9][0-9]*$/;
const PROPOSED_POLICY_EXCLUDED_FAMILIES = ["governance-paths", "policy-delta"] as const;

function githubEventPath(): string | undefined { return process.env.RG_EVENT_PATH || process.env.GITHUB_EVENT_PATH; }
export function loadGitHubEvent(): GitHubEventResult {
  const eventPath = githubEventPath();
  if (!eventPath) return { ok: false, error: "no_event", message: "GITHUB_EVENT_PATH not set; not running in GitHub Actions" };
  try {
    const event: unknown = JSON.parse(readFileSync(eventPath, "utf-8")), pr = (event as GitHubEventProjection).pull_request;
    if (!pr) return { ok: false, error: "not_pr_event", message: "GitHub event does not contain pull_request data" };
    return { ok: true, base: pr.base?.sha, baseRef: pr.base?.ref, head: pr.head?.sha, prBody: pr.body || "", prNumber: pr.number, repoFullName: (event as GitHubEventProjection).repository?.full_name || process.env.GITHUB_REPOSITORY || "" };
  } catch (error: unknown) { return { ok: false, error: "event_read_error", message: `Cannot read event file: ${(error as Error).message}` }; }
}
function cliAvailable(command: string): boolean { try { execFileSync(command, ["--version"], { encoding: "utf-8", stdio: "pipe" }); return true; } catch { return false; } }
export function checkPrerequisites(): string[] { return [!githubEventPath() && "RG_EVENT_PATH/GITHUB_EVENT_PATH event file", !cliAvailable("git") && "git CLI (required for diff analysis)"].filter(Boolean) as string[]; }
export const checkIssueFallbackPrerequisites = (): string[] => cliAvailable("gh") ? [] : ["gh CLI (required for linked issue fallback)"];

export function resolvePRChangeIntentFacts({ prBody, issueBody = null, linkedIssueCount = null }: ResolvePRChangeIntentInput): PRChangeIntentFacts {
  const linkedIssues = extractLinkedIssueNumbers(prBody), grantResult = extractGovernanceGrant(issueBody), prResult = extractChangeIntent(prBody), common = { linkedIssues, grantResult };
  if (prResult.ok) return { ok: true, changeIntent: prResult.changeIntent, changeIntentSource: "pr body", ...common };
  if (prResult.error !== "change_intent_not_found") return { ok: false, error: prResult.error, message: prResult.message, changeIntentSource: "pr body", ...common };
  const count = linkedIssueCount ?? linkedIssues.length;
  if (count > 1) return { ok: false, error: "issue_link_ambiguous", message: `PR body references ${count} issues (${linkedIssues.map((n) => `#${n}`).join(", ")}); expected exactly one`, changeIntentSource: "none", ...common };
  const issueResult = resolveChangeIntent(prBody, issueBody);
  return issueResult.ok ? { ok: true, changeIntent: issueResult.changeIntent, changeIntentSource: "linked issue", ...common } : { ok: false, error: issueResult.error, message: issueResult.message, changeIntentSource: "none", ...common };
}

function loadRuntime(load: () => PolicyRuntime, label: string, failure: string): PolicyRuntime | null {
  try { const runtime = load(); if (runtime.ok) return runtime; } catch (error: unknown) { console.error(`FAIL: ${label}\n  ${(error as Error).message}`); }
  console.error(`\n${failure}`); return null;
}
function printMissing(title: string, missing: readonly string[]) { console.error(title); for (const item of missing) console.error(`  - ${item}`); }
function fetchLinkedIssue({ prBody, repoFullName, quiet = false }: { prBody: unknown; repoFullName: unknown; quiet?: boolean }) {
  const repository = typeof repoFullName === "string" ? repoFullName : "", references = extractLinkedIssueReferences(prBody, repository);
  const local = references.filter((reference) => reference.repository.toLowerCase() === repository.toLowerCase()), foreign = references.filter((reference) => reference.repository.toLowerCase() !== repository.toLowerCase());
  const linkedIssues = local.map((reference) => reference.number), pr = extractChangeIntent(prBody), hasChangeIntent = pr.ok, needsFallback = !hasChangeIntent && pr.error === "change_intent_not_found";
  if (foreign.length && needsFallback) { console.error(`ERROR: linked issue fallback must belong to ${repository}; refusing ${foreign.map((reference) => `${reference.repository}#${reference.number}`).join(", ")}`); return { linkedIssues, issueBody: null, issueContext: null, fatal: true }; }
  if (local.length !== 1 || (!needsFallback && !hasChangeIntent)) { if (foreign.length && hasChangeIntent) console.warn("WARN: cross-repository closing references are not eligible GovernanceGrant sources"); return { linkedIssues, issueBody: null, issueContext: null, fatal: false }; }
  if (!quiet) console.log(needsFallback ? `No ChangeIntent in PR body; trying linked issue #${linkedIssues[0]}...` : `Fetching linked issue #${linkedIssues[0]} for GovernanceGrant...`);
  const missing = checkIssueFallbackPrerequisites();
  if (missing.length) {
    if (needsFallback) { printMissing("ERROR: linked issue fallback prerequisites not met:", missing); return { linkedIssues, issueBody: null, issueContext: null, fatal: true }; }
    console.warn("WARN: linked issue lookup unavailable; GovernanceGrant cannot be established"); return { linkedIssues, issueBody: null, issueContext: null, fatal: false };
  }
  const issueContext = fetchIssueAuthorContext(repository, linkedIssues[0]), observedBody = (issueContext as { body?: unknown } | null)?.body, issueBody = typeof observedBody === "string" ? observedBody : null;
  if (issueBody === null && hasChangeIntent) console.warn(`WARN: could not fetch linked issue #${linkedIssues[0]}; GovernanceGrant unavailable`);
  return { linkedIssues, issueBody, issueContext, fatal: false };
}
export function memoizeSnapshotReader(read: SnapshotReader): SnapshotReader {
  const reads = new Map<string, string | null>();
  return (ref, path) => { const key = `${ref}\0${path}`; if (!reads.has(key)) reads.set(key, read(ref, path)); return reads.get(key)!; };
}
function policyAt(reader: SnapshotReader, ref: string) {
  try { const raw = reader(ref, "repo-policy.json"); return raw == null ? { policy: null, error: "empty_base_policy" } : { policy: JSON.parse(raw), error: null }; }
  catch (error: unknown) { return { policy: null, error: `base_policy_read_error: ${(error as Error).message}` }; }
}
function headPolicyRuntime(roots: CheckPrRoots, observation: RepositoryObservation, reader: SnapshotReader, quiet: boolean): PolicyRuntime | null {
  return loadRuntime(() => {
    const raw = reader(observation.evaluated.commit_sha, "repo-policy.json");
    if (raw == null) throw new Error("repo-policy.json is unavailable at exact PR head");
    return loadPolicyRuntimeFromObject(roots, JSON.parse(raw), { label: "repo-policy.json (PR head)", quiet });
  }, "repo-policy.json (PR head)", "Proposed policy compilation failed");
}
function formatOf(args: string[]): Format | null {
  if (!args.length) return "text";
  return args.length === 2 && args[0] === "--format" && ["text", "json", "summary"].includes(args[1]) ? args[1] as Format : null;
}
function fail(roots: CheckPrRoots, format: Format, reasonCode: string, message: string) {
  if (format === "text") { console.error(`ERROR: ${message}`); return 1; }
  const report = { command: "check-pr", mode: roots.enforcementMode || "blocking", ok: false, result: "error", passed: 0, violations: [], advisoryWarnings: [], warnings: 0, violationCount: 0, failed: 1, exitCode: 1, ruleResults: [], hints: [], repositoryRoot: roots.repoRoot, reasonCode, message };
  console.log(renderAnalysisReport(report, { format })); return 1;
}

export function runCheckPR(roots: CheckPrRoots, args: string[] = []) {
  const format = formatOf(args);
  if (!format) { console.error(`Unexpected argument for check-pr: ${args[0] || ""}`); return 1; }
  const quiet = format !== "text", prereqs = checkPrerequisites();
  if (prereqs.length) return fail(roots, format, "check_pr.prerequisites", prereqs.join("; "));
  const event = loadGitHubEvent();
  if (!event.ok) return fail(roots, format, `check_pr.${event.error}`, event.message);
  const { base: eventBase, baseRef, head, prBody, prNumber, repoFullName } = event;
  if (!eventBase || !head) return fail(roots, format, "check_pr.missing_ref", "pull_request event missing base/head SHA");

  let observation: RepositoryObservation;
  try { observation = acquirePullRequestObservation({ repository: typeof repoFullName === "string" ? repoFullName : "", baseRef: typeof baseRef === "string" && baseRef ? baseRef : null, eventBaseSha: eventBase as string, headSha: head as string, cwd: roots.repoRoot }); }
  catch (error: unknown) { return fail(roots, format, "check_pr.repository_observation", (error as Error).message); }
  const base = observation.base.sha, exactHead = observation.head.sha;
  if (!quiet) {
    if (observation.base.advanced_since_event) console.log(`Base ref ${String(observation.base.ref)} advanced from event snapshot ${observation.base.event_sha.slice(0, 7)} to ${base.slice(0, 7)}; using current base`);
    console.log(`PR #${prNumber as string | number}: checking ChangeIntent and diff (${base.slice(0, 7)}...${exactHead.slice(0, 7)}, merge-base ${observation.merge_base.sha.slice(0, 7)})`);
    console.log(`Repository observation: exact-head T=${observation.evaluated.commit_sha.slice(0, 7)} tree=${observation.evaluated.tree_sha.slice(0, 7)}, checkout=${observation.checkout.commit_sha.slice(0, 7)}${observation.checkout.matches_head ? "" : " (not H)"}${observation.checkout.dirty ? " dirty" : ""}`);
  }
  const snapshotDocuments = createImmutableSnapshotDocumentCache({
    readFileAtRef: (ref, path) => readFileAtRef(ref, path, roots.repoRoot),
    parsers: { json: parseJson, yaml: parseYaml },
  });
  const readSnapshotFile: SnapshotReader = (ref, path) => snapshotDocuments.read({ repository: observation.repository, sha: ref }, path) as string | null;
  const readEvaluatedFile = (path: string) => readSnapshotFile(observation.evaluated.commit_sha, path);
  const headRuntime = headPolicyRuntime(roots, observation, readSnapshotFile, quiet);
  if (!headRuntime) return fail(roots, format, "check_pr.head_policy", "Proposed policy compilation failed");

  const initialChecks: InitialCheck[] = [], baseRead = policyAt(readSnapshotFile, base);
  let runtime = headRuntime, basePolicy: RuntimePolicy | null = null, trustedGovernancePaths: unknown = [];
  if (baseRead.error) initialChecks.push({ name: "governance-trusted-boundary", check: { ok: false, message: `cannot establish trusted governance boundary: ${baseRead.error}`, details: [`base_ref: ${base}`] } });
  else {
    runtime = loadRuntime(() => loadPolicyRuntimeFromObject(roots, baseRead.policy, { label: "repo-policy.json (base)", historicalBase: true, quiet }), "repo-policy.json (base)", "Base policy compilation failed") as PolicyRuntime;
    if (!runtime) return fail(roots, format, "check_pr.base_policy", "Base policy compilation failed");
    basePolicy = runtime.policy; trustedGovernancePaths = (basePolicy as RuntimePolicy & { paths?: { governance_paths?: unknown } }).paths?.governance_paths ?? [];
  }

  const { ajv, policy, changeIntentSchema, governanceGrantSchema } = runtime;
  const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy } as Parameters<typeof resolveEnforcementMode>[0]);
  if (!enforcement.ok) return fail(roots, format, "check_pr.enforcement", enforcement.message);
  const linked = fetchLinkedIssue({ prBody, repoFullName, quiet });
  if (linked.fatal) return fail(roots, format, "check_pr.linked_issue", "linked issue fallback failed");
  const { linkedIssues, issueBody, issueContext } = linked;
  let resolved = resolvePRChangeIntentFacts({ prBody, issueBody, linkedIssueCount: linkedIssues.length });
  if (!resolved.ok && linkedIssues.length === 1 && issueBody === null && resolved.error !== "issue_link_ambiguous") resolved = { ...resolved, error: "issue_fetch_failed", message: `Could not fetch issue #${linkedIssues[0]} body` };

  let changeIntent: unknown = null, changeIntentSource = resolved.changeIntentSource || "none";
  if (!resolved.ok) initialChecks.push({ name: "change-intent", check: { ok: false, message: `[${resolved.error}]: ${resolved.message}` } });
  else { const check = validationCheck(ajv, changeIntentSchema, resolved.changeIntent, "change-intent (from markdown)"); initialChecks.push({ name: "change-intent", check }); if (check.ok) changeIntent = resolved.changeIntent; }
  let governanceGrant: unknown = null;
  if (resolved.grantResult && !resolved.grantResult.ok) initialChecks.push({ name: "governance-grant", check: { ok: false, message: `[${resolved.grantResult.error}]: ${resolved.grantResult.message}` } });
  else if ((resolved.grantResult as { grant?: unknown } | null | undefined)?.grant) { const grant = (resolved.grantResult as { grant?: unknown }).grant, check = validationCheck(ajv, governanceGrantSchema, grant, "governance-grant (linked issue)"); initialChecks.push({ name: "governance-grant", check }); if (check.ok) governanceGrant = grant; }

  let diff, trackedFiles: string[];
  try { diff = getDiffObservation(base, exactHead, roots.repoRoot); trackedFiles = listTrackedFilesAtRef(observation.evaluated.commit_sha, roots.repoRoot); }
  catch (error: unknown) { return fail(roots, format, "check_pr.diff", (error as Error).message); }
  let trustedAuthorizer: ReturnType<typeof resolveTrustedAuthorizer> | null = null;
  if (governanceGrant !== null && basePolicy && repoFullName) try { trustedAuthorizer = resolveTrustedAuthorizer({ repoFullName, issueNumber: linkedIssues.length === 1 ? linkedIssues[0] : null, issueContext }); } catch {}

  const baseInput = {
    mode: "check-pr", repositoryRoot: roots.repoRoot, policy, basePolicy, headPolicy: headRuntime.policy, baseRef: base, headRef: exactHead,
    repositoryIdentity: observation.repository, snapshotDocuments, repositoryObservation: observation,
    trackedFiles, readFile: readEvaluatedFile, readFileAtRef: readSnapshotFile,
    changeIntent, changeIntentSource, governanceGrant, trustedGovernancePaths, trustedAuthorizer, enforcement, diffText: diff.diffText, diffFiles: diff.files, initialChecks,
  } as PipelineInput;
  const changed = Boolean(basePolicy && !isDeepStrictEqual(basePolicy, headRuntime.policy)), origin = changed ? "base" : "shared";
  const plan: Array<{ policyOrigin: "base" | "head" | "shared"; input: PipelineInput; options: PipelineOptions }> = [{ policyOrigin: origin, input: baseInput, options: { quiet, policyOrigin: origin } }];
  if (changed) {
    const proposedEnforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy: headRuntime.policy } as Parameters<typeof resolveEnforcementMode>[0]);
    if (!proposedEnforcement.ok) return fail(roots, format, "check_pr.proposed_enforcement", proposedEnforcement.message);
    plan.push({
      policyOrigin: "head",
      input: { ...baseInput, policy: headRuntime.policy, enforcement: proposedEnforcement, initialChecks: [] } as PipelineInput,
      options: { quiet: true, printEnforcement: false, ruleNamePrefix: "proposed-policy:", excludeRuleFamilies: PROPOSED_POLICY_EXCLUDED_FAMILIES, policyOrigin: "head" },
    });
  }

  const reporter = createAnalysisCollector(enforcement, { presenter: quiet ? null : createAnalysisTextPresenter() });
  let extra: ReturnType<typeof evaluatePolicyPipeline> | null = null;
  for (let i = 0; i < plan.length; i++) {
    if (i && !quiet) console.log("\nProposed policy differs from trusted base; checking head runtime policy as an additional veto.");
    const metadata = evaluatePolicyPipeline(plan[i].input, plan[i].options, reporter);
    if (!extra) extra = metadata;
  }
  const evaluationPlan = plan.map((step) => ({ policyOrigin: step.policyOrigin, enforcementMode: step.input.enforcement.mode, executionPhase: step.options.executionPhase || "both", excludedRuleFamilies: step.options.excludeRuleFamilies || [] }));
  const report = reporter.finish({ ...extra, evaluationPlan }), output = renderAnalysisReport(report, { format });
  if (output) console.log(output);
  return report.exitCode;
}