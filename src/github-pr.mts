import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { evaluatePrimitiveRelation } from "./checks/relation-kernel.mjs";
import { parseJson, parseYaml } from "./document-facts.mjs";
import { acquirePullRequestObservation, getDiffObservation, listTrackedFilesAtRef, readFileAtRef, type RepositoryObservation } from "./git.mjs";
import { createImmutableSnapshotDocumentCache } from "./immutable-snapshot-cache.mjs";
import { extractChangeIntent, extractGovernanceGrant, extractLinkedIssueNumbers, extractLinkedIssueReferences, resolveChangeIntent } from "./change-intent.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { createPolicyNormalizationContext, loadPolicyRuntimeFromObject, validationCheck } from "./runtime/validation.mjs";
import { classifyRepoGuardSelfHostRepresentation, evaluatePolicyPipeline, evaluateRepoGuardNativeBlockingSnapshot, evaluateRepoGuardNativeRollbackSnapshot, evaluateRepoGuardTrustedRootMigrationSnapshot, selectRepoGuardAuthoritativeEvaluator } from "./runtime/pipeline.mjs";
import { createAnalysisCollector } from "./runtime/analysis-report.mjs";
import { createAnalysisTextPresenter, renderAnalysisReport } from "./reporting/renderers.mjs";
import { fetchIssueAuthorContext, resolveTrustedAuthorizer } from "./trusted-authorizer.mjs";
import { buildRequirementAuthorityFromSnapshot, checkRequirementTransition, checkRoutineRequirementTransition, normalizeRequirementAuthority, projectRequirementTransactionEvidence } from "./requirement-relations.mjs";
import type { TransitionReceipt } from "./runtime/transition-closure.mjs";

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
function requirementTransitionGrant(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { requirement_transition?: unknown }).requirement_transition ?? null
    : null;
}
function trustedRootTransitionGrant(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { trusted_root_transition?: unknown }).trusted_root_transition ?? null
    : null;
}
export function evaluateTrustedRootTransitionBoundary(input: {
  governanceGrant: unknown;
  trustedAuthorizer: ReturnType<typeof resolveTrustedAuthorizer> | null;
  repository: string;
  repositoryRoot: string;
  baseRevision: string;
  headRevision: string;
}) {
  const nativeRootGrant = trustedRootTransitionGrant(input.governanceGrant);
  if (nativeRootGrant === null) return null;
  const grant = nativeRootGrant as {
    repository?: unknown;
    authority_base_sha?: unknown;
    base_sha?: unknown;
    head_sha?: unknown;
    permissions?: unknown;
  };
  const trustedSource = input.trustedAuthorizer?.trusted === true
    && input.trustedAuthorizer?.source === "repository_permission";
  const receipt = trustedSource ? {
    repository: String(grant.repository ?? ""),
    authorityBaseRevision: String(grant.authority_base_sha ?? ""),
    baseRevision: String(grant.base_sha ?? ""),
    headRevision: String(grant.head_sha ?? ""),
    permissions: Array.isArray(grant.permissions) ? grant.permissions.map((value) => String(value)) : [],
  } : null;
  const evaluation = evaluateRepoGuardTrustedRootMigrationSnapshot({
    repository: input.repository,
    repositoryRoot: input.repositoryRoot,
    trustedAuthorityBaseRevision: input.baseRevision,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    trustedRootReceipt: receipt,
  });
  const reasons = [
    ...(!trustedSource ? ["C2.5:trust_authorizer_untrusted"] : []),
    ...evaluation.reasons,
  ];
  return {
    ok: trustedSource && evaluation.ok,
    trustedSource,
    reasons,
    evaluation,
  };
}

function grantObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function atomicCutoverFlag(value: unknown): boolean {
  return grantObject(value)?.allow_atomic_governance_cutover === true;
}

function transitionReceiptGrant(value: unknown): Record<string, unknown> | null {
  const grant = grantObject(value)?.transition_receipt;
  return grant && typeof grant === "object" && !Array.isArray(grant) ? grant as Record<string, unknown> : null;
}

