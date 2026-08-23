import {
  planPortableIntegration,
  type PortableIntegrationDecision,
} from "./planner.mjs";

type MergeMethod = "merge" | "squash" | "rebase";
type MutationKind = "none" | "refresh_branch" | "merge_exact_head";
type PassKind =
  | "invalid_input"
  | "invalid_inventory"
  | "idle"
  | "observed"
  | "mutation_attempted";

type ReadyInventory = {
  repository: string;
  readyPrNumbers: number[];
};

type UpdateBranch = (input: {
  repository: string;
  prNumber: number;
  expectedHeadSha: string;
}) => Promise<unknown>;

type MergeExactHead = (input: {
  repository: string;
  prNumber: number;
  expectedHeadSha: string;
  mergeMethod: MergeMethod;
}) => Promise<unknown>;

type CandidateLoader = (prNumber: number) => Promise<unknown>;

export interface PortableCoordinatorPassResult {
  kind: PassKind;
  repository: string | null;
  prNumber: number | null;
  mainSha: string | null;
  headSha: string | null;
  decision: PortableIntegrationDecision | null;
  mutation: MutationKind;
  result: unknown;
  error?: string;
  message?: string;
}

type LooseObject = Record<string, unknown>;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MERGE_METHODS = new Set<MergeMethod>(["merge", "squash", "rebase"]);

function isObject(value: unknown): value is LooseObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRepository(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY.test(value);
}

function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === "string" && MERGE_METHODS.has(value as MergeMethod);
}

function invalid(
  kind: "invalid_input" | "invalid_inventory",
  error: string,
  message: string,
): PortableCoordinatorPassResult {
  return {
    kind,
    repository: null,
    prNumber: null,
    mainSha: null,
    headSha: null,
    decision: null,
    mutation: "none",
    result: null,
    error,
    message,
  };
}

function normalizeInventory(input: unknown):
  | { ok: true; value: ReadyInventory }
  | { ok: false; result: PortableCoordinatorPassResult } {
  if (!isObject(input)) {
    return {
      ok: false,
      result: invalid("invalid_inventory", "malformed_inventory", "READY inventory must be an object"),
    };
  }

  if (input.ok === false) {
    const error = typeof input.error === "string" ? input.error : "inventory_unavailable";
    const message = typeof input.message === "string" ? input.message : "READY inventory is unavailable or incomplete";
    return { ok: false, result: invalid("invalid_inventory", error, message) };
  }

  if (input.ok !== true || !isRepository(input.repository) || !Array.isArray(input.readyPrNumbers)) {
    return {
      ok: false,
      result: invalid("invalid_inventory", "malformed_inventory", "READY inventory is malformed"),
    };
  }

  const seen = new Set<number>();
  const readyPrNumbers: number[] = [];
  for (const value of input.readyPrNumbers) {
    if (!isPositiveInteger(value) || seen.has(value)) {
      return {
        ok: false,
        result: invalid(
          "invalid_inventory",
          "invalid_ready_membership",
          "READY inventory must contain unique positive PR numbers",
        ),
      };
    }
    seen.add(value);
    readyPrNumbers.push(value);
  }

  readyPrNumbers.sort((left, right) => left - right);
  return {
    ok: true,
    value: {
      repository: input.repository,
      readyPrNumbers,
    },
  };
}

function observed(
  repository: string,
  decision: PortableIntegrationDecision | null,
  error?: string,
  message?: string,
): PortableCoordinatorPassResult {
  return {
    kind: "observed",
    repository,
    prNumber: decision?.prNumber ?? null,
    mainSha: decision?.mainSha ?? null,
    headSha: decision?.headSha ?? null,
    decision,
    mutation: "none",
    result: null,
    ...(error === undefined ? {} : { error }),
    ...(message === undefined ? {} : { message }),
  };
}

function mutationAttempt(
  repository: string,
  decision: PortableIntegrationDecision,
  mutation: Exclude<MutationKind, "none">,
  result: unknown,
): PortableCoordinatorPassResult {
  return {
    kind: "mutation_attempted",
    repository,
    prNumber: decision.prNumber,
    mainSha: decision.mainSha,
    headSha: decision.headSha,
    decision,
    mutation,
    result,
  };
}

export async function runPortableCoordinatorPass(input: unknown): Promise<PortableCoordinatorPassResult> {
  if (!isObject(input)) {
    return invalid("invalid_input", "malformed_input", "coordinator input must be an object");
  }

  if (!isMergeMethod(input.mergeMethod)) {
    return invalid("invalid_input", "invalid_merge_method", "merge method must be merge, squash, or rebase");
  }

  if (typeof input.loadCandidate !== "function"
    || typeof input.updateBranch !== "function"
    || typeof input.mergeExactHead !== "function") {
    return invalid("invalid_input", "invalid_dependencies", "coordinator dependencies must be callable");
  }

  const normalizedInventory = normalizeInventory(input.inventory);
  if (!normalizedInventory.ok) return normalizedInventory.result;

  const { repository, readyPrNumbers } = normalizedInventory.value;
  if (readyPrNumbers.length === 0) {
    return {
      kind: "idle",
      repository,
      prNumber: null,
      mainSha: null,
      headSha: null,
      decision: null,
      mutation: "none",
      result: null,
    };
  }

  const loadCandidate = input.loadCandidate as CandidateLoader;
  const updateBranch = input.updateBranch as UpdateBranch;
  const mergeExactHead = input.mergeExactHead as MergeExactHead;
  let lastObservation: PortableCoordinatorPassResult | null = null;

  for (const readyPrNumber of readyPrNumbers) {
    let snapshot: unknown;
    try {
      snapshot = await loadCandidate(readyPrNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastObservation = observed(repository, null, "candidate_load_error", message);
      continue;
    }

    const decision = planPortableIntegration(snapshot);

    if (decision.prNumber !== null && decision.prNumber !== readyPrNumber) {
      lastObservation = observed(
        repository,
        decision,
        "candidate_identity_mismatch",
        `READY PR ${readyPrNumber} loaded snapshot for PR ${decision.prNumber}`,
      );
      continue;
    }

    if (decision.kind === "refresh_branch") {
      if (decision.prNumber === null || decision.headSha === null) {
        lastObservation = observed(repository, decision, "missing_mutation_identity", "refresh decision lacks exact PR/head identity");
        continue;
      }

      let result: unknown;
      try {
        result = await updateBranch({
          repository,
          prNumber: decision.prNumber,
          expectedHeadSha: decision.headSha,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { ok: false, error: "mutation_transport_error", message };
      }
      return mutationAttempt(repository, decision, "refresh_branch", result);
    }

    if (decision.kind === "merge_exact_head") {
      if (decision.prNumber === null || decision.headSha === null) {
        lastObservation = observed(repository, decision, "missing_mutation_identity", "merge decision lacks exact PR/head identity");
        continue;
      }

      let result: unknown;
      try {
        result = await mergeExactHead({
          repository,
          prNumber: decision.prNumber,
          expectedHeadSha: decision.headSha,
          mergeMethod: input.mergeMethod,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { ok: false, error: "mutation_transport_error", message };
      }
      return mutationAttempt(repository, decision, "merge_exact_head", result);
    }

    lastObservation = observed(repository, decision);
  }

  return lastObservation ?? {
    kind: "idle",
    repository,
    prNumber: null,
    mainSha: null,
    headSha: null,
    decision: null,
    mutation: "none",
    result: null,
  };
}
