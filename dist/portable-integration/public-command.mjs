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
export async function runPortableCoordinatorCommand(_roots, args, env = process.env) {
    const parsed = parsePortableCoordinatorArgs(args, env);
    if (!parsed.ok)
        throw new Error(`${parsed.error}: ${parsed.message}`);
    throw new Error("portable coordinator runtime is not wired");
}
