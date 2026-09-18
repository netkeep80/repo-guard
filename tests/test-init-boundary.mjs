import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expectedTagForVersion, validateExplicitActionRef } from "../dist/init.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";

describe("init release-ref boundary", () => {
  it("keeps package tag derivation and immutable SHA acceptance fail-closed", () => {
    assert.equal(expectedTagForVersion("1.2.3"), "v1.2.3");
    assert.deepEqual(validateExplicitActionRef(`  ${sha}  `, "1.2.3"), {
      ok: true,
      ref: sha,
      kind: "sha",
      expectedTag: "v1.2.3",
    });
    assert.equal(validateExplicitActionRef("main", "1.2.3").ok, false);
    assert.equal(validateExplicitActionRef("v9.9.9", "1.2.3").ok, false);
  });

  it("rejects an untrusted non-string package version", () => {
    assert.throws(() => expectedTagForVersion({ version: "1.2.3" }), /Cannot determine repo-guard package version/);
  });
});
