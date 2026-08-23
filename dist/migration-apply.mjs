import { planParallelMigration, } from "./migration-plan.mjs";
const POLICY = "repo-policy.json";
const TRANSACTION = ".github/workflows/repo-guard.yml";
const PORTABLE = ".github/workflows/repo-guard-portable-coordinator.yml";
const NATIVE = ".github/workflows/repo-guard-merge-group.yml";
const MIGRATION_PATHS = [PORTABLE, NATIVE, TRANSACTION, POLICY];
function snapshot(io) {
    return Object.fromEntries(MIGRATION_PATHS.map((path) => [path, io.read(path)]));
}
export function applyParallelMigration(input) {
    const before = snapshot(input.io);
    const plan = planParallelMigration({
        provider: input.provider,
        actionRef: input.actionRef,
        files: before,
    });
    if (!plan.readyToApply) {
        return { ...plan, applied: false, writes: [] };
    }
    const current = snapshot(input.io);
    const driftPath = MIGRATION_PATHS.find((path) => current[path] !== before[path]);
    if (driftPath) {
        const blocker = {
            id: "stale_snapshot",
            path: driftPath,
            message: `${driftPath} changed after migration planning; refusing to apply any writes.`,
        };
        return {
            ...plan,
            readyToApply: false,
            blockers: [...plan.blockers, blocker],
            applied: false,
            writes: [],
        };
    }
    const writes = [];
    for (const file of plan.files) {
        if (file.action === "unchanged")
            continue;
        if (file.action === "create") {
            input.io.create(file.path, file.after);
            writes.push(file.path);
            continue;
        }
        if (file.action === "replace") {
            input.io.replace(file.path, file.before, file.after);
            writes.push(file.path);
            continue;
        }
        throw new Error(`Invariant violation: blocked migration action reached apply for ${file.path}`);
    }
    return { ...plan, applied: true, writes };
}
