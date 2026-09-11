import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const baseline = resolve(repoRoot, "docs/architecture-compression-3-baseline.md");
const staleSnapshot = resolve(repoRoot, "docs/architecture-compression-3-c3.3b.md");

assert.equal(
  existsSync(baseline),
  true,
  "frozen Architecture Compression 3 baseline must remain in the product tree",
);

assert.equal(
  existsSync(staleSnapshot),
  false,
  "historical C3.3b architecture snapshot must not ship as current product documentation",
);

console.log("C3.9d stale architecture snapshot purge ratchet passed.");
