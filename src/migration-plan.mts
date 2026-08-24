import { renderInitScaffold } from "./init.mjs";

export type ParallelMigrationProvider = "portable" | "github_merge_queue";
type CanonicalMode = "blocking" | "advisory";
type PresetName = "application" | "library" | "tooling" | "documentation";
export type MigrationFileContent = string | null | undefined;

export interface ParallelMigrationInput {
  provider: ParallelMigrationProvider;
  actionRef: string;
  files: Record<string, MigrationFileContent>;
}

export interface ParallelMigrationFilePlan {
  path: string;
  action: "create" | "replace" | "delete" | "unchanged" | "blocked";
  before: MigrationFileContent;
  after: MigrationFileContent;
}

export interface ParallelMigrationBlocker {
  id: "custom_file" | "unknown_scaffold" | "invalid_action_ref" | "provider_conflict";
  path?: string;
  message: string;
}

export interface ParallelMigrationExternalStep {
  id: "branch_protection" | "ready_label" | "merge_queue";
  message: string;
}

export interface ParallelMigrationPlan {
  provider: ParallelMigrationProvider;
  actionRef: string;
  readyToApply: boolean;
  files: ParallelMigrationFilePlan[];
  blockers: ParallelMigrationBlocker[];
  external: ParallelMigrationExternalStep[];
}

const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";
const PRESETS: PresetName[] = ["application", "library", "tooling", "documentation"];
const MODES: CanonicalMode[] = ["blocking", "advisory"];
const IMMUTABLE_REF = /^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)$/i;

function providerPath(provider: ParallelMigrationProvider) {
  return provider === "portable" ? PORTABLE : NATIVE;
}

function oppositeProviderPath(provider: ParallelMigrationProvider) {
  return provider === "portable" ? NATIVE : PORTABLE;
}

function externalSteps(provider: ParallelMigrationProvider): ParallelMigrationExternalStep[] {
  return provider === "portable"
    ? [
        { id: "branch_protection", message: "Configure required PR/state checks before enabling portable integration." },
        { id: "ready_label", message: "Create and operationally reserve the repo-guard:ready label." },
      ]
    : [
        { id: "merge_queue", message: "Enable GitHub Merge Queue only after repository readiness is green." },
      ];
}

function rollbackExternalSteps(provider: ParallelMigrationProvider): ParallelMigrationExternalStep[] {
  return provider === "portable"
    ? [
        { id: "ready_label", message: "Stop using the repo-guard:ready signal before relaxing portable branch protection." },
        { id: "branch_protection", message: "Remove only the parallel-specific portable protection delta after coordinator use is disabled." },
      ]
    : [
        { id: "merge_queue", message: "Disable the native merge queue before restoring legacy repository files." },
      ];
}

function scaffold(preset: PresetName, mode: CanonicalMode, actionRef: string, parallel: ParallelMigrationProvider | null) {
  return renderInitScaffold({ preset, mode, actionRef, parallel });
}

function matches(content: MigrationFileContent, ...known: string[]) {
  return typeof content === "string" && known.includes(content);
}

function resolveKnownScaffold(input: ParallelMigrationInput) {
  const currentPolicy = input.files[POLICY];
  const currentTransaction = input.files[TRANSACTION];
  const candidates = PRESETS.flatMap((preset) => MODES.map((mode) => {
    const legacy = scaffold(preset, mode, input.actionRef, null);
    const target = scaffold(preset, mode, input.actionRef, input.provider);
    const policyKnown = matches(currentPolicy, legacy[POLICY], target[POLICY]);
    const transactionKnown = matches(currentTransaction, legacy[TRANSACTION], target[TRANSACTION]);
    return { preset, mode, legacy, target, policyKnown, transactionKnown };
  }));

  const exact = candidates.filter(({ policyKnown, transactionKnown }) => policyKnown && transactionKnown);
  if (exact.length === 1) return exact[0];

  const policyIdentified = candidates.filter(({ policyKnown }) => policyKnown);
  if (policyIdentified.length === 1) return policyIdentified[0];

  const transactionIdentified = candidates.filter(({ transactionKnown }) => transactionKnown);
  return transactionIdentified.length === 1 ? transactionIdentified[0] : null;
}

