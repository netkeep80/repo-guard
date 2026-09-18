import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
);

assert.equal(typeof packageJson.version, "string");
assert.ok(packageJson.version.length > 0);
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages?.[""]?.version, packageJson.version);

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
assert.deepEqual(releaseWorkflow.permissions, {});
assert.deepEqual(releaseWorkflow.on?.workflow_run?.workflows, ["Atomic release"]);
assert.deepEqual(releaseWorkflow.on?.workflow_run?.types, ["completed"]);
assert.ok(releaseWorkflow.on?.workflow_dispatch?.inputs?.tag);
assert.equal(releaseWorkflow.on?.release, undefined);

const automaticJob = releaseWorkflow.jobs?.["verify-automatic"];
assert.ok(automaticJob);
assert.deepEqual(automaticJob.permissions, { contents: "read" });
const automaticCheckout = automaticJob.steps.find((step) => step.uses === "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803");
assert.equal(
  automaticCheckout?.with?.ref,
  "${{ needs.resolve-automatic-target.outputs.target_sha }}",
);
assert.equal(automaticCheckout?.with?.["persist-credentials"], false);
const automaticVerifier = automaticJob.steps.find((step) => (
  typeof step.run === "string"
  && step.run.includes("scripts/verify-release-ref.mjs")
));
assert.ok(automaticVerifier);
assert.match(automaticVerifier.run, /--tag/);
assert.match(automaticVerifier.run, /--expected-sha/);

const manualJob = releaseWorkflow.jobs?.["verify-manual"];
assert.ok(manualJob);
assert.deepEqual(manualJob.permissions, { contents: "read" });
const manualCheckout = manualJob.steps.find((step) => step.uses === "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803");
assert.equal(manualCheckout?.with?.ref, "${{ inputs.tag }}");
const manualVerifier = manualJob.steps.find((step) => (
  typeof step.run === "string"
  && step.run.includes("scripts/verify-release-ref.mjs")
));
assert.ok(manualVerifier);
assert.match(manualVerifier.run, /--tag/);
assert.doesNotMatch(manualVerifier.run, /--expected-sha/);

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
assert.match(
  releasing,
  /`GITHUB_TOKEN`[^\n]*не используется как транспорт события между рабочими процессами/,
);
assert.match(
  releasing,
  /`Release integrity`[^\n]*`workflow_run`[^\n]*`Atomic release`/,
);
assert.match(
  releasing,
  /`target_sha`[\s\S]*`tag`[\s\S]*`run_id`[\s\S]*`run_attempt`/,
);
assert.match(
  releasing,
  /Ручной запуск[\s\S]*не является доказательством того, что исторический accepted `S` был установлен заранее/,
);

console.log("C3.7 version, release workflow, and documentation truth contract passed");
