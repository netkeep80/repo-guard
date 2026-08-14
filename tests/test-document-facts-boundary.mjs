import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDocumentReader,
  normalizeDocumentFact,
  projectDocumentValue,
  readDocumentFact,
  resolveJsonPointer,
} from "../dist/document-facts.mjs";
import { checkRegistryRules } from "../dist/checks/rules/registry-rules.mjs";

const document = {
  "": "empty-key",
  owner: { name: "repo-guard" },
  "a/b": "slash",
  "m~n": "tilde",
  items: ["zero", "one"],
  repeated: ["b", "a", "b"],
  owners: { second: "./src/b.mts", first: "src/a.mts" },
  value: 42,
  enabled: true,
  nullable: null,
};

function captureFailure(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("expected DocumentFact failure");
}

describe("shared JSON Pointer boundary", () => {
  it("selects root, nested, empty-key, escaped and array values", () => {
    assert.equal(resolveJsonPointer(document, ""), document);
    assert.equal(resolveJsonPointer(document, "/owner/name"), "repo-guard");
    assert.equal(resolveJsonPointer(document, "/"), "empty-key");
    assert.equal(resolveJsonPointer(document, "/a~1b"), "slash");
    assert.equal(resolveJsonPointer(document, "/m~0n"), "tilde");
    assert.equal(resolveJsonPointer(document, "/items/1"), "one");
  });

  it("fails closed for missing segments and primitive/null traversal", () => {
    assert.throws(() => resolveJsonPointer(document, "/missing"), /json_pointer .* does not exist/);
    assert.throws(() => resolveJsonPointer(document, "/value/x"), /json_pointer .* does not exist/);
    assert.throws(() => resolveJsonPointer(document, "/nullable/x"), /json_pointer .* does not exist/);
  });

  it("rejects malformed pointer syntax and escapes", () => {
    assert.throws(() => resolveJsonPointer(document, "owner/name"), /invalid json_pointer/);
    assert.throws(() => resolveJsonPointer(document, "/a~2b"), /invalid json_pointer/);
    assert.throws(() => resolveJsonPointer(document, "/m~"), /invalid json_pointer/);
    assert.throws(() => resolveJsonPointer(document, null), /invalid json_pointer/);
  });

  it("preserves registry behavior through the shared escaped-key resolver", () => {
    const registryDocument = { "a/b": ["docs/canonical.md"], canonical: ["docs/canonical.md"] };
    const documents = {
      text: () => "",
      markdown: () => { throw new Error("not used"); },
      json: () => registryDocument,
      yaml: () => { throw new Error("not used"); },
    };
    const result = checkRegistryRules([{
      id: "escaped-json-pointer",
      kind: "equal",
      left: { type: "json_array", file: "registry.json", json_pointer: "/a~1b" },
      right: { type: "json_array", file: "registry.json", json_pointer: "/canonical" },
    }], { documents });

    assert.equal(result.ok, true);
    assert.equal(result.results[0]?.ok, true);
    assert.deepEqual(result.results[0]?.left_entries, ["docs/canonical.md"]);
    assert.deepEqual(result.results[0]?.right_entries, ["docs/canonical.md"]);
  });
});

describe("DocumentFacts projections", () => {
  it("supports exact value, array items and object values", () => {
    assert.equal(projectDocumentValue(document, "/owner/name"), "repo-guard");
    assert.deepEqual(projectDocumentValue(document, "/repeated", "array_items"), ["b", "a", "b"]);
    assert.deepEqual(projectDocumentValue(document, "/owners", "object_values"), ["./src/b.mts", "src/a.mts"]);
  });

  it("keeps list duplicates observable until explicit set normalization", () => {
    const projected = projectDocumentValue(document, "/repeated", "array_items");
    assert.deepEqual(projected, ["b", "a", "b"]);
    assert.deepEqual(normalizeDocumentFact(projected, "string_set"), ["a", "b"]);
  });

  it("fails closed when collection projection does not match the selected value", () => {
    assert.throws(() => projectDocumentValue(document, "/owner", "array_items"), /requires an array/);
    assert.throws(() => projectDocumentValue(document, "/items", "object_values"), /requires an object/);
    assert.throws(() => projectDocumentValue(document, "/nullable", "object_values"), /requires an object/);
  });
});

describe("typed document fact normalization", () => {
  it("narrows JSON scalars, strings and booleans without coercion", () => {
    assert.equal(normalizeDocumentFact(42, "scalar"), 42);
    assert.equal(normalizeDocumentFact(null, "scalar"), null);
    assert.equal(normalizeDocumentFact("repo-guard", "string"), "repo-guard");
    assert.equal(normalizeDocumentFact(true, "boolean"), true);
    assert.throws(() => normalizeDocumentFact({}, "scalar"), /requires a JSON scalar/);
    assert.throws(() => normalizeDocumentFact(Infinity, "scalar"), /requires a JSON scalar/);
    assert.throws(() => normalizeDocumentFact(1, "string"), /requires a string/);
    assert.throws(() => normalizeDocumentFact("true", "boolean"), /requires a boolean/);
  });

  it("normalizes sets deterministically and keeps empty sets valid", () => {
    assert.deepEqual(normalizeDocumentFact(["b", "a", "b"], "string_set"), ["a", "b"]);
    assert.deepEqual(normalizeDocumentFact([], "string_set"), []);
    assert.deepEqual(normalizeDocumentFact(projectDocumentValue({ a: "z", b: "a", c: "z" }, "", "object_values"), "string_set"), ["a", "z"]);
    assert.deepEqual(normalizeDocumentFact(projectDocumentValue({ c: "z", b: "a", a: "z" }, "", "object_values"), "string_set"), ["a", "z"]);
    assert.throws(() => normalizeDocumentFact(["a", 2], "string_set"), /requires string items/);
  });

  it("normalizes repository paths through canonical spelling and deduplicates path sets", () => {
    assert.equal(normalizeDocumentFact(" ./docs/contract.json ", "repository_path"), "docs/contract.json");
    assert.deepEqual(
      normalizeDocumentFact(projectDocumentValue(document, "/owners", "object_values"), "repository_path_set"),
      ["src/a.mts", "src/b.mts"],
    );
    assert.deepEqual(normalizeDocumentFact([], "repository_path_set"), []);
  });

  it("rejects malformed and out-of-repository path values", () => {
    for (const path of ["", "   ", "/etc/passwd", "../outside", "docs/../outside", "docs/./file", "docs\\file", "https://example.test/x", "C:/outside"]) {
      assert.throws(() => normalizeDocumentFact(path, "repository_path"), /invalid repository_path/);
    }
    assert.throws(() => normalizeDocumentFact(42, "repository_path"), /requires a string/);
    assert.throws(() => normalizeDocumentFact(["docs/a", "../outside"], "repository_path_set"), /invalid repository_path/);
  });
});

