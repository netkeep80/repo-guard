# C3.6 — план реализации русскоязычной обсерватории политики

> **Для исполняющих агентов:** обязательный навык `superpowers:subagent-driven-development` либо `superpowers:executing-plans`. Выполнять задачи строго по порядку и сохранять цикл красного и зелёного теста.

**Цель:** построить детерминированный сайт только для чтения, который показывает принятое состояние `repo-guard` и публикуется только после успешного основного процесса на том же коммите.

**Архитектура:** принятые файлы репозитория, существующие метрики, рабочий компилятор ограничений и ограниченные наблюдения `GitHub` собираются в один временный снимок. Отдельный чистый отрисовщик превращает снимок в статические файлы, а процесс страниц публикует их только при совпадении точного коммита с текущей веткой `main`.

**Стек:** `Node.js 24`, встроенные модули `Node.js`, существующие зависимости `yaml`, сгенерированное рабочее исполнение `repo-guard`, статические `HTML/CSS`, `GitHub Actions`.

**Спецификация:** `docs/superpowers/specs/2026-09-09-c3-6-policy-observatory-design.md`

## Общие ограничения

- Принятая база плана: `8257e9694175ebb57a22cf3f90e254d882a173e3`.
- Родительская задача: #377.
- Последовательность реализации: #438 → #439 → #440 → #441.
- Новый источник `FactRef` запрещён.
- Новый дескриптор отношения запрещён.
- Новый исполняемый вид ограничения запрещён.
- Новый публичный вызов командной строки запрещён.
- Второй разборщик или вычислитель политики запрещён.
- Ручной список поддерживаемых правил запрещён.
- Ручной список сценариев запрещён.
- Генерируемые `_site/**` и `observatory.snapshot.json` в репозиторий не коммитятся.
- Переход версии C3.7 не входит в работу.
- Оптимизация процессов C3.8 не входит в работу.
- Полная основная проверка не повторяется внутри процесса страниц.
- Живая защита ветки не читается через расширенное административное разрешение.
- Единственный управляющий путь C3.6 — `.github/workflows/pages.yml`; его изменение разрешено узкой санкцией в #440.
- Для публикации используются текущие линии действий, подтверждённые документацией `GitHub`: `actions/checkout@v6`, `actions/setup-node@v6`, `actions/configure-pages@v5`, `actions/upload-pages-artifact@v4`, `actions/deploy-pages@v4`.

---

## Карта файлов

Новые файлы:

```text
scripts/observatory/collect.mjs
scripts/observatory/render.mjs
tests/test-c3-6-observatory-snapshot.mjs
tests/test-c3-6-observatory-render.mjs
tests/test-c3-6-pages-workflow.mjs
.github/workflows/pages.yml
```

Изменяемый существующий файл:

```text
README.md
```

Не изменяются:

```text
src/**
dist/**
schemas/**
repo-policy.json
action.yml
package.json
package-lock.json
scripts/compression-metrics.mjs
examples/scenarios/**
```

Ответственность файлов:

- `collect.mjs` читает принятые факты, вызывает существующие машинные источники, нормализует ограниченное наблюдение выпуска и пишет детерминированный снимок.
- `render.mjs` читает только снимок, проверяет минимальную форму и пишет статические файлы.
- первый тест фиксирует границу снимка и отсутствие новой семантики;
- второй тест фиксирует русскую статическую проекцию и детерминизм;
- третий тест фиксирует безопасность, свежесть и стоимость процесса страниц;
- `pages.yml` связывает успешный основной процесс с публикацией точного коммита;
- `README.md` только ведёт на опубликованную обсерваторию.

---

### Задача 1: #438 — детерминированный снимок принятого состояния

**Файлы:**
- создать `tests/test-c3-6-observatory-snapshot.mjs`;
- создать `scripts/observatory/collect.mjs`.

**Интерфейсы:**

Сборщик экспортирует:

```js
export const C3_BASELINE_SHA =
  "92432809fcddc290080beb51ba151e13a5761869";

export async function collectObservatorySnapshot({
  repoRoot,
  acceptedSha,
  ci,
  repository,
  token,
  fetchImpl = globalThis.fetch,
  run = runProcess,
}) {}

export function stableJson(value) {}
```

