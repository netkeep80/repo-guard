import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const canonicalBaseline = "92432809fcddc290080beb51ba151e13a5761869";
const staleBaseline = "94f702271f6fe27672102f5271046151b023f94c";

const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
const baselineDocument = readFileSync(fileURLToPath(new URL("../docs/architecture-compression-3-baseline.md", import.meta.url)), "utf8");

const workflowFailures = [];
const expectedCommand = `npm run compression:metrics -- --compare ${canonicalBaseline}`;
if (!workflow.includes(expectedCommand)) workflowFailures.push(`CI is missing canonical C3.0 compare command: ${expectedCommand}`);
if (workflow.includes(staleBaseline)) workflowFailures.push(`CI still uses stale pre-C3 compare anchor: ${staleBaseline}`);

assert.ok(
  baselineDocument.includes(canonicalBaseline),
  `architecture-compression-3-baseline.md must retain canonical C3.0 baseline ${canonicalBaseline}`,
);
assert.deepEqual(workflowFailures, [], "CI compression comparison must use only the canonical C3.0 baseline");

console.log("C3 compression baseline integrity: PASS");
