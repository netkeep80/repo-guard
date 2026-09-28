import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFact } from "../dist/document-facts.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const sourceV1 = "claim: alpha\n";
const sourceV2 = "claim: beta\n";
const targetV1 = "# Derived\nalpha\n";
const unrelatedV1 = "unchanged\n";
const unrelatedV2 = "changed but outside projection dependencies\n";

const acceptedBuildRecord = {
  projection_id: "projection.demo",
  source_digest: sha256(sourceV1),
  output_digest: sha256(targetV1),
};

const contentIdentity = (path) => ({
  source: "content_identity",
  selector: {
    path,
    snapshot: "state",
    algorithm: "sha256",
  },
  type: "string",
});

function context(files) {
  return {
    readFile: (path) => {
      if (!files.has(path)) throw new Error(`missing fixture file: ${path}`);
      return files.get(path);
    },
  };
}

function classify(files, record = acceptedBuildRecord) {
  const source = readFact(context(files), contentIdentity("model/source.txt"));
  assert.equal(
    source.ok,
    true,
    "P4 RED: repo-guard lacks a generic content_identity FactRef for projection freshness",
  );

  const target = readFact(context(files), contentIdentity("derived/output.md"));
  assert.equal(target.ok, true, "target identity must use the same generic fact extractor");

  if (!source.ok || !target.ok) return "BROKEN";
  if (target.value !== record.output_digest) return "BROKEN";
  return source.value === record.source_digest ? "CURRENT" : "STALE";
}

const currentFiles = new Map([
  ["model/source.txt", sourceV1],
  ["derived/output.md", targetV1],
  ["notes/unrelated.txt", unrelatedV1],
]);
assert.equal(classify(currentFiles), "CURRENT");

const staleFiles = new Map(currentFiles);
staleFiles.set("model/source.txt", sourceV2);
assert.equal(
  classify(staleFiles),
  "STALE",
  "changed source identity with unchanged target/build record must become STALE",
);

const unrelatedFiles = new Map(currentFiles);
unrelatedFiles.set("notes/unrelated.txt", unrelatedV2);
assert.equal(
  classify(unrelatedFiles),
  "CURRENT",
  "a change outside declared source dependencies must not stale the projection",
);

assert.equal(
  classify(currentFiles, { ...acceptedBuildRecord, source_digest: sha256("forged\n") }),
  "STALE",
  "a forged build record with the wrong source digest must fail freshness",
);

const changedTargetFiles = new Map(currentFiles);
changedTargetFiles.set("derived/output.md", "# manually edited derived output\n");
assert.equal(
  classify(changedTargetFiles),
  "BROKEN",
  "target bytes that disagree with the build record must fail closed",
);

console.log("Projection freshness identity falsifier passed.");
