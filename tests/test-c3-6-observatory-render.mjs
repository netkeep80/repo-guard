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
import { observeImmutable } from "./support/immutable-observation.mjs";

const repoRoot = resolve(".");
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const packageVersion = packageJson.version;
const acceptedSha = observeImmutable("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
const observedAt = "2026-09-16T18:00:00Z";
const releaseCommit = "d".repeat(40);
const packageTag = `v${packageVersion}`;
const releaseUrl = `https://example.invalid/releases/${packageTag}`;
const integrityUrl = "https://example.invalid/runs/456";

const snapshot = await collectObservatorySnapshot({
  repoRoot,
  acceptedSha,
  observedAt,
  ci: {
    workflow: "CI",
    workflow_path: ".github/workflows/ci.yml",
    event: "push",
    branch: "main",
    head_sha: acceptedSha,
    run_id: 123,
    run_url: "https://example.invalid/runs/123",
    conclusion: "success",
  },
  releaseIntegrity: {
    target_sha: acceptedSha,
    tag: packageTag,
    run_id: 456,
    run_attempt: 2,
    run_url: integrityUrl,
    conclusion: "failure",
  },
  repository: "netkeep80/repo-guard",
  token: "test-token",
  fetchImpl: async (url) => {
    if (url.includes("/git/ref/tags/")) {
      return {
        status: 200,
        ok: true,
        async json() { return { object: { type: "commit", sha: releaseCommit } }; },
      };
    }
    if (url.includes("/releases/tags/")) {
      return {
        status: 200,
        ok: true,
        async json() {
          return {
            tag_name: packageTag,
            draft: false,
            prerelease: false,
            html_url: releaseUrl,
          };
        },
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  },
  run: observeImmutable,
});

assert.equal(snapshot.schema_version, 2);
assert.equal(snapshot.observed_at, observedAt);
assert.equal(snapshot.version.package_version, packageVersion);
assert.equal(snapshot.version.expected_release_tag, packageTag);
assert.equal(snapshot.release.stable_published, true);
assert.equal(snapshot.release.tag_commit, releaseCommit);
assert.equal(snapshot.release.tag_matches_accepted_sha, false);
assert.equal(snapshot.release_integrity?.conclusion, "failure");
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

assert.ok(first.includes(`Пакет: <code>${packageVersion}</code>`));
assert.ok(first.includes(`Ожидаемый тег: <code>${packageTag}</code>`));
assert.ok(first.includes(observedAt));
assert.ok(first.includes(releaseCommit));
assert.ok(first.includes(releaseUrl));
assert.match(first, /Стабильный выпуск:\s*да/);
assert.match(first, /Совпадение тега с принятым SHA:\s*нет/);
assert.ok(first.includes(integrityUrl));
assert.match(first, /Release integrity/);
assert.match(first, /попытка\s*2/);
assert.match(first, /failure/);

const withoutIntegrity = renderObservatory({
  ...snapshot,
  release_integrity: null,
});
assert.match(withoutIntegrity, /Release integrity/);
assert.match(withoutIntegrity, /нет привязанного результата/i);

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
  () => validateObservatorySnapshot({ ...snapshot, schema_version: 1 }),
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
    ...snapshot,
    release: {
      ...snapshot.release,
      tag_matches_accepted_sha: true,
    },
  }),
  /tag_matches_accepted_sha/,
);
assert.throws(
  () => validateObservatorySnapshot({
    ...snapshot,
    release_integrity: {
      ...snapshot.release_integrity,
      target_sha: releaseCommit,
    },
  }),
  /release integrity.*target/i,
);

console.log("C3.7 Observatory renderer snapshot v2 projection contract passed");
