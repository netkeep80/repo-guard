import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileForbidRegex, compileIntegrationPolicy } from "../dist/policy-compiler.mjs";

describe("semantic policy compiler boundary", () => {
  it("keeps non-array nested values inert before semantic compilation", () => {
    assert.deepEqual(compileForbidRegex([{ id: "bad", forbid_regex: "[invalid" }]), []);
    assert.deepEqual(compileIntegrationPolicy({
      integration: {
        workflows: [{ id: "gate", profiles: "missing" }],
        docs: [{ id: "readme", must_mention_profiles: "missing" }],
      },
    }), []);
  });
});
