import { it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDocumentFact,
  projectDocumentValue,
} from "../dist/document-facts.mjs";

it("projects object keys for invariant identity coverage", () => {
  const document = {
    invariants: {
      beta: { contractPointer: "/laws/beta" },
      alpha: { contractPointer: "/laws/alpha" },
    },
  };

  const keys = projectDocumentValue(document, "/invariants", "object_keys");

  assert.deepEqual(keys, ["beta", "alpha"]);
  assert.deepEqual(normalizeDocumentFact(keys, "string_set"), ["alpha", "beta"]);
});

it("fails closed when object_keys targets a non-object", () => {
  assert.throws(
    () => projectDocumentValue({ invariants: ["alpha"] }, "/invariants", "object_keys"),
    /requires an object/,
  );
});
