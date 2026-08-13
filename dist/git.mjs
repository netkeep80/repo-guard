import { execFileSync } from "node:child_process";
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
function diffArgs(...args) {
    return ["-c", "core.quotepath=false", "diff", ...args];
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
