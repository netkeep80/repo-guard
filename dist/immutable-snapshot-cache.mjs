import { normalizePathEntry } from "./utils/path-patterns.mjs";
const EXACT_COMMIT_SHA = /^[0-9a-f]{40}$/i;
function normalizeIdentity(identity) {
    const repository = String(identity.repository || "").trim().toLowerCase();
    const sha = String(identity.sha || "").trim().toLowerCase();
    if (!repository)
        throw new Error("immutable snapshot cache requires repository identity");
    if (!EXACT_COMMIT_SHA.test(sha))
        throw new Error(`immutable snapshot cache requires exact commit SHA, got "${identity.sha}"`);
    return { repository, sha };
}
function normalizeSnapshotPath(path) {
    const normalized = normalizePathEntry(path);
    const parts = normalized.split("/");
    if (!normalized
        || normalized.includes("\\")
        || normalized.startsWith("/")
        || /^[A-Za-z]:/.test(normalized)
        || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
        || parts.some((part) => !part || part === "." || part === "..")) {
        throw new Error(`immutable snapshot cache requires normalized repository path, got "${path}"`);
    }
    return normalized;
}
function valueOrThrow(result) {
    if (!result.ok)
        throw result.error;
    return result.value;
}
export function createImmutableSnapshotDocumentCache(options) {
    const raw = new Map();
    const parsed = new Map();
    const metrics = { rawReads: 0, rawHits: 0, parses: 0, parseHits: 0 };
    const coordinates = (identity, path) => {
        const normalizedIdentity = normalizeIdentity(identity);
        const normalizedPath = normalizeSnapshotPath(path);
        const key = `${normalizedIdentity.repository}\0${normalizedIdentity.sha}\0${normalizedPath}`;
        return { identity: normalizedIdentity, path: normalizedPath, key };
    };
    const read = (identity, path) => {
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
        }
        catch (error) {
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
            }
            catch (error) {
                parsed.set(key, { ok: false, error });
                throw error;
            }
        },
        metrics: () => ({ ...metrics }),
    };
}