Поле `ci` имеет форму:

```js
{
  workflow: "CI",
  run_id: 123,
  run_url: "https://github.com/netkeep80/repo-guard/actions/runs/123",
  conclusion: "success"
}
```

Функция возвращает обычный объект снимка. Сетевой запрос разрешён только для чтения выпуска, а `fetchImpl` внедряется для тестов.

#### Шаг 1.1: написать красный тест отсутствующего сборщика

Создать `tests/test-c3-6-observatory-snapshot.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  collectObservatorySnapshot,
  stableJson,
} from "../scripts/observatory/collect.mjs";

const repoRoot = resolve(".");
const acceptedSha = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: repoRoot, encoding: "utf8" },
).trim();

const release404 = async () => ({
  status: 404,
  ok: false,
  async json() { return {}; },
});

const input = {
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
  fetchImpl: release404,
};

const first = await collectObservatorySnapshot(input);
const second = await collectObservatorySnapshot(input);

assert.equal(first.schema_version, 1);
assert.equal(first.accepted.sha, acceptedSha);
assert.equal(first.accepted.ci.conclusion, "success");
assert.equal(first.version.package_version, "2.0.0");
assert.equal(first.version.matching_release_tag, "v2.0.0");
assert.equal(first.version.matching_published_release, false);
assert.equal(first.version.release_truth_status, "package_only");

assert.deepEqual(
  first.architecture.current.architecture.canonical_fact_sources,
  ["change_intent", "diff", "document", "repository"],
);
assert.deepEqual(
  first.architecture.current.architecture.runtime_constraint_kind_names,
  ["primitive_relation"],
);
assert.equal(
  first.architecture.current.architecture.primitive_descriptor_registry_count,
  1,
);

assert.equal(first.scenarios.length, 5);
assert.deepEqual(
  first.scenarios.map((item) => item.id).sort(),
  [
    "contract-evidence",
    "governance-cutover",
    "minimal-diff-policy",
    "surgical-change",
    "version-transition",
  ],
);
assert.ok(first.scenarios.every((item) => item.cases.length === 2));

assert.ok(first.policy.constraint_program.length > 0);
assert.ok(
  first.policy.constraint_program
    .filter((entry) => entry.runtime)
    .every((entry) => entry.runtime.kind === "primitive_relation"),
);

assert.equal(stableJson(first), stableJson(second));
assert.ok(!stableJson(first).includes(repoRoot));

const policy = JSON.parse(
  readFileSync(resolve(repoRoot, "repo-policy.json"), "utf8"),
);
assert.deepEqual(first.policy.accepted, policy);

console.log("C3.6 Observatory snapshot contract passed");
```

#### Шаг 1.2: запустить тест и зафиксировать правильный красный результат

Команда:

```bash
node tests/test-c3-6-observatory-snapshot.mjs
```

Ожидаемый результат:

```text
ERR_MODULE_NOT_FOUND
scripts/observatory/collect.mjs
```

Никакие рабочие файлы до этого запуска не создавать.

#### Шаг 1.3: реализовать чтение только принятых источников

В `scripts/observatory/collect.mjs` использовать только существующие зависимости:

```js
import {
  execFileSync,
} from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  resolve,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";
import {
  parseDocument,
} from "yaml";
import {
  compileConstraintProgram,
} from "../../dist/checks/constraint-program.mjs";

export const C3_BASELINE_SHA =
  "92432809fcddc290080beb51ba151e13a5761869";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, "../..");

function readJson(repoRoot, path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
}

function readYaml(repoRoot, path) {
  const doc = parseDocument(
    readFileSync(resolve(repoRoot, path), "utf8"),
    { prettyErrors: false },
  );
  if (doc.errors.length) {
    throw new Error(
      `invalid YAML ${path}: ${doc.errors.map((item) => item.message).join("; ")}`,
    );
  }
  return doc.toJSON();
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function runProcess(file, args, options = {}) {
  return execFileSync(
    file,
    args,
    { encoding: "utf8", ...options },
  ).trim();
}
```

Сценарии обнаруживать без списка идентификаторов:

