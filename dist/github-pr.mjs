import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { getDiff, readBasePolicy, resolveRemoteBaseRef } from "./git.mjs";
import { extractChangeIntent, extractGovernanceGrant, extractLinkedIssueNumbers, resolveChangeIntent } from "./change-intent.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { loadPolicyRuntime, loadPolicyRuntimeFromObject, validationCheck } from "./runtime/validation.mjs";
import { runPolicyPipeline } from "./runtime/pipeline.mjs";
import { resolveTrustedAuthorizer } from "./trusted-authorizer.mjs";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, ISSUE = /^[1-9][0-9]*$/;
const PROPOSED_POLICY_EXCLUDED_FAMILIES = ["governance-paths", "policy-delta"];
export function loadGitHubEvent() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath)
        return { ok: false, error: "no_event", message: "GITHUB_EVENT_PATH not set; not running in GitHub Actions" };
    try {
        const event = JSON.parse(readFileSync(eventPath, "utf-8")), pr = event.pull_request;
        if (!pr)
            return { ok: false, error: "not_pr_event", message: "GitHub event does not contain pull_request data" };
        return { ok: true, base: pr.base?.sha, baseRef: pr.base?.ref, head: pr.head?.sha, prBody: pr.body || "", prNumber: pr.number, repoFullName: event.repository?.full_name || process.env.GITHUB_REPOSITORY || "" };
    }
    catch (error) {
        return { ok: false, error: "event_read_error", message: `Cannot read event file: ${error.message}` };
    }
}
export function fetchIssueBody(repo, number) {
    if (!REPO.test(repo) || !ISSUE.test(String(number)))
        return null;
    try {
        return execFileSync("gh", ["api", `repos/${repo}/issues/${number}`, "--jq", ".body"], { encoding: "utf-8", timeout: 30000 }).trim() || null;
    }
    catch {
        return null;
    }
}
function cliAvailable(command) { try {
    execFileSync(command, ["--version"], { encoding: "utf-8", stdio: "pipe" });
    return true;
}
catch {
    return false;
} }
export function checkPrerequisites() {
    return [!process.env.GITHUB_EVENT_PATH && "GITHUB_EVENT_PATH env var (set automatically by GitHub Actions)", !cliAvailable("git") && "git CLI (required for diff analysis)"].filter(Boolean);
}
export const checkIssueFallbackPrerequisites = () => cliAvailable("gh") ? [] : ["gh CLI (required for linked issue fallback)"];
export function resolvePRChangeIntentFacts({ prBody, issueBody = null, linkedIssueCount = null }) {
    const linkedIssues = extractLinkedIssueNumbers(prBody), grantResult = extractGovernanceGrant(issueBody);
    const prResult = extractChangeIntent(prBody);
    const common = { linkedIssues, grantResult };
    if (prResult.ok)
        return { ok: true, changeIntent: prResult.changeIntent, changeIntentSource: "pr body", ...common };
    if (prResult.error !== "change_intent_not_found")
        return { ok: false, error: prResult.error, message: prResult.message, changeIntentSource: "pr body", ...common };
    const count = linkedIssueCount ?? linkedIssues.length;
    if (count > 1)
        return { ok: false, error: "issue_link_ambiguous", message: `PR body references ${count} issues (${linkedIssues.map((n) => `#${n}`).join(", ")}); expected exactly one`, changeIntentSource: "none", ...common };
    const issueResult = resolveChangeIntent(prBody, issueBody);
    return issueResult.ok
        ? { ok: true, changeIntent: issueResult.changeIntent, changeIntentSource: "linked issue", ...common }
        : { ok: false, error: issueResult.error, message: issueResult.message, changeIntentSource: "none", ...common };
}
function loadRuntime(load, label, failure) {
    try {
        const runtime = load();
        if (runtime.ok)
            return runtime;
    }
    catch (error) {
        console.error(`FAIL: ${label}\n  ${error.message}`);
    }
    console.error(`\n${failure}`);
    return null;
}
function printMissing(title, missing) { console.error(title); for (const item of missing)
    console.error(`  - ${item}`); }
function fetchLinkedIssue({ prBody, repoFullName }) {
    const linkedIssues = extractLinkedIssueNumbers(prBody), pr = extractChangeIntent(prBody);
    const hasChangeIntent = pr.ok, needsFallback = !hasChangeIntent && pr.error === "change_intent_not_found" && linkedIssues.length === 1;
    if (linkedIssues.length !== 1 || (!needsFallback && !hasChangeIntent))
        return { linkedIssues, issueBody: null, fatal: false };
    console.log(needsFallback ? `No ChangeIntent in PR body; trying linked issue #${linkedIssues[0]}...` : `Fetching linked issue #${linkedIssues[0]} for GovernanceGrant...`);
    const missing = checkIssueFallbackPrerequisites();
    if (missing.length) {
        if (needsFallback) {
            printMissing("ERROR: linked issue fallback prerequisites not met:", missing);
            return { linkedIssues, issueBody: null, fatal: true };
        }
        console.warn("WARN: linked issue lookup unavailable; GovernanceGrant cannot be established");
        return { linkedIssues, issueBody: null, fatal: false };
    }
    const issueBody = fetchIssueBody(repoFullName, linkedIssues[0]);
    if (issueBody === null && hasChangeIntent)
        console.warn(`WARN: could not fetch linked issue #${linkedIssues[0]}; GovernanceGrant unavailable`);
    return { linkedIssues, issueBody, fatal: false };
}
export function runCheckPR(roots, args = []) {
    if (args.length) {
        console.error(`Unexpected argument for check-pr: ${args[0]}`);
        return 1;
    }
    const prereqs = checkPrerequisites();
    if (prereqs.length) {
        printMissing("ERROR: check-pr prerequisites not met:", prereqs);
        return 1;
    }
    const event = loadGitHubEvent();
    if (!event.ok) {
        console.error(`ERROR: ${event.message}`);
        return 1;
    }
    const { base: eventBase, baseRef, head, prBody, prNumber, repoFullName } = event;
    if (!eventBase || !head) {
        console.error("ERROR: pull_request event missing base/head SHA");
        return 1;
    }
    let base = eventBase;
    if (baseRef) {
        try {
            base = resolveRemoteBaseRef(baseRef, roots.repoRoot);
        }
        catch (error) {
            console.error(`ERROR: cannot resolve current PR base ref ${baseRef}: ${error.message}`);
            return 1;
        }
        if (base !== eventBase)
            console.log(`Base ref ${baseRef} advanced from event snapshot ${eventBase.slice(0, 7)} to ${base.slice(0, 7)}; using current base`);
    }
    console.log(`PR #${prNumber}: checking ChangeIntent and diff (${base.slice(0, 7)}..${head.slice(0, 7)})`);
    const headRuntime = loadRuntime(() => loadPolicyRuntime(roots, { label: "repo-policy.json (PR head)" }), "repo-policy.json (PR head)", "Proposed policy compilation failed");
    if (!headRuntime)
        return 1;
    const initialChecks = [], baseRead = readBasePolicy(base, roots.repoRoot);
    let runtime = headRuntime, basePolicy = null, trustedGovernancePaths = [];
    if (baseRead.error)
        initialChecks.push({ name: "governance-trusted-boundary", check: { ok: false, message: `cannot establish trusted governance boundary: ${baseRead.error}`, details: [`base_ref: ${base}`] } });
    else {
        runtime = loadRuntime(() => loadPolicyRuntimeFromObject(roots, baseRead.policy, { label: "repo-policy.json (base)" }), "repo-policy.json (base)", "Base policy compilation failed");
        if (!runtime)
            return 1;
        basePolicy = runtime.policy;
        trustedGovernancePaths = basePolicy.paths?.governance_paths ?? [];
    }
    const { ajv, policy, changeIntentSchema, governanceGrantSchema } = runtime;
    const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy });
    if (!enforcement.ok) {
        console.error(`ERROR: ${enforcement.message}`);
        return 1;
    }
    const linked = fetchLinkedIssue({ prBody, repoFullName });
    if (linked.fatal)
        return 1;
    const { linkedIssues, issueBody } = linked;
    let resolved = resolvePRChangeIntentFacts({ prBody, issueBody });
    if (!resolved.ok && resolved.linkedIssues.length === 1 && issueBody === null && resolved.error !== "issue_link_ambiguous")
        resolved = { ...resolved, error: "issue_fetch_failed", message: `Could not fetch issue #${resolved.linkedIssues[0]} body` };
    let changeIntent = null, changeIntentSource = resolved.changeIntentSource || "none";
    if (!resolved.ok)
        initialChecks.push({ name: "change-intent", check: { ok: false, message: `[${resolved.error}]: ${resolved.message}` } });
    else {
        const check = validationCheck(ajv, changeIntentSchema, resolved.changeIntent, "change-intent (from markdown)");
        initialChecks.push({ name: "change-intent", check });
        if (check.ok)
            changeIntent = resolved.changeIntent;
    }
    let governanceGrant = null;
    if (resolved.grantResult && !resolved.grantResult.ok)
        initialChecks.push({ name: "governance-grant", check: { ok: false, message: `[${resolved.grantResult.error}]: ${resolved.grantResult.message}` } });
    else if (resolved.grantResult?.grant) {
        const check = validationCheck(ajv, governanceGrantSchema, resolved.grantResult.grant, "governance-grant (linked issue)");
        initialChecks.push({ name: "governance-grant", check });
        if (check.ok)
            governanceGrant = resolved.grantResult.grant;
    }
    let diffText;
    try {
        diffText = getDiff(base, head, roots.repoRoot);
    }
    catch (error) {
        console.error(`ERROR: ${error.message}`);
        return 1;
    }
    let trustedAuthorizer = null;
    if (basePolicy && repoFullName)
        try {
            trustedAuthorizer = resolveTrustedAuthorizer({ repoFullName, issueNumber: linkedIssues.length === 1 ? linkedIssues[0] : null, prNumber });
        }
        catch { }
    const baseResult = runPolicyPipeline({
        mode: "check-pr", repositoryRoot: roots.repoRoot, policy, basePolicy, headPolicy: headRuntime.policy,
        changeIntent, changeIntentSource, governanceGrant, trustedGovernancePaths, trustedAuthorizer, enforcement, diffText, initialChecks,
    });
    if (!basePolicy || isDeepStrictEqual(basePolicy, headRuntime.policy))
        return baseResult.exitCode;
    const proposedEnforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy: headRuntime.policy });
    if (!proposedEnforcement.ok) {
        console.error(`ERROR: proposed policy enforcement: ${proposedEnforcement.message}`);
        return 1;
    }
    // Head policy — только дополнительный veto. Governance authorization и policy-delta уже
    // проверены trusted base pass и намеренно не могут быть переопределены самим head policy.
    console.log("\nProposed policy differs from trusted base; checking head runtime policy as an additional veto.");
    const proposedResult = runPolicyPipeline({
        mode: "check-pr", repositoryRoot: roots.repoRoot, policy: headRuntime.policy, basePolicy, headPolicy: headRuntime.policy,
        changeIntent, changeIntentSource, governanceGrant, trustedGovernancePaths, trustedAuthorizer,
        enforcement: proposedEnforcement, diffText, initialChecks: [],
    }, {
        printEnforcement: false,
        ruleNamePrefix: "proposed-policy:",
        excludeRuleFamilies: PROPOSED_POLICY_EXCLUDED_FAMILIES,
    });
    return Math.max(baseResult.exitCode, proposedResult.exitCode);
}
