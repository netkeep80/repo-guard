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

const unsafeSnapshot = {
  ...snapshot,
  scenarios: snapshot.scenarios.map((scenario, index) => (
    index === 0
      ? {
          ...scenario,
          title_ru: "Проверка <границы>",
          summary_ru: "Текст & данные",
        }
      : scenario
  )),
};

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

assert.match(first, /Пакет: <code>3\.0\.0<\/code>/);
assert.match(first, /Совпадающий тег: <code>v3\.0\.0<\/code>/);
assert.match(first, /Выпуск: не опубликован для совпадающего тега/);
assert.match(first, /Коммит выпуска: отсутствует/);

const releaseCommit = "d".repeat(40);
const releaseUrl = "https://example.invalid/releases/v3.0.0";
const publishedSnapshot = {
  ...snapshot,
  version: {
    ...snapshot.version,
    matching_published_release: true,
    release_commit: releaseCommit,
    release_url: releaseUrl,
    release_truth_status: "published",
  },
};
const publishedHtml = renderObservatory(publishedSnapshot);
assert.match(publishedHtml, new RegExp(releaseCommit));
assert.match(publishedHtml, /Коммит выпуска:/);
assert.ok(publishedHtml.includes(releaseUrl));

assert.doesNotMatch(first, /Проверка <границы>/);
assert.match(first, /Проверка &lt;границы&gt;/);
assert.match(first, /Текст &amp; данные/);

const repositoryUrl = `https://github.com/${snapshot.repository.full_name}`;
const roadmapUrl = `${repositoryUrl}/issues/370`;
assert.ok(first.includes(repositoryUrl));
assert.ok(first.includes(roadmapUrl));

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
assert.throws(
  () => validateObservatorySnapshot({
    ...publishedSnapshot,
    version: {
      ...publishedSnapshot.version,
      release_commit: null,
    },
  }),
  /release commit/i,
);
assert.throws(
  () => validateObservatorySnapshot({
    ...snapshot,
    version: {
      ...snapshot.version,
      release_commit: releaseCommit,
    },
  }),
  /release commit/i,
);

console.log("C3.7 Observatory renderer release projection contract passed");
