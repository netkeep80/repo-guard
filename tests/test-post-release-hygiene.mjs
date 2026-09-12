import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { listBuiltInPacks } from "../dist/policy-profiles.mjs";
import { verifyReleaseRef } from "../scripts/verify-release-ref.mjs";

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));

describe("post-release hygiene", () => {
  it("keeps README release-state wording neutral across future publications", () => {
    const readme = read("README.md");
    assert.doesNotMatch(readme, /официальный\s+`v\d+\.\d+\.\d+`\s+ещё\s+не\s+опубликован/i);
  });

  it("accounts for every built-in pack through self-host use or an explicit exception", () => {
    const policy = json("repo-policy.json");
    const exceptions = json("docs/self-hosting-coverage.json").exceptions;
    const activePacks = new Set(Object.keys(policy.packs || {}));
    const exceptedPacks = new Set(
      Object.keys(exceptions)
        .filter((key) => key.startsWith("pack:"))
        .map((key) => key.slice("pack:".length)),
    );

    for (const pack of listBuiltInPacks()) {
      assert.ok(
        activePacks.has(pack) || exceptedPacks.has(pack),
        `built-in pack is neither self-hosted nor explicitly excepted: ${pack}`,
      );
    }
  });

  it("explains the supported Node requirement when fetch is unavailable", async () => {
    const result = await verifyReleaseRef({ fetchImpl: null });
    assert.equal(result.ok, false);
    const diagnostic = result.checks.find((check) => check.name === "github-api-client");
    assert.ok(diagnostic);
    assert.match(diagnostic.message, new RegExp(process.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(diagnostic.message, /Node\s*>=\s*20/i);
  });
});
