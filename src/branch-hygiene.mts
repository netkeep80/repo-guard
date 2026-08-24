type Failure = { ok: false; error: string; message: string };

type BranchFact = {
  name: string;
  sha: string;
  protected: boolean;
};

type PullRequestHeadFact = {
  number: number;
  name: string;
  sha: string;
};

type OwnershipState = "live" | "handoff" | "stale_candidate";

type OwnershipFact = {
  name: string;
  state: OwnershipState;
};

type Envelope<T> = {
  complete: boolean;
  items: T[] | null;
};

type OwnedBranchProjection = {
  name: string;
  sha: string;
  state: "live" | "handoff";
};

type StaleOwnershipProjection = {
  name: string;
  sha: string;
  state: "stale_candidate";
};

type DeleteBranchOnMergeDrift = {
  state: "disabled" | "residual" | "clean" | "unknown";
  residualMergedBranchCount: number;
};

type Success = {
  ok: true;
  persistentBranches: BranchFact[];
  activePullRequestHeads: PullRequestHeadFact[];
  ownedPrePullRequestBranches: OwnedBranchProjection[];
  staleOwnershipBranches: StaleOwnershipProjection[];
  orphanCandidates: BranchFact[];
  mergedPullRequestHeadsStillPresent: PullRequestHeadFact[];
  deleteBranchOnMergeDrift: DeleteBranchOnMergeDrift;
};

const SHA = /^[0-9a-f]{40}$/i;
const OWNERSHIP_STATES = new Set<OwnershipState>(["live", "handoff", "stale_candidate"]);

