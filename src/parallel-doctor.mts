import type { ParallelReadinessProvider } from "./parallel-readiness.mjs";

const PARALLEL_PROVIDERS = new Set<ParallelReadinessProvider>(["portable", "github_merge_queue"]);

export function parseParallelProvider(args: string[]): ParallelReadinessProvider {
  const index = args.indexOf("--parallel");
  if (index < 0) throw new Error("--parallel requires a value");
  const value = args[index + 1];
  if (!value || !PARALLEL_PROVIDERS.has(value as ParallelReadinessProvider)) {
    throw new Error(`Unsupported parallel provider: ${value ?? ""}`);
  }
  return value as ParallelReadinessProvider;
}

export async function runParallelDoctor(_roots: unknown, args: string[]): Promise<number> {
  const provider = parseParallelProvider(args);
  throw new Error(`Parallel doctor for ${provider} requires control-plane adapter`);
}
