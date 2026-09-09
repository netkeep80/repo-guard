import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  collectObservatorySnapshot,
  stableJson,
} from "../scripts/observatory/collect.mjs";
import {
  renderCss,
  renderObservatory,
  validateObservatorySnapshot,
} from "../scripts/observatory/render.mjs";

const repoRoot = resolve(".");
const acceptedSha = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: repoRoot, encoding: "utf8" },
).trim();

const snapshot = await collectObservatorySnapshot({
  repoRoot,
  acceptedSha,
  ci: {
    workflow: "CI",
    run_id: 123,
    run_url: "https://example.invalid/runs/123",
    conclusion: "success",
  },
  repository: "netkeep80/repo-guard",
  token: "test-token",
  fetchImpl: async () => ({
    status: 404,
    ok: false,
    async json() { return {}; },
  }),
});

assert.equal(snapshot.scenarios.length, 5);
validateObservatorySnapshot(snapshot);

const unsafeSnapshot = structuredClone(snapshot);
unsafeSnapshot.scenarios[0].title_ru = "Проверка <границы>";
unsafeSnapshot.scenarios[0].summary_ru = "Текст & данные";

const first = renderObservatory(unsafeSnapshot);
const second = renderObservatory(unsafeSnapshot);
assert.equal(first, second);

for (const heading of [
  "Обсерватория политики",
  "Принятое состояние",
  "Собственная политика",
  "Каноническая архитектура",
  "Понижение ограничений",
  "Намерение, управление и доказательства",
  "Основной процесс проверки",
  "Сжатие архитектуры",
  "Исполняемые сценарии",
  "Канонические источники",
]) {
  assert.match(first, new RegExp(heading));
}

assert.match(first, new RegExp(acceptedSha));
assert.match(first, /primitive_relation/);
assert.match(first, /numeric_bound/);
assert.match(first, /forbidden-paths/);
assert.equal((first.match(/data-scenario-id=/g) ?? []).length, 5);
assert.equal((first.match(/data-case-result="PASS"/g) ?? []).length, 5);
assert.equal((first.match(/data-case-result="FAIL"/g) ?? []).length, 5);

assert.doesNotMatch(first, /Проверка <границы>/);
assert.match(first, /Проверка &lt;границы&gt;/);
assert.match(first, /Текст &amp; данные/);

const policyUrl = `https://github.com/${snapshot.repository.full_name}/blob/${acceptedSha}/repo-policy.json`;
assert.ok(first.includes(policyUrl));
for (const scenario of snapshot.scenarios) {
  const scenarioUrl = `https://github.com/${snapshot.repository.full_name}/blob/${acceptedSha}/${scenario.provenance.source}`;
  assert.ok(first.includes(scenarioUrl));
}

const cssFirst = renderCss();
const cssSecond = renderCss();
assert.equal(cssFirst, cssSecond);
assert.match(cssFirst, /color-scheme:\s*light dark/);
assert.doesNotMatch(cssFirst, /@import|url\(|https?:\/\//i);

const tempRoot = mkdtempSync(join(tmpdir(), "repo-guard-observatory-render-"));
try {
  const snapshotPath = join(tempRoot, "observatory.snapshot.json");
  const outputOne = join(tempRoot, "one");
  const outputTwo = join(tempRoot, "two");
  writeFileSync(snapshotPath, stableJson(snapshot), "utf8");

  const renderScript = resolve(repoRoot, "scripts/observatory/render.mjs");
  for (const output of [outputOne, outputTwo]) {
    execFileSync(
      process.execPath,
      [renderScript, "--snapshot", snapshotPath, "--output", output],
      { cwd: repoRoot, encoding: "utf8" },
    );
  }

  assert.deepEqual(
    readFileSync(join(outputOne, "index.html")),
    readFileSync(join(outputTwo, "index.html")),
  );
  assert.deepEqual(
    readFileSync(join(outputOne, "assets", "observatory.css")),
    readFileSync(join(outputTwo, "assets", "observatory.css")),
  );
  assert.deepEqual(readdirSync(outputOne).sort(), ["assets", "index.html"]);
  assert.deepEqual(
    readdirSync(join(outputOne, "assets")).sort(),
    ["observatory.css"],
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

assert.throws(
  () => validateObservatorySnapshot({ ...snapshot, schema_version: 2 }),
  /unsupported observatory snapshot schema/,
);
assert.throws(
  () => validateObservatorySnapshot({
    ...snapshot,
    accepted: {
      ...snapshot.accepted,
      ci: { ...snapshot.accepted.ci, conclusion: "failure" },
    },
  }),
  /successful CI/,
);

console.log("C3.6 Observatory renderer contract passed");
