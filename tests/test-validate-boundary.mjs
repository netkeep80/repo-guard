import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runValidate } from "../dist/validate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("validate facade boundary", () => {
  it("preserves valid and invalid ChangeIntent exit semantics", () => {
    const originalLog = console.log, originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      assert.equal(runValidate({ packageRoot: root, repoRoot: root }, ["tests/fixtures/valid-change-intent.json"]), 0);
      assert.equal(runValidate({ packageRoot: root, repoRoot: root }, ["tests/fixtures/invalid-change-intent.json"]), 1);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
