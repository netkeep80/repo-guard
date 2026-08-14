import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveJsonPointer } from "../dist/document-facts.mjs";

const document = {
  "": "empty-key",
  owner: { name: "repo-guard" },
  "a/b": "slash",
  "m~n": "tilde",
  items: ["zero", "one"],
  value: 42,
  nullable: null,
};

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
});