function fail(error: string, message: string): Failure {
  return { ok: false, error, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function normalizeBranchEnvelope(value: unknown): Envelope<BranchFact> | null {
  if (!isRecord(value) || value.complete !== true || !Array.isArray(value.items)) return null;
  const names = new Set<string>();
  const items: BranchFact[] = [];
  for (const item of value.items) {
    if (!isRecord(item) || !isNonEmptyString(item.name) || !isSha(item.sha) || typeof item.protected !== "boolean" || names.has(item.name)) return null;
    names.add(item.name);
    items.push({ name: item.name, sha: item.sha, protected: item.protected });
  }
  return { complete: true, items };
}

function normalizePullRequestHeadEnvelope(value: unknown): Envelope<PullRequestHeadFact> | null {
  if (!isRecord(value) || value.complete !== true || !Array.isArray(value.items)) return null;
  const names = new Set<string>();
  const items: PullRequestHeadFact[] = [];
  for (const item of value.items) {
    if (!isRecord(item) || !isPositiveInteger(item.number) || !isNonEmptyString(item.name) || !isSha(item.sha) || names.has(item.name)) return null;
    names.add(item.name);
    items.push({ number: item.number, name: item.name, sha: item.sha });
  }
  return { complete: true, items };
}

function normalizeOwnershipEnvelope(value: unknown): Envelope<OwnershipFact> | null {
  if (value === undefined || value === null) return { complete: true, items: [] };
  if (!isRecord(value) || value.complete !== true || !Array.isArray(value.items)) return null;
  const names = new Set<string>();
  const items: OwnershipFact[] = [];
  for (const item of value.items) {
    if (!isRecord(item) || !isNonEmptyString(item.name) || typeof item.state !== "string"
      || !OWNERSHIP_STATES.has(item.state as OwnershipState) || names.has(item.name)) return null;
    names.add(item.name);
    items.push({ name: item.name, state: item.state as OwnershipState });
  }
  return { complete: true, items };
}

function normalizePersistentBranches(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  for (const item of value) {
    if (!isNonEmptyString(item)) return null;
    names.add(item);
  }
  return [...names];
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name);
}

function deleteBranchOnMergeDrift(setting: boolean | null, residualCount: number): DeleteBranchOnMergeDrift {
  if (setting === null) return { state: "unknown", residualMergedBranchCount: residualCount };
  if (setting === false) return { state: "disabled", residualMergedBranchCount: residualCount };
  if (residualCount > 0) return { state: "residual", residualMergedBranchCount: residualCount };
  return { state: "clean", residualMergedBranchCount: 0 };
}

export function analyzeBranchHygiene(input: unknown): Failure | Success {
  if (!isRecord(input) || !isNonEmptyString(input.defaultBranch)
    || !(typeof input.deleteBranchOnMerge === "boolean" || input.deleteBranchOnMerge === null)) {
    return fail("invalid_branch_hygiene_facts", "branch hygiene input must contain defaultBranch and boolean/null deleteBranchOnMerge");
  }

  const branches = normalizeBranchEnvelope(input.branchInventory);
  const openHeads = normalizePullRequestHeadEnvelope(input.openSameRepositoryPullRequestHeads);
  const mergedHeads = normalizePullRequestHeadEnvelope(input.mergedSameRepositoryPullRequestHeads);
  const ownership = normalizeOwnershipEnvelope(input.durableOwnership);
  const persistentNames = normalizePersistentBranches(input.persistentBranches);
  if (branches === null || openHeads === null || mergedHeads === null || ownership === null || persistentNames === null) {
    return fail("incomplete_branch_hygiene_facts", "branch inventory, PR heads, merged heads, persistent exemptions and supplied ownership must be complete and valid");
  }

  const branchItems = branches.items as BranchFact[];
  const branchByName = new Map(branchItems.map((item) => [item.name, item]));
  if (!branchByName.has(input.defaultBranch)) {
    return fail("default_branch_missing", `default branch ${input.defaultBranch} is absent from branch inventory`);
  }

  const openItems = openHeads.items as PullRequestHeadFact[];
  for (const head of openItems) {
    const current = branchByName.get(head.name);
    if (current === undefined || current.sha !== head.sha) {
      return fail("branch_fact_race", `open PR head ${head.name} does not match current branch inventory`);
    }
  }

  const persistent = new Set<string>([input.defaultBranch, ...persistentNames]);
  const openByName = new Map(openItems.map((item) => [item.name, item]));
  const ownershipItems = ownership.items as OwnershipFact[];
  const ownershipByName = new Map(ownershipItems.map((item) => [item.name, item]));
  const mergedItems = mergedHeads.items as PullRequestHeadFact[];

  const persistentBranches: BranchFact[] = [];
  const ownedPrePullRequestBranches: OwnedBranchProjection[] = [];
  const staleOwnershipBranches: StaleOwnershipProjection[] = [];
  const orphanCandidates: BranchFact[] = [];

  for (const branch of branchItems) {
    if (persistent.has(branch.name)) {
      persistentBranches.push(branch);
      continue;
    }
    if (openByName.has(branch.name)) continue;

    const owner = ownershipByName.get(branch.name);
    if (owner?.state === "live" || owner?.state === "handoff") {
      ownedPrePullRequestBranches.push({ name: branch.name, sha: branch.sha, state: owner.state });
      continue;
    }
    if (owner?.state === "stale_candidate") {
      staleOwnershipBranches.push({ name: branch.name, sha: branch.sha, state: "stale_candidate" });
      continue;
    }
    orphanCandidates.push(branch);
  }

  const orphanByName = new Map(orphanCandidates.map((item) => [item.name, item]));
  const mergedPullRequestHeadsStillPresent = mergedItems
    .filter((head) => orphanByName.get(head.name)?.sha === head.sha)
    .sort(byName);

  return {
    ok: true,
    persistentBranches: persistentBranches.sort(byName),
    activePullRequestHeads: [...openItems].sort(byName),
    ownedPrePullRequestBranches: ownedPrePullRequestBranches.sort(byName),
    staleOwnershipBranches: staleOwnershipBranches.sort(byName),
    orphanCandidates: orphanCandidates.sort(byName),
    mergedPullRequestHeadsStillPresent,
    deleteBranchOnMergeDrift: deleteBranchOnMergeDrift(input.deleteBranchOnMerge, mergedPullRequestHeadsStillPresent.length),
  };
}

export function planMergedBranchDeletion(input: unknown) {
  if (!isRecord(input) || !isNonEmptyString(input.branchName) || !isPositiveInteger(input.prNumber)
    || !isSha(input.expectedHeadSha) || !isRecord(input.rereadBranch)
    || !isNonEmptyString(input.rereadBranch.name) || !isSha(input.rereadBranch.sha)) {
    return fail("invalid_deletion_evidence", "deletion planning requires branch, PR, expected head SHA and a fresh branch reread");
  }

  const analysis = analyzeBranchHygiene(input.facts);
  if (!analysis.ok) return analysis;

  const merged = analysis.mergedPullRequestHeadsStillPresent.find((head) =>
    head.number === input.prNumber && head.name === input.branchName && head.sha === input.expectedHeadSha);
  if (merged === undefined) {
    return fail("deletion_not_authorized", "branch is not an exact merged same-repository residue in the current hygiene snapshot");
  }
  if (input.rereadBranch.name !== input.branchName || input.rereadBranch.sha !== input.expectedHeadSha) {
    return fail("stale_head", "fresh branch reread no longer matches the expected merged head");
  }

  return {
    ok: true as const,
    kind: "delete_merged_branch" as const,
    branchName: input.branchName,
    prNumber: input.prNumber,
    expectedHeadSha: input.expectedHeadSha,
  };
}
