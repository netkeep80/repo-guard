import {
  planParallelMigration,
  type ParallelMigrationBlocker,
  type ParallelMigrationProvider,
} from "./migration-plan.mjs";

export interface MigrationFileAdapter {
  read(path: string): string | null | undefined;
  create(path: string, content: string): void;
  replace(path: string, expectedBefore: string, content: string): void;
}

export interface ApplyParallelMigrationInput {
  provider: ParallelMigrationProvider;
  actionRef: string;
  io: MigrationFileAdapter;
}

export interface MigrationApplyBlocker {
  id: "stale_snapshot";
  path: string;
  message: string;
}

const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";
const MIGRATION_PATHS = [PORTABLE, NATIVE, TRANSACTION, POLICY] as const;

function snapshot(io: MigrationFileAdapter) {
  return Object.fromEntries(MIGRATION_PATHS.map((path) => [path, io.read(path)]));
}

export function applyParallelMigration(input: ApplyParallelMigrationInput) {
  const before = snapshot(input.io);
  const plan = planParallelMigration({
    provider: input.provider,
    actionRef: input.actionRef,
    files: before,
  });

  if (!plan.readyToApply) {
    return { ...plan, applied: false as const, writes: [] as string[] };
  }

  const current = snapshot(input.io);
  const driftPath = MIGRATION_PATHS.find((path) => current[path] !== before[path]);
  if (driftPath) {
    const blocker: MigrationApplyBlocker = {
      id: "stale_snapshot",
      path: driftPath,
      message: `${driftPath} changed after migration planning; refusing to apply any writes.`,
    };
    return {
      ...plan,
      readyToApply: false,
      blockers: [...plan.blockers, blocker] as Array<ParallelMigrationBlocker | MigrationApplyBlocker>,
      applied: false as const,
      writes: [] as string[],
    };
  }

  const writes: string[] = [];
  for (const file of plan.files) {
    if (file.action === "unchanged") continue;
    if (file.action === "create") {
      input.io.create(file.path, file.after);
      writes.push(file.path);
      continue;
    }
    if (file.action === "replace") {
      input.io.replace(file.path, file.before as string, file.after);
      writes.push(file.path);
      continue;
    }
    throw new Error(`Invariant violation: blocked migration action reached apply for ${file.path}`);
  }

  return { ...plan, applied: true as const, writes };
}
