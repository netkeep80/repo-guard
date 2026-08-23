import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../dist/repo-guard.mjs";

describe("provider-neutral agent lifecycle", () => {
  it("exposes status as an additive CLI command", () => {
    assert.equal(COMMANDS.includes("status"), true);
  });
});
