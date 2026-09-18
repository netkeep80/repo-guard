import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDocumentReader, parseJson, parseYaml, readFact } from "../dist/document-facts.mjs";

const REPOSITORY = "netkeep80/repo-guard";
const BASE_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";

async function loadCacheRuntime() {
  try {
    return await import("../dist/immutable-snapshot-cache.mjs");
  } catch (error) {
    return { loadError: error };
  }
}

async function createCache(readFileAtRef) {
  const runtime = await loadCacheRuntime();
  assert.equal(
    typeof runtime.createImmutableSnapshotDocumentCache,
    "function",
    "#531 requires createImmutableSnapshotDocumentCache",
  );
  return runtime.createImmutableSnapshotDocumentCache({
    readFileAtRef,
    parsers: { json: parseJson, yaml: parseYaml },
  });
}

const identity = (sha = BASE_SHA, repository = REPOSITORY) => ({ repository, sha });
const documentRef = ({ snapshot = "base", path = "facts.json", pointer = "", format = "json", type = "string" } = {}) => ({
  source: "document",
  selector: { path, format, snapshot, pointer },
  type,
});

describe("P2.1: invocation-local immutable snapshot document cache", () => {
  it("предоставляет отдельный runtime cache вместо ещё одного неявного ref/path memoizer", async () => {
    const runtime = await loadCacheRuntime();
    assert.equal(typeof runtime.createImmutableSnapshotDocumentCache, "function");
  });

  it("сводит шесть чтений version-fixture к трём уникальным immutable identities", async () => {
    let reads = 0;
    const cache = await createCache((sha, path) => {
      reads++;
      return `${sha}:${path}`;
    });
    const accesses = [
      [BASE_SHA, "VERSION"],
      [BASE_SHA, "VERSION"],
      [HEAD_SHA, "VERSION"],
      [HEAD_SHA, "VERSION"],
      [HEAD_SHA, "package.json"],
      [HEAD_SHA, "package.json"],
    ];
    for (const [sha, path] of accesses) cache.read(identity(sha), path);
    assert.equal(reads, 3);
    assert.deepEqual(cache.metrics(), { rawReads: 3, rawHits: 3, parses: 0, parseHits: 0 });
  });

  it("ключует raw bytes по repository + exact SHA + нормализованному пути", async () => {
    let reads = 0;
    const cache = await createCache((sha, path) => {
      reads++;
      return `${sha}:${path}:${reads}`;
    });

    const first = cache.read(identity(BASE_SHA), " ./facts.json ");
    const normalized = cache.read(identity(BASE_SHA), "facts.json");
    assert.equal(normalized, first);
    cache.read(identity(HEAD_SHA), "facts.json");
    cache.read(identity(BASE_SHA, "other/repository"), "facts.json");

    assert.equal(reads, 3);
    assert.throws(() => cache.read({ repository: REPOSITORY, sha: "HEAD" }, "facts.json"), /exact commit SHA/i);
  });

  it("парсит один JSON один раз для разных pointer и переиспользует cache между двумя context", async () => {
    let reads = 0;
    const cache = await createCache(() => {
      reads++;
      return JSON.stringify({ left: "A", right: "B" });
    });
    const common = {
      repositoryIdentity: REPOSITORY,
      baseRef: BASE_SHA,
      headRef: HEAD_SHA,
      snapshotDocuments: cache,
      readFileAtRef: () => assert.fail("immutable snapshot cache must own BASE/HEAD read reuse"),
    };

    assert.deepEqual(readFact(common, documentRef({ pointer: "/left" })), { ok: true, value: "A" });
    assert.deepEqual(readFact({ ...common }, documentRef({ pointer: "/right" })), { ok: true, value: "B" });
    assert.equal(reads, 1);
    assert.deepEqual(cache.metrics(), { rawReads: 1, rawHits: 2, parses: 1, parseHits: 1 });
  });

  it("разделяет parsed entries по формату даже для одинаковых bytes", async () => {
    const cache = await createCache(() => "value: 1\n");
    assert.deepEqual(cache.parsed(identity(), "facts.data", "yaml"), { value: 1 });
    assert.throws(() => cache.parsed(identity(), "facts.data", "json"));
    assert.deepEqual(cache.metrics(), { rawReads: 1, rawHits: 1, parses: 2, parseHits: 0 });
  });

  it("memoize-ит missing/read/parse failures invocation-local и сохраняет прежнюю fail-closed диагностику", async () => {
    for (const scenario of ["missing", "read", "parse"]) {
      let reads = 0;
      const source = () => {
        reads++;
        if (scenario === "missing") return null;
        if (scenario === "read") throw new Error("snapshot boom");
        return "{not-json";
      };
      const legacy = {
        baseRef: BASE_SHA,
        readFileAtRef: source,
      };
      const expected = readFact(legacy, documentRef());
      reads = 0;
      const cache = await createCache(source);
      const cached = {
        repositoryIdentity: REPOSITORY,
        baseRef: BASE_SHA,
        snapshotDocuments: cache,
        readFileAtRef: () => assert.fail("fallback reader must not run"),
      };
      const first = readFact(cached, documentRef());
      const second = readFact(cached, documentRef());
      assert.deepEqual(first, expected, `${scenario}: first diagnostic differs`);
      assert.deepEqual(second, expected, `${scenario}: memoized diagnostic differs`);
      assert.equal(reads, 1, `${scenario}: immutable failure was read more than once`);
      if (scenario === "parse") assert.equal(cache.metrics().parses, 1);
    }
  });

  it("не смешивает mutable STATE с immutable SHA cache", async () => {
    let immutableReads = 0;
    const cache = await createCache(() => {
      immutableReads++;
      return JSON.stringify({ value: "immutable" });
    });
    const documents = createDocumentReader({ readFile: () => JSON.stringify({ value: "state" }) });
    const result = readFact({
      documents,
      repositoryIdentity: REPOSITORY,
      baseRef: BASE_SHA,
      snapshotDocuments: cache,
    }, documentRef({ snapshot: "state", pointer: "/value" }));
    assert.deepEqual(result, { ok: true, value: "state" });
    assert.equal(immutableReads, 0);
    assert.equal(cache.metrics().rawReads, 0);
  });

  it("не переносит cache между invocations", async () => {
    let current = "v1";
    const reader = () => JSON.stringify({ value: current });
    const firstInvocation = await createCache(reader);
    assert.equal(firstInvocation.parsed(identity(), "facts.json", "json").value, "v1");
    current = "v2";
    assert.equal(firstInvocation.parsed(identity(), "facts.json", "json").value, "v1");

    const secondInvocation = await createCache(reader);
    assert.equal(secondInvocation.parsed(identity(), "facts.json", "json").value, "v2");
  });
});