function trustedIssueAuthorizer(value: ReturnType<typeof resolveTrustedAuthorizer> | null): boolean {
  return value?.trusted === true && value?.source === "repository_permission";
}

export function workIntentFromChangeIntent(changeIntent: unknown, prNumber: unknown) {
  const root = grantObject(changeIntent);
  const anchors = grantObject(root?.anchors);
  const affects = Array.isArray(anchors?.affects)
    ? anchors!.affects.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  return {
    id: "pr:" + String(prNumber ?? "unknown"),
    addresses: [...new Set(affects)].sort((a, b) => a.localeCompare(b, "en")),
  };
}

export function evaluateTransitionReceiptBoundary(input: {
  governanceGrant: unknown;
  trustedAuthorizer: ReturnType<typeof resolveTrustedAuthorizer> | null;
  repository: string;
  authorityBaseRevision: string;
  baseRevision: string;
  headRevision: string;
}) {
  const grant = transitionReceiptGrant(input.governanceGrant);
  if (!grant) return { present: false, ok: true, receipt: null as TransitionReceipt | null, reasons: [] as string[] };
  const reasons: string[] = [];
  if (!trustedIssueAuthorizer(input.trustedAuthorizer)) reasons.push("A1:transition_receipt_untrusted_source");
  if (grant.repository !== input.repository) reasons.push("A1:transition_receipt_repository_mismatch");
  if (grant.authority_base_sha !== input.authorityBaseRevision) reasons.push("A1:transition_receipt_authority_base_mismatch");
  if (grant.base_sha !== input.baseRevision) reasons.push("A1:transition_receipt_base_mismatch");
  if (grant.head_sha !== input.headRevision) reasons.push("A1:transition_receipt_head_mismatch");
  const permissions = Array.isArray(grant.permissions) ? grant.permissions.map((value) => String(value)) : [];
  if (!permissions.length || new Set(permissions).size !== permissions.length ||
      permissions.some((permission) => !permission || permission.includes("*")))
    reasons.push("A1:transition_receipt_permissions_invalid");
  const ok = reasons.length === 0;
  const receipt: TransitionReceipt | null = ok ? {
    authorityBaseRevision: String(grant.authority_base_sha),
    baseRevision: String(grant.base_sha),
    headRevision: String(grant.head_sha),
    permissions,
  } : null;
  return { present: true, ok, receipt, reasons: [...new Set(reasons)].sort() };
}

export function evaluateAtomicNativeCutoverBoundary(input: {
  governanceGrant: unknown;
  trustedAuthorizer: ReturnType<typeof resolveTrustedAuthorizer> | null;
  repository: string;
  repositoryRoot: string;
  baseRevision: string;
  headRevision: string;
}) {
  const root = evaluateTrustedRootTransitionBoundary(input);
  const rootAuthorized = root?.ok === true;
  const atomicAuthorized = atomicCutoverFlag(input.governanceGrant) && trustedIssueAuthorizer(input.trustedAuthorizer);
  const reasons = [
    ...(root ? root.reasons : ["A1:trusted_root_transition_missing"]),
    ...(!atomicCutoverFlag(input.governanceGrant) ? ["A1:atomic_cutover_permission_missing"] : []),
    ...(atomicCutoverFlag(input.governanceGrant) && !trustedIssueAuthorizer(input.trustedAuthorizer)
      ? ["A1:atomic_cutover_authorizer_untrusted"] : []),
  ];
  return {
    ok: rootAuthorized && atomicAuthorized,
    rootAuthorized,
    atomicAuthorized,
    reasons: [...new Set(reasons)].sort(),
    rootBoundary: root,
  };
}

