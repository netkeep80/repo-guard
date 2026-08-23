import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateExplicitActionRef } from "./init.mjs";
import { planParallelMigration, type ParallelMigrationProvider } from "./migration-plan.mjs";

interface MigrateRoots {
  packageRoot: string;
  repoRoot: string;
}

type OutputFormat = "summary" | "json";

const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";
const PROVIDERS = new Set<ParallelMigrationProvider>(["portable", "github_merge_queue"]);
const FORMATS = new Set<OutputFormat>(["summary", "json"]);
const usage = "Usage: repo-guard migrate --parallel <portable|github_merge_queue> --action-ref <40-char-sha|vX.Y.Z> --dry-run [--format <summary|json>]";

function packageVersion(packageRoot: string) {
  const parsed = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version) throw new Error("Cannot determine repo-guard package version");
  return parsed.version;
}

function readOptional(repoRoot: string, path: string) {
  const target = resolve(repoRoot, path);
  return existsSync(target) ? readFileSync(target, "utf8") : null;
}

function renderSummary(payload: ReturnType<typeof migrationPayload>) {
  const lines = [
    `repo-guard migrate (${payload.mode})`,
    `provider: ${payload.provider}`,
    `action-ref: ${payload.actionRef}`,
    `ready-to-apply: ${payload.readyToApply ? "yes" : "no"}`,
    "files:",
    ...payload.files.map(({ action, path }) => `  ${action}: ${path}`),
  ];
  if (payload.blockers.length) {
    lines.push("blockers:", ...payload.blockers.map(({ id, path, message }) => `  ${id}${path ? ` (${path})` : ""}: ${message}`));
  }
  if (payload.external.length) {
    lines.push("external:", ...payload.external.map(({ id, message }) => `  ${id}: ${message}`));
  }
  return lines.join("\n");
}

function migrationPayload(plan: ReturnType<typeof planParallelMigration>) {
  return { command: "migrate" as const, mode: "dry-run" as const, ...plan };
}

export function runMigrate(roots: MigrateRoots, args: string[] = []) {
  let provider: ParallelMigrationProvider | null = null;
  let actionRef: string | null = null;
  let format: OutputFormat = "summary";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--dry-run") {
      dryRun = true;
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

  if (!dryRun) {
    console.error(`migrate is read-only in this release slice; pass --dry-run\n${usage}`);
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

  const providerPath = provider === "portable" ? PORTABLE : NATIVE;
  const plan = planParallelMigration({
    provider,
    actionRef: refCheck.ref as string,
    files: {
      [POLICY]: readOptional(roots.repoRoot, POLICY),
      [TRANSACTION]: readOptional(roots.repoRoot, TRANSACTION),
      [providerPath]: readOptional(roots.repoRoot, providerPath),
    },
  });
  const payload = migrationPayload(plan);
  console.log(format === "json" ? JSON.stringify(payload, null, 2) : renderSummary(payload));
  return plan.readyToApply ? 0 : 1;
}