```js
function collectScenarios(repoRoot) {
  const root = resolve(repoRoot, "examples/scenarios");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name, "scenario.json"))
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    })
    .map((path) => JSON.parse(readFileSync(path, "utf8")))
    .sort((left, right) => left.id.localeCompare(right.id));
}
```

Каждый найденный манифест проверять перед включением:

```js
function assertScenario(manifest) {
  if (
    !manifest
    || typeof manifest.id !== "string"
    || typeof manifest.title_ru !== "string"
    || typeof manifest.summary_ru !== "string"
    || typeof manifest.command !== "string"
    || !Array.isArray(manifest.cases)
    || manifest.cases.length === 0
  ) {
    throw new Error("invalid executable scenario manifest");
  }
}
```

Архитектурные метрики получать только через существующий скрипт:

```js
function collectCompressionMetrics(repoRoot, run) {
  const output = run(
    process.execPath,
    [
      resolve(repoRoot, "scripts/compression-metrics.mjs"),
      "--compare",
      C3_BASELINE_SHA,
    ],
    { cwd: repoRoot },
  );
  return JSON.parse(output);
}
```

Собственную политику понижать только рабочим компилятором:

```js
const policy = readJson(repoRoot, "repo-policy.json");
const constraintProgram = compileConstraintProgram(policy, null);
```

Схему основного процесса читать обычным разбором `YAML`:

```js
function collectCiWiring(repoRoot) {
  const workflow = readYaml(repoRoot, ".github/workflows/ci.yml");
  return {
    source: ".github/workflows/ci.yml",
    name: workflow.name,
    triggers: Object.keys(workflow.on || {}).sort(),
    jobs: Object.entries(workflow.jobs || {})
      .map(([id, job]) => ({
        id,
        steps: (job.steps || [])
          .map((step) => step.name || step.uses || step.run)
          .filter(Boolean),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}
```

#### Шаг 1.4: добавить ограниченное наблюдение выпуска с запретом по умолчанию

В том же модуле:

```js
async function observeMatchingRelease({
  repository,
  tag,
  token,
  fetchImpl,
}) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (response.status === 404) {
    return {
      tag,
      matching_published_release: false,
      release_url: null,
    };
  }

  if (!response.ok) {
    throw new Error(
      `GitHub release observation failed with status ${response.status}`,
    );
  }

  const release = await response.json();
  return {
    tag,
    matching_published_release: release.draft !== true,
    release_url: release.draft === true ? null : release.html_url,
  };
}
```

Не трактовать сетевую ошибку, `403`, `500` или некорректный ответ как отсутствие выпуска.

#### Шаг 1.5: собрать снимок с явным происхождением

Основной метод:

```js
export async function collectObservatorySnapshot({
  repoRoot = defaultRepoRoot,
  acceptedSha,
  ci,
  repository,
  token,
  fetchImpl = globalThis.fetch,
  run = runProcess,
}) {
  const checkoutSha = run(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot },
  );

  if (checkoutSha !== acceptedSha) {
    throw new Error(
      `accepted SHA mismatch: checkout=${checkoutSha} expected=${acceptedSha}`,
    );
  }
  if (ci?.workflow !== "CI" || ci?.conclusion !== "success") {
    throw new Error("accepted CI evidence is not successful CI");
  }

  const packageJson = readJson(repoRoot, "package.json");
  const policy = readJson(repoRoot, "repo-policy.json");
  const tag = `v${packageJson.version}`;
  const release = await observeMatchingRelease({
    repository,
    tag,
    token,
    fetchImpl,
  });

  const scenarios = collectScenarios(repoRoot);
  scenarios.forEach(assertScenario);

  return {
    schema_version: 1,
    accepted: {
      sha: acceptedSha,
      ci,
      provenance: {
        origin: "accepted_ci",
        sha: acceptedSha,
      },
    },
    version: {
      package_version: packageJson.version,
      matching_release_tag: tag,
      matching_published_release:
        release.matching_published_release,
      release_url: release.release_url,
      release_truth_status:
        release.matching_published_release
          ? "published"
          : "package_only",
      provenance: {
        origin: "github_observation",
        sha: acceptedSha,
      },
    },
    policy: {
      source: "repo-policy.json",
      accepted: policy,
      constraint_program:
        compileConstraintProgram(policy, null),
      provenance: {
        origin: "accepted_commit",
        sha: acceptedSha,
        path: "repo-policy.json",
      },
    },
    architecture:
      collectCompressionMetrics(repoRoot, run),
    ci: collectCiWiring(repoRoot),
    scenarios,
    sources: [
      "package.json",
      "repo-policy.json",
      ".github/workflows/ci.yml",
      "examples/scenarios/**",
      "scripts/compression-metrics.mjs",
      "dist/checks/constraint-program.mjs",
    ].sort(),
  };
}
```