function validateInput(input: ParallelMigrationInput, external: ParallelMigrationExternalStep[]) {
  const blockers: ParallelMigrationBlocker[] = [];
  if (!IMMUTABLE_REF.test(input.actionRef)) {
    blockers.push({ id: "invalid_action_ref", message: `Action ref ${input.actionRef} is mutable or ambiguous; use a full commit SHA or exact vX.Y.Z tag.` });
    return { blockers, known: null, terminal: { provider: input.provider, actionRef: input.actionRef, readyToApply: false, files: [], blockers, external } as ParallelMigrationPlan };
  }

  const known = resolveKnownScaffold(input);
  if (!known) {
    blockers.push({ id: "unknown_scaffold", message: "Cannot prove the repository matches a known repo-guard v2 scaffold." });
    return { blockers, known: null, terminal: { provider: input.provider, actionRef: input.actionRef, readyToApply: false, files: [], blockers, external } as ParallelMigrationPlan };
  }

  const oppositePath = oppositeProviderPath(input.provider);
  if (input.files[oppositePath] !== null && input.files[oppositePath] !== undefined) {
    blockers.push({
      id: "provider_conflict",
      path: oppositePath,
      message: `${oppositePath} already exists; refusing to switch or combine parallel providers automatically.`,
    });
  }
  return { blockers, known, terminal: null };
}

function planKnownFile(
  path: string,
  before: MigrationFileContent,
  legacy: string,
  target: string,
  blockers: ParallelMigrationBlocker[],
): ParallelMigrationFilePlan {
  if (before === target) return { path, action: "unchanged", before, after: target };
  if (before === legacy) return { path, action: "replace", before, after: target };
  blockers.push({ id: "custom_file", path, message: `${path} is not an exact repo-guard generated template; refusing to rewrite it.` });
  return { path, action: "blocked", before, after: target };
}

function planProviderFile(
  path: string,
  before: MigrationFileContent,
  target: string,
  blockers: ParallelMigrationBlocker[],
): ParallelMigrationFilePlan {
  if (before === target) return { path, action: "unchanged", before, after: target };
  if (before === null || before === undefined) return { path, action: "create", before, after: target };
  blockers.push({ id: "custom_file", path, message: `${path} already exists but is not the exact repo-guard generated template; refusing to rewrite it.` });
  return { path, action: "blocked", before, after: target };
}

function planRollbackKnownFile(
  path: string,
  before: MigrationFileContent,
  legacy: string,
  target: string,
  blockers: ParallelMigrationBlocker[],
): ParallelMigrationFilePlan {
  if (before === legacy) return { path, action: "unchanged", before, after: legacy };
  if (before === target) return { path, action: "replace", before, after: legacy };
  blockers.push({ id: "custom_file", path, message: `${path} is not an exact repo-guard generated legacy/parallel template; refusing to roll it back.` });
  return { path, action: "blocked", before, after: legacy };
}

function planRollbackProviderFile(
  path: string,
  before: MigrationFileContent,
  target: string,
  blockers: ParallelMigrationBlocker[],
): ParallelMigrationFilePlan {
  if (before === null || before === undefined) return { path, action: "unchanged", before, after: null };
  if (before === target) return { path, action: "delete", before, after: null };
  blockers.push({ id: "custom_file", path, message: `${path} is not the exact repo-guard generated provider workflow; refusing to delete it.` });
  return { path, action: "blocked", before, after: null };
}

export function planParallelMigration(input: ParallelMigrationInput): ParallelMigrationPlan {
  const external = externalSteps(input.provider);
  const validated = validateInput(input, external);
  if (validated.terminal) return validated.terminal;
  const known = validated.known as NonNullable<typeof validated.known>;
  const blockers = validated.blockers;
  const path = providerPath(input.provider);
  const files = [
    planProviderFile(path, input.files[path], known.target[path], blockers),
    planKnownFile(TRANSACTION, input.files[TRANSACTION], known.legacy[TRANSACTION], known.target[TRANSACTION], blockers),
    planKnownFile(POLICY, input.files[POLICY], known.legacy[POLICY], known.target[POLICY], blockers),
  ];

  return {
    provider: input.provider,
    actionRef: input.actionRef,
    readyToApply: blockers.length === 0,
    files,
    blockers,
    external,
  };
}

export function planParallelRollback(input: ParallelMigrationInput): ParallelMigrationPlan {
  const external = rollbackExternalSteps(input.provider);
  const validated = validateInput(input, external);
  if (validated.terminal) return validated.terminal;
  const known = validated.known as NonNullable<typeof validated.known>;
  const blockers = validated.blockers;
  const path = providerPath(input.provider);
  const files = [
    planRollbackProviderFile(path, input.files[path], known.target[path], blockers),
    planRollbackKnownFile(TRANSACTION, input.files[TRANSACTION], known.legacy[TRANSACTION], known.target[TRANSACTION], blockers),
    planRollbackKnownFile(POLICY, input.files[POLICY], known.legacy[POLICY], known.target[POLICY], blockers),
  ];

  return {
    provider: input.provider,
    actionRef: input.actionRef,
    readyToApply: blockers.length === 0,
    files,
    blockers,
    external,
  };
}
