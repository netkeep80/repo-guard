import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { expectedTagForVersion } from "../scripts/verify-release-ref.mjs";

const root = resolve(".");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
);

assert.equal(packageJson.version, "3.0.0");
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages?.[""]?.version, packageJson.version);
assert.equal(expectedTagForVersion(packageJson.version), "v3.0.0");

for (const path of [
  "VERSION",
  "release-state.json",
  "target-version.json",
]) {
  assert.equal(existsSync(resolve(root, path)), false, path);
}

const releaseWorkflowSource = readFileSync(
  resolve(root, ".github/workflows/release-integrity.yml"),
  "utf8",
);
const releaseWorkflowDocument = parseDocument(releaseWorkflowSource);
assert.equal(releaseWorkflowDocument.errors.length, 0);
const releaseWorkflow = releaseWorkflowDocument.toJS();
assert.deepEqual(releaseWorkflow.permissions, { contents: "read" });
assert.deepEqual(releaseWorkflow.on?.release?.types, ["published"]);

const releaseJob = releaseWorkflow.jobs?.["verify-release-ref"];
assert.ok(releaseJob);
const checkout = releaseJob.steps.find((step) => step.uses === "actions/checkout@v6");
const expectedReleaseRef = "${{ github.event.release.tag_name || inputs.tag }}";
assert.equal(checkout?.with?.ref, expectedReleaseRef);
const verifier = releaseJob.steps.find((step) => (
  typeof step.run === "string"
  && step.run.includes("scripts/verify-release-ref.mjs")
));
assert.ok(verifier);
assert.equal(verifier.env?.RELEASE_TAG, expectedReleaseRef);
assert.equal(verifier.run, 'node scripts/verify-release-ref.mjs --tag "$RELEASE_TAG"');
assert.doesNotMatch(
  releaseWorkflowSource,
  /\b(?:npm\s+publish|gh\s+release\s+create|git\s+tag|git\s+push)\b/,
);

const readme = readFileSync(resolve(root, "README.md"), "utf8");
assert.match(readme, /полный 40-символьный SHA коммита/);
assert.match(readme, /`init` не подставляет `main` или `latest`/);

const releasing = readFileSync(resolve(root, "RELEASING.md"), "utf8");
assert.match(
  releasing,
  /между этим коммитом и созданием тега нельзя менять код или номер версии/,
);
assert.match(
  releasing,
  /Между принятым `S` и созданием тега нет отдельного коммита версии и нет повторного `npm version`/,
);
assert.match(
  releasing,
  /Не закрепляйте производственную проверку за изменяемой веткой `main` или псевдонимом `latest`/,
);

console.log("C3.7 version, release workflow, and documentation truth contract passed");
