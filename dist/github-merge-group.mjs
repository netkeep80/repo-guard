import { readFileSync } from "node:fs";
import { runGit, readBasePolicy } from "./git.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { renderAnalysisReport } from "./reporting/renderers.mjs";
import { loadPolicyRuntimeFromObject } from "./runtime/validation.mjs";
import { runPolicyPipeline } from "./runtime/pipeline.mjs";
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const value = (args, name) => {
    const index = args.indexOf(name);
    return index < 0 ? null : args[index + 1];
};
const stringValue = (input) => typeof input === "string" && input.length > 0 ? input : null;
export function normalizeGitHubMergeGroupEvent(payload, environment = {}) {
    if (!payload || typeof payload !== "object") {
        return { ok: false, error: "not_merge_group_event", message: "GitHub event payload is not an object" };
    }
    const event = payload;
    if (!event.merge_group || typeof event.merge_group !== "object") {
        return { ok: false, error: "not_merge_group_event", message: "GitHub event does not contain merge_group data" };
    }
    if (event.action !== "checks_requested") {
        return {
            ok: false,
            error: "unsupported_merge_group_action",
            message: `Unsupported merge_group action: ${String(event.action || "<missing>")}`,
        };
    }
    const payloadSha = stringValue(event.merge_group.head_sha);
    const githubSha = stringValue(environment.githubSha);
    if (payloadSha && !OBJECT_ID.test(payloadSha)) {
        return { ok: false, error: "invalid_candidate_sha", message: "merge_group.head_sha is not an exact Git object id" };
    }
    if (githubSha && !OBJECT_ID.test(githubSha)) {
        return { ok: false, error: "invalid_candidate_sha", message: "GITHUB_SHA is not an exact Git object id" };
    }
    if (payloadSha && githubSha && payloadSha.toLowerCase() !== githubSha.toLowerCase()) {
        return {
            ok: false,
            error: "candidate_sha_mismatch",
            message: `merge_group.head_sha ${payloadSha} disagrees with GITHUB_SHA ${githubSha}`,
        };
    }
    const candidateSha = payloadSha || githubSha;
    if (!candidateSha) {
        return { ok: false, error: "missing_candidate_sha", message: "merge_group candidate SHA is missing" };
    }
    const rawBaseSha = stringValue(event.merge_group.base_sha);
    if (rawBaseSha && !OBJECT_ID.test(rawBaseSha)) {
        return { ok: false, error: "invalid_base_sha", message: "merge_group.base_sha is not an exact Git object id" };
    }
    return {
        ok: true,
        provider: "github_merge_queue",
        candidateSha,
        baseSha: rawBaseSha,
        baseRef: stringValue(event.merge_group.base_ref),
        headRef: stringValue(event.merge_group.head_ref),
        repoFullName: stringValue(event.repository?.full_name),
    };
}
export function loadGitHubMergeGroupEvent() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
        return { ok: false, error: "no_event", message: "GITHUB_EVENT_PATH not set; not running in GitHub Actions" };
    }
    try {
        const payload = JSON.parse(readFileSync(eventPath, "utf-8"));
        return normalizeGitHubMergeGroupEvent(payload, { githubSha: process.env.GITHUB_SHA || null });
    }
    catch (error) {
        return { ok: false, error: "event_read_error", message: `Cannot read event file: ${error.message}` };
    }
}
function exactCandidateDiff(baseSha, candidateSha, cwd) {
    return runGit(["-c", "core.quotepath=false", "diff", baseSha, candidateSha, "--"], { cwd });
}
export function runCheckMergeGroup(roots, args = []) {
    const format = value(args, "--format") || "text";
    if (!["text", "json", "summary"].includes(format)) {
        console.error(`Unknown check-merge-group format: ${format}`);
        return 1;
    }
    const event = loadGitHubMergeGroupEvent();
    if (!event.ok) {
        console.error(`ERROR: [${event.error}] ${event.message}`);
        return 1;
    }
    if (!event.baseSha) {
        console.error("ERROR: [missing_base_sha] merge_group.base_sha is required to establish the trusted policy boundary");
        return 1;
    }
    let checkoutSha;
    try {
        checkoutSha = runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: roots.repoRoot }).trim();
    }
    catch (error) {
        console.error(`ERROR: cannot resolve checked-out merge-group candidate: ${error.message}`);
        return 1;
    }
    if (checkoutSha.toLowerCase() !== event.candidateSha.toLowerCase()) {
        console.error(`ERROR: [candidate_checkout_mismatch] checked-out HEAD ${checkoutSha} != merge-group candidate ${event.candidateSha}`);
        return 1;
    }
    const quiet = format !== "text";
    const baseRead = readBasePolicy(event.baseSha, roots.repoRoot);
    if (baseRead.error || baseRead.policy === null) {
        console.error(`ERROR: cannot establish trusted merge-group base policy: ${baseRead.error || "empty_base_policy"}`);
        return 1;
    }
    const runtime = loadPolicyRuntimeFromObject(roots, baseRead.policy, {
        quiet,
        label: "repo-policy.json (merge-group base)",
    });
    if (!runtime.ok) {
        if (!quiet)
            console.error("\nTrusted merge-group base policy compilation failed; aborting enforcement.");
        return 1;
    }
    const enforcement = resolveEnforcementMode({
        cliValue: roots.enforcementMode,
        policy: runtime.policy,
    });
    if (!enforcement.ok) {
        console.error(`ERROR: ${enforcement.message}`);
        return 1;
    }
    let diffText;
    try {
        diffText = exactCandidateDiff(event.baseSha, event.candidateSha, roots.repoRoot);
    }
    catch (error) {
        console.error(`ERROR: cannot inspect exact merge-group candidate diff: ${error.message}`);
        return 1;
    }
    const baseReport = runPolicyPipeline({
        mode: "check-merge-group",
        repositoryRoot: roots.repoRoot,
        policy: runtime.policy,
        changeIntent: null,
        changeIntentSource: "none",
        enforcement,
        diffText,
        initialChecks: [],
    }, {
        quiet,
        executionPhase: "state",
    });
    const report = {
        ...baseReport,
        provider: event.provider,
        candidateSha: event.candidateSha,
        baseSha: event.baseSha,
        baseRef: event.baseRef,
        headRef: event.headRef,
        repository: event.repoFullName,
    };
    const output = renderAnalysisReport(report, { format });
    if (output)
        console.log(output);
    return baseReport.exitCode;
}
