import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testIsolationManifest } from "./test-isolation-manifest.mjs";
import {
  buildExecutionBatches,
  executeBatches,
  resolveWorkerCount,
} from "./support/test-runner.mjs";

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

function importsModule(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fromImport = new RegExp(
    `^\\s*import\\b[^;]*\\bfrom\\s+["']${escaped}["']\\s*;`,
    "m",
  );
  const sideEffectImport = new RegExp(
    `^\\s*import\\s+["']${escaped}["']\\s*;`,
    "m",
  );
  return fromImport.test(source) || sideEffectImport.test(source);
}

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
  if (importsModule(source, "./support/immutable-observation.mjs")) {
    assert.equal(entry.execution, "serial", `${file}: suite observation cache пока не доказан concurrent-safe`);
    assert.ok(
      entry.resources.includes("suite-observation-cache"),
      `${file}: shared observation cache должен быть объявлен явно`,
    );
  }

  if (importsModule(source, "./support/run-cli.mjs")) {
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

const syntheticManifest = {
  "01-parallel.mjs": { execution: "parallel" },
  "02-parallel.mjs": { execution: "parallel" },
  "03-serial.mjs": { execution: "serial" },
  "04-parallel.mjs": { execution: "parallel" },
};
assert.deepEqual(
  buildExecutionBatches(Object.keys(syntheticManifest), syntheticManifest),
  [
    { execution: "parallel", files: ["01-parallel.mjs", "02-parallel.mjs"] },
    { execution: "serial", files: ["03-serial.mjs"] },
    { execution: "parallel", files: ["04-parallel.mjs"] },
  ],
  "serial tests должны быть барьерами между bounded parallel batches",
);
assert.throws(
  () => buildExecutionBatches(["unknown.mjs"], syntheticManifest),
  /isolation manifest/i,
  "неизвестный test должен fail-closed до запуска",
);

assert.equal(resolveWorkerCount(undefined, 1), 1);
assert.equal(resolveWorkerCount("2", 1), 2);
assert.equal(resolveWorkerCount("4", 1), 4);
assert.throws(() => resolveWorkerCount("0", 1), /worker/i);
assert.throws(() => resolveWorkerCount("5", 1), /worker/i);
assert.throws(() => resolveWorkerCount("abc", 1), /worker/i);

const events = [];
const emitted = [];
let active = 0;
let maxActive = 0;
const delays = new Map([
  ["01-parallel.mjs", 30],
  ["02-parallel.mjs", 5],
  ["03-serial.mjs", 1],
  ["04-parallel.mjs", 1],
]);
const batches = buildExecutionBatches(Object.keys(syntheticManifest), syntheticManifest);
const failedStatus = await executeBatches(batches, {
  workerCount: 2,
  async runFile(file) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${file}`);
    await new Promise((resolve) => setTimeout(resolve, delays.get(file)));
    events.push(`end:${file}`);
    active -= 1;
    return { status: 0, stdout: `${file}\n`, stderr: "" };
  },
  emitResult(file) {
    emitted.push(file);
  },
});
assert.equal(failedStatus, null);
assert.equal(maxActive, 2, "parallel batch не должен превышать worker bound");
assert.deepEqual(
  emitted,
  Object.keys(syntheticManifest),
  "результаты должны публиковаться в canonical input order, а не completion order",
);
assert.ok(
  events.indexOf("start:03-serial.mjs") > events.indexOf("end:01-parallel.mjs")
    && events.indexOf("start:03-serial.mjs") > events.indexOf("end:02-parallel.mjs"),
  "serial barrier должен стартовать только после завершения предыдущего parallel batch",
);
assert.ok(
  events.indexOf("start:04-parallel.mjs") > events.indexOf("end:03-serial.mjs"),
  "следующий parallel batch не должен пересекаться с serial barrier",
);

const failureEvents = [];
const failureStatus = await executeBatches(batches, {
  workerCount: 2,
  async runFile(file) {
    failureEvents.push(`run:${file}`);
    return { status: file === "01-parallel.mjs" ? 7 : 0, stdout: "", stderr: "" };
  },
  emitResult(file) {
    failureEvents.push(`emit:${file}`);
  },
});
assert.equal(failureStatus, 7);
assert.deepEqual(
  failureEvents,
  [
    "run:01-parallel.mjs",
    "run:02-parallel.mjs",
    "emit:01-parallel.mjs",
    "emit:02-parallel.mjs",
  ],
  "после failed parallel batch следующие serial/parallel batches запускаться не должны",
);

console.log(`#534 isolation + scheduler contract: ${discovered.length} test files classified.`);