export function evaluateAtomicNativeRollbackBoundary(input: {
  governanceGrant: unknown;
  trustedAuthorizer: ReturnType<typeof resolveTrustedAuthorizer> | null;
  repository: string;
  repositoryRoot: string;
  baseRevision: string;
  headRevision: string;
}) {
  const grant = trustedRootTransitionGrant(input.governanceGrant) as Record<string, unknown> | null;
  const trustedSource = trustedIssueAuthorizer(input.trustedAuthorizer);
  const receipt = trustedSource && grant ? {
    repository: String(grant.repository ?? ""),
    authorityBaseRevision: String(grant.authority_base_sha ?? ""),
    baseRevision: String(grant.base_sha ?? ""),
    headRevision: String(grant.head_sha ?? ""),
    permissions: Array.isArray(grant.permissions) ? grant.permissions.map((value) => String(value)) : [],
  } : null;
  const evaluation = evaluateRepoGuardNativeRollbackSnapshot({
    repository: input.repository,
    repositoryRoot: input.repositoryRoot,
    trustedAuthorityBaseRevision: input.baseRevision,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    trustedRootReceipt: receipt,
  });
  const atomicAuthorized = atomicCutoverFlag(input.governanceGrant) && trustedSource;
  const reasons = [
    ...(!trustedSource ? ["A1:rollback_authorizer_untrusted"] : []),
    ...(!atomicCutoverFlag(input.governanceGrant) ? ["A1:atomic_rollback_permission_missing"] : []),
    ...evaluation.reasons,
  ];
  return {
    ok: trustedSource && atomicAuthorized && evaluation.ok,
    rootAuthorized: evaluation.trust.authorized,
    atomicAuthorized,
    reasons: [...new Set(reasons)].sort(),
    evaluation,
  };
}

