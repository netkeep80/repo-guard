import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testIsolationManifest } from "./test-isolation-manifest.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const discovered = [
  "validate-schemas.mjs",
  ...readdirSync(testsDir)
    .filter((name) => /^test-.*\.mjs$/.test(name))
    .sort(),
];
const declared = Object.keys(testIsolationManifest).sort();
const allowedClasses = new Set([
  "pure-read-only",
  "process-local-global",
  "working-tree-mutation",
  "external-integration",
]);
const allowedExecution = new Set(["parallel", "serial"]);

assert.deepEqual(
  declared,
  [...discovered].sort(),
  "каждый discovered test должен иметь ровно одну явную запись в isolation manifest",
);

for (const file of discovered) {
  const entry = testIsolationManifest[file];
  assert.ok(entry, `${file}: отсутствует isolation entry`);
  assert.ok(allowedClasses.has(entry.class), `${file}: неизвестный isolation class ${entry.class}`);
  assert.ok(allowedExecution.has(entry.execution), `${file}: неизвестный execution mode ${entry.execution}`);
  assert.ok(Array.isArray(entry.resources), `${file}: resources должен быть массивом`);
  assert.equal(typeof entry.reason, "string", `${file}: reason должен быть строкой`);
  assert.ok(entry.reason.trim().length > 0, `${file}: reason не должен быть пустым`);

  const source = readFileSync(join(testsDir, file), "utf8");
  if (source.includes("./support/immutable-observation.mjs")) {
    assert.equal(entry.execution, "serial", `${file}: suite observation cache пока не доказан concurrent-safe`);
    assert.ok(
      entry.resources.includes("suite-observation-cache"),
      `${file}: shared observation cache должен быть объявлен явно`,
    );
  }

  if (source.includes("./support/run-cli.mjs")) {
    assert.ok(
      entry.resources.includes("process-local-console-env"),
      `${file}: runCliCaptured должен объявлять process-local console/env mutation`,
    );
  }
}

assert.deepEqual(testIsolationManifest["test-build-boundary.mjs"], {
  class: "working-tree-mutation",
  execution: "serial",
  resources: ["checkout:src", "checkout:dist"],
  reason: "временно изменяет реальные src/** и dist/** при проверке freshness boundary",
});

console.log(`#534 isolation manifest contract: ${discovered.length} test files classified.`);
