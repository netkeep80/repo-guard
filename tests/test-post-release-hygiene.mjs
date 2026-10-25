import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { verifyReleaseRef } from "../scripts/verify-release-ref.mjs";

describe("post-release hygiene", () => {
  it("keeps README release-state wording neutral across future publications", () => {
    const readme = readFileSync("README.md", "utf8");
    assert.doesNotMatch(readme, /официальный\s+`v\d+\.\d+\.\d+`\s+ещё\s+не\s+опубликован/i);
  });

  it("explains the supported Node requirement when fetch is unavailable", async () => {
    const result = await verifyReleaseRef({ fetchImpl: null });
    assert.equal(result.ok, false);
    const diagnostic = result.checks.find((check) => check.name === "github-api-client");
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /Node\s*>=\s*20/i);
  });
});