#### Шаг 1.6: добавить узкий интерфейс запуска для процесса страниц

Разбирать только нужные параметры:

```text
--accepted-sha
--ci-run-id
--ci-run-url
--ci-conclusion
--repository
--output
```

Токен брать только из `GITHUB_TOKEN`.

После сборки:

```js
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, stableJson(snapshot), "utf8");
```

Не добавлять команду в публичный реестр `repo-guard` и не менять `package.json`.

#### Шаг 1.7: расширить тест на запрет по умолчанию

В тест добавить:

```js
await assert.rejects(
  () => collectObservatorySnapshot({
    ...input,
    fetchImpl: async () => ({
      status: 500,
      ok: false,
      async json() { return {}; },
    }),
  }),
  /release observation failed/,
);

await assert.rejects(
  () => collectObservatorySnapshot({
    ...input,
    acceptedSha: "0".repeat(40),
  }),
  /accepted SHA mismatch/,
);
```

#### Шаг 1.8: запустить целевой и полный набор

Команды:

```bash
node tests/test-c3-6-observatory-snapshot.mjs
npm test
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

Ожидается:

```text
C3.6 Observatory snapshot contract passed
All ... test files passed.
runtime_constraint_kinds = 1
canonical_factref_model_count = 1
primitive_descriptor_registry_count = 1
```

#### Шаг 1.9: зафиксировать срез

```bash
git add scripts/observatory/collect.mjs tests/test-c3-6-observatory-snapshot.mjs
git commit -m "feat(c3.6): build deterministic observatory snapshot"
```

PR должен закрывать #438 и не менять управляющие пути.

---

### Задача 2: #439 — чистая статическая русская отрисовка

**Файлы:**
- создать `tests/test-c3-6-observatory-render.mjs`;
- создать `scripts/observatory/render.mjs`.

**Интерфейсы:**

```js
export function validateObservatorySnapshot(snapshot) {}
export function renderObservatory(snapshot) {}
export function renderCss() {}
```

`renderObservatory` возвращает строку `index.html`. Она не читает файлы и не делает сетевых запросов.

#### Шаг 2.1: написать красный тест отрисовщика

Создать `tests/test-c3-6-observatory-render.mjs`:

```js
import assert from "node:assert/strict";

import {
  renderObservatory,
  validateObservatorySnapshot,
} from "../scripts/observatory/render.mjs";

const snapshot = {
  schema_version: 1,
  accepted: {
    sha: "a".repeat(40),
    ci: {
      workflow: "CI",
      run_id: 123,
      run_url: "https://example.invalid/runs/123",
      conclusion: "success",
    },
  },
  version: {
    package_version: "2.0.0",
    matching_release_tag: "v2.0.0",
    matching_published_release: false,
    release_url: null,
    release_truth_status: "package_only",
  },
  policy: {
    accepted: {
      policy_format_version: "0.3.0",
      repository_kind: "tooling",
      enforcement: { mode: "blocking" },
    },
    constraint_program: [{
      key: "paths:forbidden",
      runtime: {
        kind: "primitive_relation",
        primitive: "numeric_bound",
      },
      strictness: null,
    }],
  },
  architecture: {
    current: {
      architecture: {
        canonical_fact_sources: [
          "change_intent",
          "diff",
          "document",
          "repository",
        ],
        runtime_constraint_kind_names: ["primitive_relation"],
        primitive_descriptor_kinds: ["numeric_bound"],
      },
    },
  },
  ci: {
    source: ".github/workflows/ci.yml",
    name: "CI",
    triggers: ["pull_request", "push"],
    jobs: [{ id: "validate", steps: ["Run discovered test suite"] }],
  },
  scenarios: [{
    id: "escape-check",
    title_ru: "Проверка <границы>",
    summary_ru: "Текст & данные",
    command: "check-diff",
    cases: [
      { id: "pass", title_ru: "Проходит", expected_exit_code: 0 },
      {
        id: "fail",
        title_ru: "Блокируется",
        expected_exit_code: 1,
        expected_diagnostics: ["forbidden-paths"],
      },
    ],
  }],
  sources: ["repo-policy.json"],
};

