import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compileDocumentRelationsPolicy } from "../dist/policy-compiler.mjs";

const policy = {
  document_relations: {
    documents: {
      "base-revision": { path: "product/VERSION", format: "plain_text", snapshot: "base" },
      "head-revision": { path: "product/VERSION", format: "plain_text", snapshot: "head" },
    },
    rules: [
      {
        id: "release-revision",
        kind: "scalar_strictly_greater",
        comparator: "semver",
        left: { document: "head-revision", pointer: "", type: "string" },
        right: { document: "base-revision", pointer: "", type: "string" },
      },
    ],
  },
};

describe("ordered plain-text relation semantic compilation", () => {
  it("accepts extensionless plain_text documents consumed by scalar_strictly_greater", () => {
    assert.deepEqual(compileDocumentRelationsPolicy(policy), []);
  });
});
