import assert from "node:assert/strict";
import { evaluateRepositoryShadowReplay } from "../dist/runtime/pipeline.mjs";

assert.equal(typeof evaluateRepositoryShadowReplay, "function",
  "I9 requires a generic production replay seam for exact external repositories");

console.log("I9_RED_EXPECTATION: generic production external-repository replay seam exists");