validateObservatorySnapshot(snapshot);
const first = renderObservatory(snapshot);
const second = renderObservatory(snapshot);

assert.equal(first, second);
assert.match(first, /Обсерватория политики/);
assert.match(first, new RegExp("a".repeat(40)));
assert.match(first, /Принятое состояние/);
assert.match(first, /Собственная политика/);
assert.match(first, /Каноническая архитектура/);
assert.match(first, /Понижение ограничений/);
assert.match(first, /Намерение, управление и доказательства/);
assert.match(first, /Основной процесс проверки/);
assert.match(first, /Сжатие архитектуры/);
assert.match(first, /Исполняемые сценарии/);
assert.match(first, /numeric_bound/);
assert.match(first, /primitive_relation/);
assert.match(first, /forbidden-paths/);

assert.doesNotMatch(first, /Проверка <границы>/);
assert.match(first, /Проверка &lt;границы&gt;/);
assert.match(first, /Текст &amp; данные/);

console.log("C3.6 Observatory renderer contract passed");
```

#### Шаг 2.2: запустить тест и получить красный результат

```bash
node tests/test-c3-6-observatory-render.mjs
```

Ожидается отсутствие `scripts/observatory/render.mjs`.

#### Шаг 2.3: реализовать минимальную проверку формы

В `render.mjs`:

```js
function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid snapshot section: ${name}`);
  }
}

export function validateObservatorySnapshot(snapshot) {
  requireObject(snapshot, "root");
  if (snapshot.schema_version !== 1) {
    throw new Error("unsupported observatory snapshot schema");
  }
  requireObject(snapshot.accepted, "accepted");
  if (!/^[0-9a-f]{40}$/.test(snapshot.accepted.sha || "")) {
    throw new Error("invalid accepted SHA");
  }
  if (snapshot.accepted.ci?.conclusion !== "success") {
    throw new Error("snapshot is not backed by successful CI");
  }
  if (!Array.isArray(snapshot.scenarios)) {
    throw new Error("invalid scenarios");
  }
}
```

Это проверка формы промежуточного артефакта, а не новый парсер политики.

#### Шаг 2.4: реализовать безопасные примитивы представления

```js
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonBlock(value) {
  return `<pre><code>${escapeHtml(
    JSON.stringify(value, null, 2),
  )}</code></pre>`;
}

function immutableSourceUrl(sha, path) {
  return `https://github.com/netkeep80/repo-guard/blob/${sha}/${path}`;
}
```

Все значения из политики и сценариев проходят через `escapeHtml`.

#### Шаг 2.5: собрать обязательные разделы без второго инвентаря

`renderObservatory(snapshot)` строит разделы только из полей снимка.

Для архитектуры:

```js
const architecture =
  snapshot.architecture.current.architecture;

const factSources =
  architecture.canonical_fact_sources || [];
const runtimeKinds =
  architecture.runtime_constraint_kind_names || [];
const relations =
  architecture.primitive_descriptor_kinds || [];
```

Для сценариев:

```js
const scenarioCards = snapshot.scenarios
  .map((scenario) => renderScenarioCard(scenario))
  .join("\n");
```

Никакого массива допустимых идентификаторов правил или сценариев в `render.mjs` не добавлять.

Пояснительная топология допустима как статический русский текст:

```text
ChangeIntent
  ↓
доверенная связанная задача
  ↓
GovernanceGrant
  ↓
сравнение доверенной BASE и предлагаемой HEAD политики
  ↓
AnalysisReport
```

#### Шаг 2.6: создать минимальное оформление

`renderCss()` должен возвращать небольшой самостоятельный файл без внешних шрифтов и сетевых ресурсов.

Обязательные свойства:

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}
body {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px;
  line-height: 1.5;
}
code, pre {
  font-family: ui-monospace, monospace;
}
section {
  margin-block: 32px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
```