const REQUIREMENT_OVERLAP_SHADOW_ID = "requirement-verification-overlap-shadow";
const REQUIREMENT_IMPLEMENTATION_ANCHOR = "__requirement_changed_implementation";
const REQUIREMENT_OVERLAP_ANCHOR = "__requirement_verification_overlap";
function requirementVerificationOverlapShadow(baseGraph: ReturnType<typeof normalizeRequirementAuthority>, headGraph: ReturnType<typeof normalizeRequirementAuthority>, changedFiles: Parameters<typeof projectRequirementTransactionEvidence>[0]["changedFiles"]) {
  const projection = projectRequirementTransactionEvidence({ base: baseGraph, head: headGraph, changedFiles });
  const instances = (values: readonly string[]) => values.map((value) => ({ value, file: "<requirement-relation-projection>" }));
  const evaluated = evaluatePrimitiveRelation({
    anchors: { byType: {
      [REQUIREMENT_IMPLEMENTATION_ANCHOR]: instances(projection.implementation_requirements),
      [REQUIREMENT_OVERLAP_ANCHOR]: instances(projection.overlap_requirements),
    } },
  }, {
    relation_id: REQUIREMENT_OVERLAP_SHADOW_ID,
    primitive: "set_presence_implies",
    operands: {
      left: { source: "repository", selector: { kind: "anchor_values", anchor_type: REQUIREMENT_IMPLEMENTATION_ANCHOR }, type: "string_set" },
      right: { source: "repository", selector: { kind: "anchor_values", anchor_type: REQUIREMENT_OVERLAP_ANCHOR }, type: "string_set" },
    },
    parameters: {},
  } as Parameters<typeof evaluatePrimitiveRelation>[1]) as Record<string, unknown>;
  const kernelData = evaluated.data && typeof evaluated.data === "object" && !Array.isArray(evaluated.data) ? evaluated.data as Record<string, unknown> : {};
  return {
    ...evaluated,
    advisory: true,
    data: { ...kernelData, relation_id: REQUIREMENT_OVERLAP_SHADOW_ID, projection },
  };
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


function emitAuthorityResult(
  roots: CheckPrRoots,
  format: Format,
  quiet: boolean,
  initialChecks: readonly InitialCheck[],
  selector: ReturnType<typeof selectRepoGuardAuthoritativeEvaluator>,
  name: string,
  check: { ok: boolean; message: string; details?: readonly string[]; data?: unknown },
  metadata: Record<string, unknown> = {},
) {
  const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy: { enforcement: { mode: "blocking" } } });
  if (!enforcement.ok) return fail(roots, format, "check_pr.enforcement", enforcement.message);
  const reporter = createAnalysisCollector(enforcement, { presenter: quiet ? null : createAnalysisTextPresenter() });
  for (const item of initialChecks) reporter.report(item.name, item.check, { policyOrigin: "trusted-base-selector", enforcementMode: enforcement.mode });
  reporter.report("authority-selector", {
    ok: selector.ok,
    message: selector.ok
      ? "authoritative evaluator selected from trusted BASE representation"
      : "authoritative evaluator selection failed closed",
    details: selector.ok ? [] : [selector.reason],
    data: selector,
  }, { policyOrigin: "trusted-base-selector", enforcementMode: enforcement.mode });
  reporter.report(name, check, { policyOrigin: "trusted-base-selector", enforcementMode: enforcement.mode });
  const report = reporter.finish({
    command: "check-pr",
    repositoryRoot: roots.repoRoot,
    authoritySelection: selector,
    ...metadata,
  });
  const output = renderAnalysisReport(report, { format });
  if (output) console.log(output);
  return report.exitCode;
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

  let diff, trackedFiles: string[], baseTrackedFiles: string[];
  try {
    diff = getDiffObservation(base, exactHead, roots.repoRoot);
    baseTrackedFiles = listTrackedFilesAtRef(base, roots.repoRoot);
    trackedFiles = listTrackedFilesAtRef(observation.evaluated.commit_sha, roots.repoRoot);
  }
  catch (error: unknown) { return fail(roots, format, "check_pr.diff", (error as Error).message); }
  let trustedAuthorizer: ReturnType<typeof resolveTrustedAuthorizer> | null = null;
  if (governanceGrant !== null && basePolicy && repoFullName) try { trustedAuthorizer = resolveTrustedAuthorizer({ repoFullName, issueNumber: linkedIssues.length === 1 ? linkedIssues[0] : null, issueContext }); } catch {}

  let nativeRootTransitionAuthorized = false;
  let nativeRootTransitionResult: ReturnType<typeof evaluateRepoGuardTrustedRootMigrationSnapshot> | null = null;
  const nativeRootBoundary = evaluateTrustedRootTransitionBoundary({
    governanceGrant,
    trustedAuthorizer,
    repository: observation.repository,
    repositoryRoot: roots.repoRoot,
    baseRevision: base,
    headRevision: exactHead,
  });
  if (nativeRootBoundary !== null) {
    nativeRootTransitionResult = nativeRootBoundary.evaluation;
    nativeRootTransitionAuthorized = nativeRootBoundary.ok;
    initialChecks.push({
      name: "trusted-root-transition",
      check: {
        ok: nativeRootTransitionAuthorized,
        message: nativeRootTransitionAuthorized
          ? "native TrustedRoot transition is exactly authorized by independent trusted issue authority"
          : "native TrustedRoot transition is not exactly authorized",
        details: nativeRootBoundary.reasons,
        data: {
          candidate_ready: nativeRootTransitionResult.candidateReady,
          authorized: nativeRootTransitionResult.trust.authorized,
          required_permissions: nativeRootTransitionResult.requiredPermissions,
          migration: nativeRootTransitionResult.migration,
          equivalence: nativeRootTransitionResult.equivalence,
        },
      },
    });
  }

  let requirementTransitionAuthorized = false;
  let routineRequirementPaths: string[] = [];
  if (basePolicy) {
    try {
      const baseAuthority = buildRequirementAuthorityFromSnapshot({
        policy: basePolicy,
        snapshot: "base",
        revision: base,
        trackedFiles: baseTrackedFiles,
        readFileAtRef: readSnapshotFile,
      });
      const headAuthority = buildRequirementAuthorityFromSnapshot({
        policy: headRuntime.policy,
        snapshot: "head",
        revision: exactHead,
        trackedFiles,
        readFileAtRef: readSnapshotFile,
      });
      if (baseAuthority || headAuthority) {
        const baseGraph = baseAuthority || normalizeRequirementAuthority({ snapshot: "base", revision: base, scope: [], sources: [] });
        const headGraph = headAuthority || normalizeRequirementAuthority({ snapshot: "head", revision: exactHead, scope: [], sources: [] });
        const transition = checkRequirementTransition({
          base: baseGraph,
          head: headGraph,
          grant: requirementTransitionGrant(governanceGrant),
          trustedAuthorizer,
        });
        requirementTransitionAuthorized = nativeRootTransitionAuthorized || transition.authorized;
        const routine = governanceGrant === null && !transition.ok
          ? checkRoutineRequirementTransition({
            base: baseGraph, head: headGraph, changedFiles: diff.files, headTrackedFiles: trackedFiles,
            readFileAtRef: readSnapshotFile,
            governancePaths: Array.isArray(trustedGovernancePaths) ? trustedGovernancePaths as string[] : [],
            forbiddenPaths: (basePolicy as { paths?: { forbidden?: string[] } }).paths?.forbidden || [],
            closedRepository: basePolicy.document_relations?.rules?.some((rule) => rule.id === "requirements-strict:closed-repository") === true,
          })
          : null;
        if (routine?.ok && (changeIntent as { change_type?: string } | null)?.change_type !== "governance") routineRequirementPaths = routine.requirement_paths;
        const accepted = nativeRootTransitionAuthorized || transition.ok || routineRequirementPaths.length > 0;
        initialChecks.push({
          name: "requirement-transition",
          check: {
            ok: accepted,
            message: accepted
              ? nativeRootTransitionAuthorized
                ? "requirement authority transition is exact (native TrustedRoot migration grant)"
                : "requirement authority transition is exact (trusted grant or proven routine trace addition)"
              : "requirement authority transition is not exactly authorized",
            details: accepted ? [] : [...transition.reasons, ...(routine?.reasons || [])],
            data: {
              required: transition.required,
              authorized: transition.authorized,
              native_root_transition_authorized: nativeRootTransitionAuthorized,
              automatic_routine: routineRequirementPaths.length > 0,
              authority_scope_changed: transition.authority_scope_changed,
              base_authority_sha256: transition.base_authority_sha256,
              head_authority_sha256: transition.head_authority_sha256,
              actual_delta: transition.actual_delta,
            },
          },
        });
        initialChecks.push({
          name: REQUIREMENT_OVERLAP_SHADOW_ID,
          check: requirementVerificationOverlapShadow(baseGraph, headGraph, diff.files),
        });
      }
    } catch (error: unknown) {
      initialChecks.push({
        name: "requirement-transition",
        check: { ok: false, message: `requirement authority transition evaluation failed: ${error instanceof Error ? error.message : String(error)}` },
      });
    }
  }
  const satisfiedTransactionConstraintKeys = requirementTransitionAuthorized ? ["trace:changed-requirements-need-evidence"] : [];

  const baseInput = {
    mode: "check-pr", repositoryRoot: roots.repoRoot, policy, basePolicy, headPolicy: headRuntime.policy, baseRef: base, headRef: exactHead,
    repositoryIdentity: observation.repository, snapshotDocuments, repositoryObservation: observation,
    trackedFiles, readFile: readEvaluatedFile, readFileAtRef: readSnapshotFile,
    changeIntent, changeIntentSource, governanceGrant, trustedGovernancePaths, trustedAuthorizer, routineRequirementPaths, enforcement, diffText: diff.diffText, diffFiles: diff.files, initialChecks,
  } as PipelineInput;
  const changed = Boolean(basePolicy && !isDeepStrictEqual(basePolicy, headRuntime.policy)), origin = changed ? "base" : "shared";
  const plan: Array<{ policyOrigin: "base" | "head" | "shared"; input: PipelineInput; options: PipelineOptions }> = [{
    policyOrigin: origin,
    input: baseInput,
    options: { quiet, policyOrigin: origin, satisfiedTransactionConstraintKeys },
  }];
  if (changed) {
    const proposedEnforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy: headRuntime.policy } as Parameters<typeof resolveEnforcementMode>[0]);
    if (!proposedEnforcement.ok) return fail(roots, format, "check_pr.proposed_enforcement", proposedEnforcement.message);
    plan.push({
      policyOrigin: "head",
      input: { ...baseInput, policy: headRuntime.policy, enforcement: proposedEnforcement, initialChecks: [] } as PipelineInput,
      options: { quiet: true, printEnforcement: false, ruleNamePrefix: "proposed-policy:", excludeRuleFamilies: PROPOSED_POLICY_EXCLUDED_FAMILIES, policyOrigin: "head", satisfiedTransactionConstraintKeys },
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