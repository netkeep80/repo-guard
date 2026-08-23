type MergeMethod = "merge" | "squash" | "rebase";
type OutputFormat = "text" | "json";
type RequiredCheck = { name: string };
type Failure = { ok: false; error: string; message: string };
type Success = {
  ok: true;
  value: {
    repository: string;
    readyLabel: string;
    mergeMethod: MergeMethod;
    requiredChecks: {
      transaction: RequiredCheck[];
      state: RequiredCheck[];
    };
    format: OutputFormat;
  };
};

export type PortableCoordinatorArgsResult = Failure | Success;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MERGE_METHODS = new Set<MergeMethod>(["merge", "squash", "rebase"]);
const FORMATS = new Set<OutputFormat>(["text", "json"]);
const SINGLETON_OPTIONS = new Set(["--repository", "--ready-label", "--merge-method", "--format"]);
const REPEATABLE_OPTIONS = new Set(["--transaction-check", "--state-check"]);

function fail(error: string, message: string): Failure {
  return { ok: false, error, message };
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeChecks(values: string[]): RequiredCheck[] {
  return [...new Set(values)].sort().map((name) => ({ name }));
}

export function parsePortableCoordinatorArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): PortableCoordinatorArgsResult {
  const singletons = new Map<string, string>();
  const transaction: string[] = [];
  const state: string[] = [];

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
  if (!nonEmpty(mergeMethod) || !MERGE_METHODS.has(mergeMethod as MergeMethod)) {
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
  if (!FORMATS.has(rawFormat as OutputFormat)) {
    return fail("invalid_format", "format must be text or json");
  }

  return {
    ok: true,
    value: {
      repository,
      readyLabel,
      mergeMethod: mergeMethod as MergeMethod,
      requiredChecks: {
        transaction: transactionChecks,
        state: stateChecks,
      },
      format: rawFormat as OutputFormat,
    },
  };
}