Не задавать внешний клиентский ресурс.

#### Шаг 2.7: добавить узкий интерфейс запуска

Поддержать:

```text
--snapshot <path>
--output <directory>
```

После проверки создать только:

```text
<output>/index.html
<output>/assets/observatory.css
```

#### Шаг 2.8: проверить детерминизм файлов

Расширить тест временным каталогом и двумя последовательными запусками:

```js
const firstBytes = readFileSync(firstIndex);
const secondBytes = readFileSync(secondIndex);
assert.deepEqual(firstBytes, secondBytes);
```

#### Шаг 2.9: запустить целевой и полный набор

```bash
node tests/test-c3-6-observatory-render.mjs
npm test
```

Ожидаются оба зелёных результата.

#### Шаг 2.10: зафиксировать срез

```bash
git add scripts/observatory/render.mjs tests/test-c3-6-observatory-render.mjs
git commit -m "feat(c3.6): render deterministic policy observatory"
```

PR закрывает #439.

---

### Задача 3: #440 — публикация только принятого точного коммита

**Файлы:**
- создать `tests/test-c3-6-pages-workflow.mjs`;
- создать `.github/workflows/pages.yml`.

**Доверие:** PR обязан ссылаться на #440 через `Fixes #440`. В #440 уже есть узкая санкция:

```repo-guard-grant
authorized_governance_paths:
  - .github/workflows/pages.yml
allow_policy_relaxation: []
```

#### Шаг 3.1: написать красный структурный тест процесса

Создать `tests/test-c3-6-pages-workflow.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

const path = ".github/workflows/pages.yml";
const raw = readFileSync(path, "utf8");
const doc = parseDocument(raw, { prettyErrors: false });

assert.equal(doc.errors.length, 0);
const workflow = doc.toJSON();

assert.equal(workflow.name, "Policy Observatory Pages");
assert.deepEqual(
  workflow.on.workflow_run.workflows,
  ["CI"],
);
assert.deepEqual(
  workflow.on.workflow_run.types,
  ["completed"],
);
assert.deepEqual(
  workflow.on.workflow_run.branches,
  ["main"],
);

assert.equal(
  workflow.concurrency.group,
  "pages",
);
assert.equal(
  workflow.concurrency["cancel-in-progress"],
  true,
);

const build = workflow.jobs.build;
const deploy = workflow.jobs.deploy;

assert.equal(build.permissions.contents, "read");
assert.equal(build.permissions.actions, undefined);
assert.equal(build.permissions.pages, "read");
assert.equal(build.permissions.issues, undefined);
assert.equal(build.permissions["pull-requests"], undefined);

assert.equal(deploy.permissions.contents, "read");
assert.equal(deploy.permissions.pages, "write");
assert.equal(deploy.permissions["id-token"], "write");

assert.match(raw, /workflow_run\.conclusion == 'success'/);
assert.match(raw, /github\.event\.workflow_run\.head_sha/);
assert.match(raw, /git rev-parse HEAD/);
assert.ok(
  (raw.match(/git ls-remote origin refs\/heads\/main/g) || []).length >= 2,
);

assert.match(raw, /actions\/checkout@v6/);
assert.match(raw, /actions\/setup-node@v6/);
assert.match(raw, /actions\/configure-pages@v5/);
assert.match(raw, /actions\/upload-pages-artifact@v4/);
assert.match(raw, /actions\/deploy-pages@v4/);

assert.doesNotMatch(raw, /npm test/);
assert.doesNotMatch(raw, /check:dist/);
assert.doesNotMatch(raw, /npx repo-guard/);

console.log("C3.6 Pages workflow contract passed");
```

#### Шаг 3.2: запустить тест и зафиксировать красный результат

```bash
node tests/test-c3-6-pages-workflow.mjs
```

Ожидается:

```text
ENOENT
.github/workflows/pages.yml
```

#### Шаг 3.3: добавить процесс с разделёнными разрешениями

Минимальная форма `.github/workflows/pages.yml`:

```yaml
name: Policy Observatory Pages

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: read
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
          fetch-depth: 0

      - uses: actions/setup-node@v6
        with:
          node-version: "24"

      - run: npm ci --omit=dev

      - name: Verify accepted checkout
        env:
          ACCEPTED_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          test "$(git rev-parse HEAD)" = "$ACCEPTED_SHA"

      - name: Verify current main before build
        env:
          ACCEPTED_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$ACCEPTED_SHA"

      - name: Build Observatory snapshot
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          node scripts/observatory/collect.mjs \
            --accepted-sha "${{ github.event.workflow_run.head_sha }}" \
            --ci-run-id "${{ github.event.workflow_run.id }}" \
            --ci-run-url "${{ github.event.workflow_run.html_url }}" \
            --ci-conclusion "${{ github.event.workflow_run.conclusion }}" \
            --repository "${{ github.repository }}" \
            --output ".observatory/observatory.snapshot.json"

      - name: Render Observatory
        run: |
          node scripts/observatory/render.mjs \
            --snapshot ".observatory/observatory.snapshot.json" \
            --output "_site"

      - uses: actions/configure-pages@v5

      - name: Verify current main before upload
        env:
          ACCEPTED_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$ACCEPTED_SHA"

      - uses: actions/upload-pages-artifact@v4
        with:
          path: _site

  deploy:
    if: github.event.workflow_run.conclusion == 'success'
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - name: Verify current main before deploy
        env:
          ACCEPTED_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$ACCEPTED_SHA"

      - name: Deploy GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

Здесь нет запуска произвольного кода из PR: `workflow_run` ограничен успешным процессом `CI` на `main`, а исходники берутся по его точному принятому коммиту.

#### Шаг 3.4: проверить отсутствие лишних разрешений

Добавить:

```js
for (const permissions of [
  build.permissions,
  deploy.permissions,
]) {
  assert.equal(permissions.issues, undefined);
  assert.equal(permissions["pull-requests"], undefined);
  assert.equal(permissions.workflows, undefined);
  assert.notEqual(permissions.contents, "write");
}
```

#### Шаг 3.5: запустить целевой и полный набор

```bash
node tests/test-c3-6-pages-workflow.mjs
npm test
```

До перевода PR в готовое состояние дополнительно запустить:

```bash
node dist/repo-guard.mjs check-pr
```

в реальном контексте PR через основной процесс. Ожидаемый диагностический результат — управляющее изменение разрешено санкцией из #440 и других нарушений нет.

#### Шаг 3.6: перевести PR в готовое состояние только после зелёного чернового запуска

Проверить точную голову PR:

```text
validate = SUCCESS
smoke-pack = SUCCESS
```

После перевода в готовое состояние дождаться нового запуска на той же голове PR и обязательно проверить:

```text
Run PR policy check = SUCCESS
```

#### Шаг 3.7: слить только с защитой головы

Перед merge заново проверить:

```text
main
PR head
mergeable = true
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

Слияние выполнять с `expected_head_sha`.

После merge проверить основной процесс на новом `main`.

#### Шаг 3.8: зафиксировать срез

Коммит до PR:

```bash
git add .github/workflows/pages.yml tests/test-c3-6-pages-workflow.mjs
git commit -m "feat(c3.6): deploy exact-sha policy observatory"
```

PR закрывает #440.

---

### Задача 4: #441 — включение страниц, навигация и живая приёмка

**Файлы:**
- изменить `README.md`.

**Внешнее состояние репозитория:**
- источник публикации страниц должен быть `GitHub Actions`.

#### Шаг 4.1: проверить живое состояние страниц

До записи проверить metadata репозитория.

Ожидаемая исходная точка до первого включения:

```text
has_pages = false
```

Если страницы уже включены другим принятым изменением, не переключать их повторно.

#### Шаг 4.2: включить источник публикации

Использовать штатную настройку репозитория:

```text
Settings
→ Pages
→ Build and deployment
→ Source
→ GitHub Actions
```

Если доступный автоматизированный интерфейс репозитория поддерживает безопасное включение без постоянного привилегированного токена, допустимо использовать его. Сам процесс `pages.yml` не получает разрешение администрирования.

#### Шаг 4.3: дождаться первого принятого запуска страниц

