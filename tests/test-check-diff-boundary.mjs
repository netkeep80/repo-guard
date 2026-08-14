import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckDiff } from "../dist/check-diff.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("check-diff facade boundary", () => {
  it("rejects an unknown output format without terminating imported callers", () => {
    const originalError = console.error, errors = [];
    console.error = (...args) => errors.push(args.join(" "));
    try {
      assert.equal(runCheckDiff({ packageRoot: root, repoRoot: root }, ["--format", "xml"]), 1);
      assert.match(errors.join("\n"), /Unknown check-diff format: xml/);
    } finally {
      console.error = originalError;
    }
  });
});
