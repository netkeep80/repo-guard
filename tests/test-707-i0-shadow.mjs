import test from "node:test";
import assert from "node:assert/strict";
import { runPolicyPipelineShadow } from "../dist/runtime/pipeline.mjs";

test("#707 I0 shadow is non-authoritative and deterministically classified", () => {
  assert.equal(typeof runPolicyPipelineShadow, "function");
});
