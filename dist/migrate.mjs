import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateExplicitActionRef } from "./init.mjs";
import { applyParallelMigration } from "./migration-apply.mjs";
import { planParallelMigration } from "./migration-plan.mjs";
const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";
const PROVIDERS = new Set(["portable", "github_merge_queue"]);
const FORMATS = new Set(["summary", "json"]);
const usage = "Usage: repo-guard migrate --parallel <portable|github_merge_queue> --action-ref <40-char-sha|vX.Y.Z> (--dry-run|--apply) [--format <summary|json>]";
function packageVersion(packageRoot) {
    const parsed = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
    if (typeof parsed.version !== "string" || !parsed.version)
        throw new Error("Cannot determine repo-guard package version");
    return parsed.version;
}
function readOptional(repoRoot, path) {
    const target = resolve(repoRoot, path);
    return existsSync(target) ? readFileSync(target, "utf8") : null;
}
function migrationSnapshot(repoRoot) {
    return {
        [POLICY]: readOptional(repoRoot, POLICY),
        [TRANSACTION]: readOptional(repoRoot, TRANSACTION),
        [PORTABLE]: readOptional(repoRoot, PORTABLE),
        [NATIVE]: readOptional(repoRoot, NATIVE),
    };
}
function filesystemAdapter(repoRoot) {
    return {
        read: (path) => readOptional(repoRoot, path),
        create(path, content) {
            const target = resolve(repoRoot, path);
            if (existsSync(target))
                throw new Error(`${path} changed after migration preflight; refusing to overwrite it.`);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
        },
        replace(path, expectedBefore, content) {
            const target = resolve(repoRoot, path);
            const current = readOptional(repoRoot, path);
            if (current !== expectedBefore)
                throw new Error(`${path} changed after migration preflight; refusing to overwrite it.`);
            writeFileSync(target, content, "utf8");
        },
    };
}
function renderSummary(payload) {
    const lines = [
        `repo-guard migrate (${payload.mode})`,
        `provider: ${payload.provider}`,
        `action-ref: ${payload.actionRef}`,
        `ready-to-apply: ${payload.readyToApply ? "yes" : "no"}`,
        "files:",
        ...payload.files.map(({ action, path }) => `  ${action}: ${path}`),
    ];
    if (payload.applied !== undefined)
        lines.push(`applied: ${payload.applied ? "yes" : "no"}`);
    if (payload.writes?.length)
        lines.push("writes:", ...payload.writes.map((path) => `  ${path}`));
    if (payload.blockers.length) {
        lines.push("blockers:", ...payload.blockers.map(({ id, path, message }) => `  ${id}${path ? ` (${path})` : ""}: ${message}`));
    }
    if (payload.external.length) {
        lines.push("external:", ...payload.external.map(({ id, message }) => `  ${id}: ${message}`));
    }
    return lines.join("\n");
}
function printPayload(payload, format) {
    console.log(format === "json" ? JSON.stringify(payload, null, 2) : renderSummary(payload));
}
export function runMigrate(roots, args = []) {
    let provider = null;
    let actionRef = null;
    let format = "summary";
    let dryRun = false;
    let apply = false;
    for (let i = 0; i < args.length; i++) {
        const option = args[i];
        if (option === "--dry-run" || option === "--apply") {
            if (option === "--dry-run")
                dryRun = true;
            else
                apply = true;
            continue;
        }
        if (["--parallel", "--action-ref", "--format"].includes(option)) {
            const value = args[++i];
            if (!value) {
                console.error(`Missing value for ${option}\n${usage}`);
                return 1;
            }
            if (option === "--parallel") {
                if (!PROVIDERS.has(value)) {
                    console.error(`Unknown parallel provider: ${value}\n${usage}`);
                    return 1;
                }
                provider = value;
            }
            else if (option === "--action-ref") {
                actionRef = value;
            }
            else {
                if (!FORMATS.has(value)) {
                    console.error(`Unknown migrate format: ${value}\n${usage}`);
                    return 1;
                }
                format = value;
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
    let refCheck;
    try {
        refCheck = validateExplicitActionRef(actionRef, packageVersion(roots.packageRoot));
    }
    catch (error) {
        console.error(error.message);
        return 1;
    }
    if (!refCheck.ok) {
        console.error(refCheck.message);
        return 1;
    }
    const immutableRef = refCheck.ref;
    if (dryRun) {
        const plan = planParallelMigration({
            provider,
            actionRef: immutableRef,
            files: migrationSnapshot(roots.repoRoot),
        });
        const payload = { command: "migrate", mode: "dry-run", ...plan };
        printPayload(payload, format);
        return plan.readyToApply ? 0 : 1;
    }
    const result = applyParallelMigration({
        provider,
        actionRef: immutableRef,
        io: filesystemAdapter(roots.repoRoot),
    });
    const payload = { command: "migrate", mode: "apply", ...result };
    printPayload(payload, format);
    return result.applied && result.readyToApply ? 0 : 1;
}