После включения инициирующим состоянием должен быть успешный основной процесс на принятом `main`.

Проверить:

```text
build = SUCCESS
deploy = SUCCESS
```

Получить опубликованный адрес из результата `actions/deploy-pages`.

#### Шаг 4.4: проверить сайт как пользователь

Проверить опубликованный `index.html`:

- виден полный принятый коммит;
- этот коммит равен текущему `main`;
- показана версия пакета;
- отсутствие выпуска не изображается как опубликованный выпуск;
- четыре источника `FactRef` показаны из машинных метрик;
- показан единственный `primitive_relation`;
- показаны пять исполняемых сценариев;
- присутствуют карточки успешного и блокируемого вариантов;
- есть ссылки на неизменяемые исходники по принятому коммиту;
- нет элементов изменения политики, согласования или запуска процессов.

#### Шаг 4.5: добавить минимальную ссылку в `README.md`

В раздел архитектуры или сразу после него добавить один русский абзац:

```md
Текущее принятое состояние политики, архитектурные метрики и исполняемые сценарии доступны в [обсерватории политики](https://netkeep80.github.io/repo-guard/). Сайт предназначен только для чтения; источником истины остаются файлы принятой ветки `main`.
```

Не копировать в `README.md` таблицы сценариев или архитектурный инвентарь.

#### Шаг 4.6: проверить документацию и полный набор

```bash
node tests/test-documentation-language.mjs
npm test
```

Ожидается зелёный результат.

#### Шаг 4.7: зафиксировать документационный срез

```bash
git add README.md
git commit -m "docs(c3.6): link live policy observatory"
```

PR закрывает #441.

#### Шаг 4.8: проверить послемержевую публикацию нового README

После merge основной процесс нового `main` должен быть зелёным, затем новый процесс страниц должен опубликовать сайт того же точного коммита.

Проверить:

```text
main SHA
==
workflow_run.head_sha
==
SHA shown on Pages
```

#### Шаг 4.9: закрыть родительскую задачу только после живой проверки

В #377 записать:

```text
accepted main = <exact merge SHA>
Pages workflow = SUCCESS
Pages deployment = SUCCESS
live URL = https://netkeep80.github.io/repo-guard/
snapshot scenarios = 5
runtime constraint kinds = 1
FactRef sources = 4
relation descriptors = 10
write/authority surface = NONE
```

После этого закрыть #377 с причиной `completed`.

---

## Проверка плана перед исполнением

### Покрытие спецификации

Соответствие:

- точный принятый коммит — задача 1 и задача 3;
- версия и состояние выпуска — задача 1;
- собственная политика — задача 1 и задача 2;
- источники `FactRef` и отношения — задача 1 и задача 2;
- понижение рабочим компилятором — задача 1;
- топология намерения и управления — задача 2;
- схема основного процесса — задача 1 и задача 2;
- метрики сжатия — задача 1 и задача 2;
- каталог сценариев — задача 1 и задача 2;
- русская статическая страница — задача 2;
- запрет на запись — задачи 1–3;
- проверка устаревания — задача 3;
- экономная сборка — задача 3;
- реальная публикация — задача 4;
- двусторонняя навигация — задача 2 и задача 4.

Непокрытых требований нет.

### Проверка границ типов и имён

Имена между задачами согласованы:

```text
collectObservatorySnapshot
stableJson
validateObservatorySnapshot
renderObservatory
observatory.snapshot.json
_site/index.html
_site/assets/observatory.css
```

Снимок остаётся внутренним форматом сборки и не становится публичным контрактом пакета.

### Проверка отсутствия скрытого расширения архитектуры

План не меняет:

```text
src/**
dist/**
schemas/**
repo-policy.json
action.yml
package.json
```

Следовательно, C3.6 не требует нового семантического механизма продукта. Единственная новая исполняемая поверхность — вспомогательные скрипты наблюдения и отдельный процесс публикации.

### Порядок исполнения

```text
#438 snapshot
  ↓
#439 renderer
  ↓
#440 workflow
  ↓
#441 activation/docs/live acceptance
  ↓
#377 completed
```

Параллельное исполнение этих четырёх задач не использовать: каждая следующая опирается на принятую границу предыдущей.
