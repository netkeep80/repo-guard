import { execFileSync } from "node:child_process";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PARALLEL_RULE_TYPES = new Set(["pull_request", "required_status_checks", "merge_queue"]);
function fail(error, message) {
    return { ok: false, error, message };
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function defaultRun(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: options.cwd,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30000,
    });
}
function errorText(error) {
    if (!isRecord(error))
        return String(error);
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const message = typeof error.message === "string" ? error.message.trim() : "";
    return [stderr, message].filter(Boolean).join("\n") || "unknown command failure";
}
function parseJson(text, label) {
    try {
        return { ok: true, value: JSON.parse(text) };
    }
    catch (error) {
        return fail("malformed_github_response", `${label}: ${error.message}`);
    }
}
function repositoryFromRemote(remote) {
    const value = remote.trim();
    for (const pattern of [
        /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
        /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
        /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    ]) {
        const match = pattern.exec(value);
        if (match)
            return `${match[1]}/${match[2]}`;
    }
    return null;
}
function resolveRepository(input, run) {
    const fromEnv = input.env?.GITHUB_REPOSITORY;
    if (fromEnv !== undefined) {
        if (!REPOSITORY.test(fromEnv))
            return fail("invalid_repository", "GITHUB_REPOSITORY must use owner/name form");
        return { ok: true, repository: fromEnv };
    }
    try {
        const repository = repositoryFromRemote(run("git", ["remote", "get-url", "origin"], { cwd: input.repoRoot }));
        return repository ? { ok: true, repository } : fail("repository_not_resolved", "origin must be a github.com owner/name repository");
    }
    catch (error) {
        return fail("repository_not_resolved", `cannot read origin: ${errorText(error)}`);
    }
}
function apiJson(run, repoRoot, endpoint, extraArgs = []) {
    try {
        const parsed = parseJson(run("gh", ["api", endpoint, ...extraArgs], { cwd: repoRoot }), endpoint);
        return parsed.ok ? parsed : parsed;
    }
    catch (error) {
        return fail("github_api_error", errorText(error));
    }
}
function readBranchProtection(run, repoRoot, repository, branch, errors) {
    const endpoint = `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`;
    try {
        const parsed = parseJson(run("gh", ["api", endpoint], { cwd: repoRoot }), endpoint);
        if (!parsed.ok || !isRecord(parsed.value)) {
            errors.push({ id: "branch_protection_api_error", message: parsed.ok ? "branch protection response must be an object" : parsed.message });
            return { complete: false, protected: null, data: null };
        }
        return { complete: true, protected: true, data: parsed.value };
    }
    catch (error) {
        const text = errorText(error);
        if (/Branch not protected/i.test(text) && /404/.test(text))
            return { complete: true, protected: false, data: null };
        errors.push({ id: "branch_protection_api_error", message: text });
        return { complete: false, protected: null, data: null };
    }
}
function readActiveRules(run, repoRoot, repository, branch, errors) {
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
    if (pages.every(Array.isArray))
        return { complete: true, rules: pages.flat() };
    return { complete: true, rules: pages };
}
function activeRulesetIds(rules) {
    const ids = new Set();
    for (const rule of rules) {
        if (!isRecord(rule) || !PARALLEL_RULE_TYPES.has(rule.type))
            continue;
        if (Number.isInteger(rule.ruleset_id) && rule.ruleset_id >= 0)
            ids.add(rule.ruleset_id);
    }
    return [...ids].sort((left, right) => left - right);
}
function readRulesets(run, repoRoot, repository, activeRules, errors) {
    if (!activeRules.complete || !activeRules.rules)
        return { complete: false, items: null };
    const ids = activeRulesetIds(activeRules.rules);
    const items = [];
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
export function readGitHubControlPlane(input) {
    if (input.provider !== "portable" && input.provider !== "github_merge_queue") {
        return fail("invalid_provider", "provider must be portable or github_merge_queue");
    }
    if (typeof input.repoRoot !== "string" || input.repoRoot.length === 0)
        return fail("invalid_repo_root", "repoRoot must be a non-empty string");
    const run = input.run ?? defaultRun;
    const repositoryResult = resolveRepository({ ...input, env: input.env ?? process.env }, run);
    if (!repositoryResult.ok)
        return repositoryResult;
    const repository = repositoryResult.repository;
    const metadata = apiJson(run, input.repoRoot, `repos/${repository}`);
    if (!metadata.ok)
        return fail("repository_metadata_api_error", metadata.message);
    if (!isRecord(metadata.value) || typeof metadata.value.default_branch !== "string" || metadata.value.default_branch.length === 0) {
        return fail("repository_metadata_malformed", "repository metadata must contain default_branch");
    }
    const defaultBranch = metadata.value.default_branch;
    const errors = [];
    const branchProtection = readBranchProtection(run, input.repoRoot, repository, defaultBranch, errors);
    const activeBranchRules = readActiveRules(run, input.repoRoot, repository, defaultBranch, errors);
    const rulesets = readRulesets(run, input.repoRoot, repository, activeBranchRules, errors);
    return {
        ok: true,
        provider: input.provider,
        repository,
        defaultBranch,
        branchProtection,
        activeBranchRules,
        rulesets,
        errors,
    };
}
