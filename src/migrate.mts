import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateExplicitActionRef } from "./init.mjs";
import { applyParallelMigration, applyParallelRollback, type MigrationFileAdapter } from "./migration-apply.mjs";
import { planParallelMigration, planParallelRollback, type ParallelMigrationProvider } from "./migration-plan.mjs";

interface MigrateRoots {
  packageRoot: string;
  repoRoot: string;
}

type OutputFormat = "summary" | "json";
type MigrateMode = "dry-run" | "apply";

interface MigrationOutput {
  command: "migrate";
  mode: MigrateMode;
  operation?: "rollback";
  provider: ParallelMigrationProvider;
  actionRef: string;
  readyToApply: boolean;
  files: Array<{ path: string; action: string }>;
  blockers: Array<{ id: string; path?: string; message: string }>;
  external: Array<{ id: string; message: string }>;
  applied?: boolean;
  writes?: string[];
}

const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";
const PROVIDERS = new Set<ParallelMigrationProvider>(["portable", "github_merge_queue"]);
const FORMATS = new Set<OutputFormat>(["summary", "json"]);
const usage = "Usage: repo-guard migrate --parallel <portable|github_merge_queue> --action-ref <40-char-sha|vX.Y.Z> [--rollback] (--dry-run|--apply) [--format <summary|json>]";

function packageVersion(packageRoot: string) {
  const parsed = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version) throw new Error("Cannot determine repo-guard package version");
  return parsed.version;
}

function readOptional(repoRoot: string, path: string) {
  const target = resolve(repoRoot, path);
  return existsSync(target) ? readFileSync(target, "utf8") : null;
}

function migrationSnapshot(repoRoot: string) {
  return {
    [POLICY]: readOptional(repoRoot, POLICY),
    [TRANSACTION]: readOptional(repoRoot, TRANSACTION),
    [PORTABLE]: readOptional(repoRoot, PORTABLE),
    [NATIVE]: readOptional(repoRoot, NATIVE),
  };
}

function filesystemAdapter(repoRoot: string): MigrationFileAdapter {
  return {
    read: (path) => readOptional(repoRoot, path),
    create(path, content) {
      const target = resolve(repoRoot, path);
      if (existsSync(target)) throw new Error(`${path} changed after migration preflight; refusing to overwrite it.`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
    },
    replace(path, expectedBefore, content) {
      const target = resolve(repoRoot, path);
      const current = readOptional(repoRoot, path);
      if (current !== expectedBefore) throw new Error(`${path} changed after migration preflight; refusing to overwrite it.`);
      writeFileSync(target, content, "utf8");
    },
    delete(path, expectedBefore) {
      const target = resolve(repoRoot, path);
      const current = readOptional(repoRoot, path);
      if (current !== expectedBefore) throw new Error(`${path} changed after migration preflight; refusing to delete it.`);
      rmSync(target);
    },
  };
}

function renderSummary(payload: MigrationOutput) {
  const lines = [
    `repo-guard migrate (${payload.mode})`,
    ...(payload.operation ? [`operation: ${payload.operation}`] : []),
    `provider: ${payload.provider}`,
    `action-ref: ${payload.actionRef}`,
    `ready-to-apply: ${payload.readyToApply ? "yes" : "no"}`,
    "files:",
    ...payload.files.map(({ action, path }) => `  ${action}: ${path}`),
  ];
  if (payload.applied !== undefined) lines.push(`applied: ${payload.applied ? "yes" : "no"}`);
  if (payload.writes?.length) lines.push("writes:", ...payload.writes.map((path) => `  ${path}`));
  if (payload.blockers.length) {
    lines.push("blockers:", ...payload.blockers.map(({ id, path, message }) => `  ${id}${path ? ` (${path})` : ""}: ${message}`));
  }
  if (payload.external.length) {
    lines.push("external:", ...payload.external.map(({ id, message }) => `  ${id}: ${message}`));
  }
  return lines.join("\n");
}

function printPayload(payload: MigrationOutput, format: OutputFormat) {
  console.log(format === "json" ? JSON.stringify(payload, null, 2) : renderSummary(payload));
}

export function runMigrate(roots: MigrateRoots, args: string[] = []) {
  let provider: ParallelMigrationProvider | null = null;
  let actionRef: string | null = null;
  let format: OutputFormat = "summary";
  let dryRun = false;
  let apply = false;
  let rollback = false;

  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--dry-run" || option === "--apply" || option === "--rollback") {
      if (option === "--dry-run") dryRun = true;
      else if (option === "--apply") apply = true;
      else rollback = true;
      continue;
    }
    if (["--parallel", "--action-ref", "--format"].includes(option)) {
      const value = args[++i];
      if (!value) {
        console.error(`Missing value for ${option}\n${usage}`);
        return 1;
      }
      if (option === "--parallel") {
        if (!PROVIDERS.has(value as ParallelMigrationProvider)) {
          console.error(`Unknown parallel provider: ${value}\n${usage}`);
          return 1;
        }
        provider = value as ParallelMigrationProvider;
      } else if (option === "--action-ref") {
        actionRef = value;
      } else {
        if (!FORMATS.has(value as OutputFormat)) {
          console.error(`Unknown migrate format: ${value}\n${usage}`);
          return 1;
        }
        format = value as OutputFormat;
      }
      continue;
    }
    if (option === "--help") {
      console.log(usage);
      return 0;
    }
    console.error(`Unknown option for migrate: ${option}\n${usage}`);
    return 1;
  }

  if (dryRun === apply) {
    console.error(`migrate requires exactly one of --dry-run or --apply\n${usage}`);
    return 1;
  }
  if (!provider) {
    console.error(`Missing required --parallel provider\n${usage}`);
    return 1;
  }
  if (!actionRef) {
    console.error(`Missing required --action-ref\n${usage}`);
    return 1;
  }

  let refCheck: ReturnType<typeof validateExplicitActionRef>;
  try {
    refCheck = validateExplicitActionRef(actionRef, packageVersion(roots.packageRoot));
  } catch (error: unknown) {
    console.error((error as Error).message);
    return 1;
  }
  if (!refCheck.ok) {
    console.error(refCheck.message);
    return 1;
  }
  const immutableRef = refCheck.ref as string;

  if (dryRun) {
    const planner = rollback ? planParallelRollback : planParallelMigration;
    const plan = planner({
      provider,
      actionRef: immutableRef,
      files: migrationSnapshot(roots.repoRoot),
    });
    const payload: MigrationOutput = rollback
      ? { command: "migrate", mode: "dry-run", operation: "rollback", ...plan }
      : { command: "migrate", mode: "dry-run", ...plan };
    printPayload(payload, format);
    return plan.readyToApply ? 0 : 1;
  }

  const applier = rollback ? applyParallelRollback : applyParallelMigration;
  const result = applier({
    provider,
    actionRef: immutableRef,
    io: filesystemAdapter(roots.repoRoot),
  });
  const payload: MigrationOutput = rollback
    ? { command: "migrate", mode: "apply", operation: "rollback", ...result }
    : { command: "migrate", mode: "apply", ...result };
  printPayload(payload, format);
  return result.applied && result.readyToApply ? 0 : 1;
}