describe("DocumentFact selector/read boundary", () => {
  const files = {
    "facts.json": JSON.stringify({
      contract: "contracts/mts-contract-v0.7.json",
      corpus: "./contracts/mts-conformance-v0.7.json",
      owners: { runtime: "./core/runtime.ts", schema: "schemas/mts.json" },
    }),
    "facts.yaml": "enabled: true\ngates:\n  - ./tools/check.mjs\n  - tools/check.mjs\n  - tests/smoke.mjs\n",
    "bad.json": "{not-json",
    "bad.yaml": "[unterminated",
  };
  const reader = createDocumentReader({ readFile: (path) => files[path] });

  it("reads JSON scalar/path facts and defaults projection to value", () => {
    assert.deepEqual(readDocumentFact(reader, { path: "facts.json", pointer: "/contract", type: "string" }), {
      ok: true,
      value: "contracts/mts-contract-v0.7.json",
    });
    assert.deepEqual(readDocumentFact(reader, { path: "facts.json", pointer: "/corpus", type: "repository_path" }), {
      ok: true,
      value: "contracts/mts-conformance-v0.7.json",
    });
  });

  it("composes object/array projections with deterministic path sets", () => {
    assert.deepEqual(readDocumentFact(reader, { path: "facts.json", pointer: "/owners", projection: "object_values", type: "repository_path_set" }), {
      ok: true,
      value: ["core/runtime.ts", "schemas/mts.json"],
    });
    assert.deepEqual(readDocumentFact(reader, { path: "facts.yaml", pointer: "/gates", projection: "array_items", type: "repository_path_set" }), {
      ok: true,
      value: ["tests/smoke.mjs", "tools/check.mjs"],
    });
    assert.deepEqual(readDocumentFact(reader, { path: "facts.yaml", pointer: "/enabled", type: "boolean" }), { ok: true, value: true });
  });

  it("exposes required structured failure codes without parsing messages", () => {
    const malformed = captureFailure(() => resolveJsonPointer(document, "/a~2b"));
    assert.equal(malformed.code, "malformed_pointer");
    assert.equal(malformed.pointer, "/a~2b");

    const missing = captureFailure(() => resolveJsonPointer(document, "/owner/missing"));
    assert.equal(missing.code, "missing_pointer_segment");
    assert.equal(missing.segment, "missing");

    const projection = captureFailure(() => projectDocumentValue(document, "/owner", "array_items"));
    assert.equal(projection.code, "projection_type_mismatch");

    const type = captureFailure(() => normalizeDocumentFact(1, "string", "/contract"));
    assert.equal(type.code, "fact_type_mismatch");
    assert.equal(type.pointer, "/contract");

    const path = captureFailure(() => normalizeDocumentFact("../outside", "repository_path", "/corpus"));
    assert.equal(path.code, "invalid_repository_path");
    assert.equal(path.pointer, "/corpus");
  });

  it("returns the same structured codes through the read boundary", () => {
    const missing = readDocumentFact(reader, { path: "facts.json", pointer: "/missing", type: "string" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "missing_pointer_segment");
    assert.equal(missing.error.segment, "missing");

    const projection = readDocumentFact(reader, { path: "facts.json", pointer: "/owners", projection: "array_items", type: "string_set" });
    assert.equal(projection.ok, false);
    assert.equal(projection.error.code, "projection_type_mismatch");

    const type = readDocumentFact(reader, { path: "facts.json", pointer: "/contract", type: "boolean" });
    assert.equal(type.ok, false);
    assert.equal(type.error.code, "fact_type_mismatch");

    const path = readDocumentFact(reader, { path: "../facts.json", pointer: "/contract", type: "string" });
    assert.equal(path.ok, false);
    assert.equal(path.error.code, "invalid_repository_path");
  });

  it("fails closed for parser/read and unsupported document errors", () => {
    const badJson = readDocumentFact(reader, { path: "bad.json", pointer: "", type: "string" });
    assert.equal(badJson.ok, false);
    assert.equal(badJson.error.code, "document_read_error");

    const badYaml = readDocumentFact(reader, { path: "bad.yaml", pointer: "", type: "string" });
    assert.equal(badYaml.ok, false);
    assert.equal(badYaml.error.code, "document_read_error");

    const unsupported = readDocumentFact(reader, { path: "facts.toml", pointer: "", type: "string" });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error.code, "unsupported_document_type");
  });
});
