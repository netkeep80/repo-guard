import { runTrustedPortableCoordinator, } from "./trusted-command.mjs";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const FORMATS = new Set(["text", "json"]);
const SINGLETON_OPTIONS = new Set(["--repository", "--ready-label", "--merge-method", "--format"]);
const REPEATABLE_OPTIONS = new Set(["--transaction-check", "--state-check"]);
function fail(error, message) {
    return { ok: false, error, message };
}
function nonEmpty(value) {
    return typeof value === "string" && value.length > 0;
}
function normalizeChecks(values) {
    return [...new Set(values)].sort().map((name) => ({ name }));
}
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseRuntimeJson(text, label) {
    try {
        return JSON.parse(text);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`malformed_github_response: ${label}: ${message}`);
    }
}
function createReadyInventoryReader(repository, run) {
    if (run === undefined)
        return undefined;
    return async () => {
        const endpoint = `repos/${repository}/pulls?state=open&per_page=100`;
        const pages = parseRuntimeJson(run("gh", ["api", endpoint, "--paginate", "--slurp"]), endpoint);
        if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
            throw new Error("malformed_github_response: PR inventory pagination must be an array of pages");
        }
        return { complete: true, pages };
    };
}
function renderText(evidence) {
    const lines = [
        "repo-guard portable-coordinator",
        `provider: ${evidence.provider}`,
        `kind: ${evidence.kind}`,
        `repository: ${evidence.repository ?? "unknown"}`,
        `main_sha: ${evidence.main_sha ?? "unknown"}`,
        `pr: ${evidence.pr ?? "none"}`,
        `head_sha: ${evidence.head_sha ?? "unknown"}`,
        `decision: ${evidence.decision ?? "none"}`,
        `mutation: ${evidence.mutation}`,
    ];
    if (evidence.reason !== null)
        lines.push(`reason: ${evidence.reason}`);
    if (evidence.error !== undefined)
        lines.push(`error: ${evidence.error}`);
    if (evidence.message !== undefined)
        lines.push(`message: ${evidence.message}`);
    return lines.join("\n");
}
function exitCode(evidence) {
    if (evidence.error !== undefined)
        return 1;
    if (isObject(evidence.result) && evidence.result.ok === false)
        return 1;
    return 0;
}
export function parsePortableCoordinatorArgs(args, env = process.env) {
    const singletons = new Map();
    const transaction = [];
    const state = [];
    for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (!SINGLETON_OPTIONS.has(option) && !REPEATABLE_OPTIONS.has(option)) {
            return fail("unknown_option", `unknown portable coordinator option: ${option}`);
        }
        const value = args[++index];
        if (!nonEmpty(value) || value.startsWith("--")) {
            return fail("missing_option_value", `${option} requires a value`);
        }
        if (option === "--transaction-check") {
            transaction.push(value);
            continue;
        }
        if (option === "--state-check") {
            state.push(value);
            continue;
        }
        if (singletons.has(option)) {
            return fail("duplicate_option", `${option} may be specified only once`);
        }
        singletons.set(option, value);
    }
    const repository = singletons.get("--repository") ?? env.GITHUB_REPOSITORY;
    if (!nonEmpty(repository)) {
        return fail("missing_repository", "repository must be provided explicitly or by GITHUB_REPOSITORY");
    }
    if (!REPOSITORY.test(repository)) {
        return fail("malformed_repository", "repository identity must be owner/name");
    }
    const readyLabel = singletons.get("--ready-label");
    if (!nonEmpty(readyLabel)) {
        return fail("missing_ready_label", "READY label must be provided explicitly");
    }
    const mergeMethod = singletons.get("--merge-method");
    if (!nonEmpty(mergeMethod) || !MERGE_METHODS.has(mergeMethod)) {
        return fail("invalid_merge_method", "merge method must be merge, squash, or rebase");
    }
    const transactionChecks = normalizeChecks(transaction);
    if (transactionChecks.length === 0) {
        return fail("missing_transaction_checks", "at least one transaction check is required");
    }
    const stateChecks = normalizeChecks(state);
    if (stateChecks.length === 0) {
        return fail("missing_state_checks", "at least one state check is required");
    }
    const rawFormat = singletons.get("--format") ?? "text";
    if (!FORMATS.has(rawFormat)) {
        return fail("invalid_format", "format must be text or json");
    }
    return {
        ok: true,
        value: {
            repository,
            readyLabel,
            mergeMethod: mergeMethod,
            requiredChecks: {
                transaction: transactionChecks,
                state: stateChecks,
            },
            format: rawFormat,
        },
    };
}
export async function runPortableCoordinatorCommand(_roots, args, env = process.env, dependencies = {}) {
    const parsed = parsePortableCoordinatorArgs(args, env);
    if (!parsed.ok)
        throw new Error(`${parsed.error}: ${parsed.message}`);
    const readReadyInventory = dependencies.readReadyInventory
        ?? createReadyInventoryReader(parsed.value.repository, dependencies.run);
    const readCandidate = dependencies.readCandidate
        ?? (async () => { throw new Error("candidate GitHub runtime is not wired"); });
    const evidence = await runTrustedPortableCoordinator({
        repository: parsed.value.repository,
        readyLabel: parsed.value.readyLabel,
        mergeMethod: parsed.value.mergeMethod,
        requiredChecks: parsed.value.requiredChecks,
        readReadyInventory,
        readCandidate,
        mutationTransport: dependencies.mutationTransport,
    });
    const output = parsed.value.format === "json"
        ? JSON.stringify(evidence)
        : renderText(evidence);
    (dependencies.writeOutput ?? console.log)(output);
    return exitCode(evidence);
}
