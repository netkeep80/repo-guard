import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const historicalProcessCorpus = resolve(projectRoot, "docs/superpowers");

assert.equal(
  existsSync(historicalProcessCorpus),
  false,
  "docs/superpowers must not remain in the current product documentation tree",
);

console.log("C3.9b ratchet: historical superpowers planning/spec corpus is absent.");
