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
  appToken: "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
};

const packageJson = JSON.parse(read("package.json"));
assert.equal(packageJson.engines?.node, ">=20.0.0");

const ci = yaml(".github/workflows/ci.yml");
const validate = ci.jobs?.validate;
const smoke = ci.jobs?.["smoke-pack"];
assert.ok(validate && smoke);
const validateNode = validate.steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"));
const smokeNode = smoke.steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"));
assert.equal(String(validateNode?.with?.["node-version"]), "24", "primary runtime remains Node 24");
assert.equal(String(smokeNode?.with?.["node-version"]), "20", "package minimum must be executable-smoked on Node 20");

const action = yaml("action.yml");
const actionNode = action.runs?.steps?.find((step) => step.name === "Set up Node.js");
assert.equal(actionNode?.uses, PIN.setupNode, "public composite Action must not hide mutable transitive setup-node authority");

const trusted = yaml(".github/workflows/trusted-enforcement.yml");
const trustedUses = (trusted.jobs?.["trusted-enforcement"]?.steps ?? []).map((step) => step.uses).filter(Boolean);
assert.ok(trustedUses.includes(PIN.checkout), "independent trusted producer checkout must be immutable-pinned");
assert.ok(trustedUses.includes(PIN.appToken), "dedicated App token action remains immutable-pinned");
assert.ok(trustedUses.includes("./"), "trusted producer must execute accepted local repo-guard");
assert.equal(trustedUses.some((uses) => /^actions\/checkout@v/.test(uses)), false);

const release = yaml(".github/workflows/release.yml");
const releaseUses = Object.values(release.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((step) => step.uses).filter(Boolean));
assert.deepEqual(releaseUses.sort(), [PIN.checkout, PIN.setupNode, PIN.uploadArtifact].sort());

const integrity = yaml(".github/workflows/release-integrity.yml");
const integrityUses = Object.values(integrity.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((step) => step.uses).filter(Boolean));
for (const expected of [PIN.downloadArtifact, PIN.checkout, PIN.setupNode, PIN.uploadArtifact]) {
  assert.ok(integrityUses.includes(expected), `release-integrity missing exact pin: ${expected}`);
}
for (const uses of integrityUses) {
  assert.match(uses, /@[0-9a-f]{40}$/, `release-integrity authority path contains mutable Action ref: ${uses}`);
}

const ordinaryCiUses = JSON.stringify(ci);
const pagesUses = read(".github/workflows/pages.yml");
assert.match(ordinaryCiUses, /actions\/checkout@v6/);
assert.match(pagesUses, /actions\/deploy-pages@v4/);

console.log("RG-05 runtime minimum and bounded transitive Action authority contract passed.");
