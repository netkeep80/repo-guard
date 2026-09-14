import { execFileSync } from "node:child_process";
import { parseMachineDiff } from "./diff/parser.mjs";
function childProcessMessage(error) {
    const stderr = error?.stderr?.toString?.().trim();
    if (stderr)
        return stderr;
    const stdout = error?.stdout?.toString?.().trim();
    if (stdout)
        return stdout;
    return error?.message || "command failed";
}
function gitSubcommand(args) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-c") {
            i++;
            continue;
        }
        if (!args[i].startsWith("-"))
            return args[i];
    }
    return "";
}
export function runGit(args, options = {}) {
    try {
        return execFileSync("git", args, {
            encoding: "utf-8",
            cwd: options.cwd,
            stdio: options.stdio || "pipe",
        });
    }
    catch (error) {
        const command = gitSubcommand(args);
        const subcommand = command ? ` ${command}` : "";
        throw new Error(`git${subcommand} failed: ${childProcessMessage(error)}`);
    }
}
function exactCommit(ref, cwd, label) {
    try {
        const sha = runGit(["rev-parse", "--verify", `${ref}^{commit}`], { cwd }).trim();
        if (!sha)
            throw new Error("empty object id");
        return sha;
    }
    catch (error) {
        throw new Error(`repository observation failed: cannot resolve ${label}: ${error.message}`);
    }
}
function exactTree(ref, cwd, label) {
    try {
        const sha = runGit(["rev-parse", "--verify", `${ref}^{tree}`], { cwd }).trim();
        if (!sha)
            throw new Error("empty tree id");
        return sha;
    }
    catch (error) {
        throw new Error(`repository observation failed: cannot resolve ${label} tree: ${error.message}`);
    }
}
function refreshRemoteBaseRef(baseRef, cwd, remote) {
    try {
        runGit(["check-ref-format", "--branch", baseRef], { cwd });
        runGit(["fetch", "--no-tags", "--prune", remote, `+refs/heads/${baseRef}:refs/remotes/${remote}/${baseRef}`], { cwd });
    }
    catch (error) {
        throw new Error(`repository observation failed: cannot refresh base ${remote}/${baseRef}: ${error.message}`);
    }
}
export function resolveRemoteBaseRef(baseRef, cwd, remote = "origin") {
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
export function listTrackedFilesAtRef(ref, cwd) {
    const output = runGit(["ls-tree", "-r", "-z", "--name-only", ref], { cwd });
    return output.split("\0").filter(Boolean);
}
export function acquirePullRequestObservation(input) {
    const remote = input.remote || "origin";
    if (!input.repository)
        throw new Error("repository observation failed: missing repository identity");
    if (!input.eventBaseSha)
        throw new Error("repository observation failed: missing event base SHA");
    if (!input.headSha)
        throw new Error("repository observation failed: missing PR head SHA");
    const eventBase = exactCommit(input.eventBaseSha, input.cwd, "event BASE");
    if (input.baseRef)
        refreshRemoteBaseRef(input.baseRef, input.cwd, remote);
    const base = input.baseRef
        ? exactCommit(`refs/remotes/${remote}/${input.baseRef}`, input.cwd, "current BASE")
        : eventBase;
    const head = exactCommit(input.headSha, input.cwd, "PR HEAD");
    let mergeBase;
    try {
        mergeBase = runGit(["merge-base", base, head], { cwd: input.cwd }).trim();
    }
    catch {
        throw new Error("repository observation failed: missing merge base");
    }
    if (!mergeBase)
        throw new Error("repository observation failed: missing merge base");
    const baseTree = exactTree(base, input.cwd, "BASE");
    const mergeBaseTree = exactTree(mergeBase, input.cwd, "merge base");
    const headTree = exactTree(head, input.cwd, "PR HEAD");
    const checkoutCommit = exactCommit("HEAD", input.cwd, "checkout HEAD");
    const checkoutTree = exactTree(checkoutCommit, input.cwd, "checkout");
    let dirty;
    try {
        dirty = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: input.cwd }).length > 0;
    }
    catch (error) {
        throw new Error(`repository observation failed: cannot inspect checkout state: ${error.message}`);
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
function diffArgs(...args) {
    return ["-c", "core.quotepath=false", "diff", ...args];
}
function selectedDiffOperands(base, head, cwd) {
    if (base && head)
        return [`${base}...${head}`];
    const staged = runGit(diffArgs("--cached"), { cwd });
    return staged.trim() ? ["--cached"] : ["HEAD"];
}
export function getDiff(base, head, cwd) {
    if (base && head) {
        return runGit(diffArgs(`${base}...${head}`), { cwd });
    }
    const staged = runGit(diffArgs("--cached"), { cwd });
    if (staged.trim())
        return staged;
    return runGit(diffArgs("HEAD"), { cwd });
}
export function getDiffObservation(base, head, cwd) {
    const operands = selectedDiffOperands(base, head, cwd);
    const diffText = runGit(diffArgs(...operands), { cwd });
    const nameStatusZ = runGit(["diff", "--name-status", "-z", ...operands], { cwd });
    return { diffText, files: parseMachineDiff(diffText, nameStatusZ) };
}
export function readFileAtRef(ref, path, cwd) {
    if (!ref || !path)
        return null;
    return runGit(["show", `${ref}:${path}`], { cwd });
}
export function readBasePolicy(base, cwd, policyPath = "repo-policy.json") {
    if (!base)
        return { policy: null, error: "no_base_ref" };
    let raw;
    try {
        raw = readFileAtRef(base, policyPath, cwd);
    }
    catch (e) {
        return { policy: null, error: `git_show_failed: ${e.message}` };
    }
    if (raw == null)
        return { policy: null, error: "empty_base_policy" };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return { policy: null, error: `base_policy_parse_error: ${e.message}` };
    }
    return { policy: parsed, error: null };
}
export function readBaseGovernancePaths(base, cwd, policyPath = "repo-policy.json") {
    const result = readBasePolicy(base, cwd, policyPath);
    if (result.error)
        return { governancePaths: null, error: result.error };
    const list = result.policy?.paths?.governance_paths;
    if (!Array.isArray(list))
        return { governancePaths: [], error: null };
    return { governancePaths: list, error: null };
}
