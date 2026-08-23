const PARALLEL_PROVIDERS = new Set(["portable", "github_merge_queue"]);
export function parseParallelProvider(args) {
    const index = args.indexOf("--parallel");
    if (index < 0)
        throw new Error("--parallel requires a value");
    const value = args[index + 1];
    if (!value || !PARALLEL_PROVIDERS.has(value)) {
        throw new Error(`Unsupported parallel provider: ${value ?? ""}`);
    }
    return value;
}
export async function runParallelDoctor(_roots, args) {
    const provider = parseParallelProvider(args);
    throw new Error(`Parallel doctor for ${provider} requires control-plane adapter`);
}
