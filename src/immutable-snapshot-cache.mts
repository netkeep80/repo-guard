import { normalizePathEntry } from "./utils/path-patterns.mjs";

export type ImmutableSnapshotFormat = "json" | "yaml";

export interface ImmutableSnapshotIdentity {
  repository: string;
  sha: string;
}

export interface ImmutableSnapshotCacheMetrics {
  rawReads: number;
  rawHits: number;
  parses: number;
  parseHits: number;
}

export interface ImmutableSnapshotDocumentCache {
  read(identity: ImmutableSnapshotIdentity, path: string): unknown;
  parsed(identity: ImmutableSnapshotIdentity, path: string, format: ImmutableSnapshotFormat): unknown;
  metrics(): ImmutableSnapshotCacheMetrics;
}

interface CachedValue {
  ok: true;
  value: unknown;
}

interface CachedFailure {
  ok: false;
  error: unknown;
}

type CachedResult = CachedValue | CachedFailure;

type SnapshotParser = (content: string) => unknown;

export interface ImmutableSnapshotDocumentCacheOptions {
  readFileAtRef: (sha: string, path: string) => unknown;
  parsers: Record<ImmutableSnapshotFormat, SnapshotParser>;
}

const EXACT_COMMIT_SHA = /^[0-9a-f]{40}$/i;

function normalizeIdentity(identity: ImmutableSnapshotIdentity): ImmutableSnapshotIdentity {
  const repository = String(identity.repository || "").trim().toLowerCase();
  const sha = String(identity.sha || "").trim().toLowerCase();
  if (!repository) throw new Error("immutable snapshot cache requires repository identity");
  if (!EXACT_COMMIT_SHA.test(sha)) throw new Error(`immutable snapshot cache requires exact commit SHA, got "${identity.sha}"`);
  return { repository, sha };
}

function normalizeSnapshotPath(path: string): string {
  const normalized = normalizePathEntry(path);
  const parts = normalized.split("/");
  if (
    !normalized
    || normalized.includes("\\")
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
    || parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`immutable snapshot cache requires normalized repository path, got "${path}"`);
  }
  return normalized;
}

function valueOrThrow(result: CachedResult): unknown {
  if (!result.ok) throw result.error;
  return result.value;
}

export function createImmutableSnapshotDocumentCache(options: ImmutableSnapshotDocumentCacheOptions): ImmutableSnapshotDocumentCache {
  const raw = new Map<string, CachedResult>();
  const parsed = new Map<string, CachedResult>();
  const metrics: ImmutableSnapshotCacheMetrics = { rawReads: 0, rawHits: 0, parses: 0, parseHits: 0 };

  const coordinates = (identity: ImmutableSnapshotIdentity, path: string) => {
    const normalizedIdentity = normalizeIdentity(identity);
    const normalizedPath = normalizeSnapshotPath(path);
    const key = `${normalizedIdentity.repository}\0${normalizedIdentity.sha}\0${normalizedPath}`;
    return { identity: normalizedIdentity, path: normalizedPath, key };
  };

  const read = (identity: ImmutableSnapshotIdentity, path: string): unknown => {
    const coordinate = coordinates(identity, path);
    const cached = raw.get(coordinate.key);
    if (cached) {
      metrics.rawHits++;
      return valueOrThrow(cached);
    }
    metrics.rawReads++;
    try {
      const value = options.readFileAtRef(coordinate.identity.sha, coordinate.path);
      raw.set(coordinate.key, { ok: true, value });
      return value;
    } catch (error: unknown) {
      raw.set(coordinate.key, { ok: false, error });
      throw error;
    }
  };

  return {
    read,
    parsed(identity, path, format) {
      const coordinate = coordinates(identity, path);
      const key = `${coordinate.key}\0${format}`;
      const cached = parsed.get(key);
      if (cached) {
        metrics.parseHits++;
        return valueOrThrow(cached);
      }
      metrics.parses++;
      try {
        const value = options.parsers[format](String(read(coordinate.identity, coordinate.path)));
        parsed.set(key, { ok: true, value });
        return value;
      } catch (error: unknown) {
        parsed.set(key, { ok: false, error });
        throw error;
      }
    },
    metrics: () => ({ ...metrics }),
  };
}
