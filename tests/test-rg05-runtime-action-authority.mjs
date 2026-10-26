import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const yaml = (path) => {
  const doc = parseDocument(read(path));
  assert.deepEqual(doc.errors, [], `${path}: invalid YAML`);
  return doc.toJS();
};

const PIN = {
  checkout: "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  setupNode: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  downloadArtifact: "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0",
  uploadArtifact: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
};

const packageJson = JSON.parse(read("package.json"));
assert.equal(packageJson.engines?.node, ">=20.0.0");

const action = yaml("action.yml");
assert.deepEqual(Object.keys(action.inputs ?? {}).sort(), ["base", "head", "node-version", "repo-root"]);
const actionNode = action.runs?.steps?.find((step) => step.name === "Set up Node.js");
assert.equal(actionNode?.uses, PIN.setupNode);
const actionRun = action.runs?.steps?.find((step) => step.name === "Run repo-guard")?.run ?? "";
assert.match(actionRun, /dist\/repo-guard\.mjs/);
assert.match(actionRun, /check --base/);
assert.match(actionRun, /repo-guard\/local-compiler-v1/);
for (const token of ["check-diff", "change-intent", "--enforcement", "repo-policy.json"]) {
  assert.equal(actionRun.includes(token), false, `Action still contains ${token}`);
}

const release = yaml(".github/workflows/release.yml");
const releaseUses = Object.values(release.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((step) => step.uses).filter(Boolean));
assert.deepEqual(releaseUses.sort(), [PIN.checkout, PIN.setupNode, PIN.uploadArtifact].sort());

const integrity = yaml(".github/workflows/release-integrity.yml");
const integrityUses = Object.values(integrity.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((step) => step.uses).filter(Boolean));
for (const expected of [PIN.downloadArtifact, PIN.checkout, PIN.setupNode, PIN.uploadArtifact]) {
  assert.ok(integrityUses.includes(expected), `release-integrity missing exact pin: ${expected}`);
}
for (const uses of integrityUses) assert.match(uses, /@[0-9a-f]{40}$/);

console.log("RG-05 thin Action/runtime authority boundary passed");
