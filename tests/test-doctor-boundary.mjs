import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../dist/doctor.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("doctor result boundary", () => {
  it("returns the diagnostic envelope without terminating imported callers", () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      const report = runDoctor({ packageRoot: root, repoRoot: resolve(root, "does-not-exist") });
      assert.equal(Array.isArray(report.results), true);
      assert.equal(report.results.length, 8);
      assert.equal(report.passes + report.warns + report.fails, report.results.length);
      assert.ok(report.fails > 0);
      assert.equal(report.results[0]?.name, "repository-root");
      assert.equal(report.results[0]?.status, "FAIL");
    } finally {
      console.log = originalLog;
    }
  });
});
