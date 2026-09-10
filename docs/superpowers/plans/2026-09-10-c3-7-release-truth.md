# C3.7 — План реализации единой версии и истины выпуска

> **Для исполнителя:** использовать `superpowers:executing-plans` или `superpowers:subagent-driven-development`. Задачи выполнять строго последовательно. Каждый новый поведенческий контракт сначала подтверждать красным тестом.

**Цель:** сделать `3.0.0` единственной канонической версией продукта и выводить официальный выпуск из неизменяемого тега, точного коммита и опубликованного выпуска `GitHub`.

**Спецификация:** `docs/superpowers/specs/2026-09-10-c3-7-release-truth-design.md`.

**Принятая база плана:** `aee40dac928bf6ce20b7296a21d3525933f7ad4d`.

## 1. Неизменяемые границы

```text
parent = #378
roadmap = #370
order = #452 -> #453 -> #454
canonical version authority = package.json.version
package-lock.json = derived npm mirror
actual v3.0.0 release = C3.10 only
```

C3.7 не создаёт:

```text
VERSION
release-state.json
target-version.json
v3.0.0 tag
GitHub Release v3.0.0
npm publication
floating v3 / v3.0 / latest aliases
new public CLI command
new FactRef source
new relation descriptor
new runtime constraint kind
release-specific policy DSL
```

До официального выпуска потребители используют полный 40-символьный `SHA`.

`package-lock.json` обязан совпадать с `package.json`, но никогда не определяет версию самостоятельно.

Любая ошибка чтения или неполный успешный ответ `GitHub API` запрещаются по умолчанию.

Каждый срез проходит отдельный цикл:

```text
fresh accepted main
-> test-only RED
-> minimal GREEN
-> full tests
-> Ready exact-head check-pr
-> expected-head merge
-> post-merge CI
```

Для управляющих путей используются только узкие санкции из #452 и #453. Ослабление политики не разрешено.

---

## 2. #452 — точный тег и существующий проверяющий механизм

### 2.1 Область

Изменить только:

```text
scripts/verify-release-ref.mjs
tests/test-release-ref.mjs
```

Существующий файл остаётся единственной строгой границей проверки выпуска.

Итоговые интерфейсы:

```js
expectedTagForVersion(version)

observeReleaseTruth({
  repo,
  tag,
  token,
  fetchImpl,
})

verifyReleaseRef({
  packageRoot,
  repo,
  tag,
  token,
  fetchImpl,
  run,
})
```

Новый модуль состояния выпуска не создаётся.

### 2.2 Красный тест

Создать ветку:

```text
c3/452-exact-release-truth
```

Она должна начинаться от свежего принятого `main`.

До production-кода изменить только `tests/test-release-ref.mjs`.

Добавить тестовые идентификаторы:

```js
const exactHead = "a".repeat(40);
const otherHead = "b".repeat(40);
const annotatedTagObject = "c".repeat(40);
const runAt = (sha) => () => sha;
```

Главный falsifier:

```js
it("rejects a matching tag name that resolves to another commit", async () => {
  const packageRoot = makePackageRoot("2.3.4");
  const result = await verifyReleaseRef({
    packageRoot,
    repo: "netkeep80/repo-guard",
    run: runAt(exactHead),
    fetchImpl: fakeFetch([
      [
        "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
        200,
        { object: { type: "commit", sha: otherHead } },
      ],
      [
        "/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
        200,
        {
          tag_name: "v2.3.4",
          draft: false,
          prerelease: false,
          html_url: "https://example.invalid/release",
        },
      ],
    ], []),
  });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => (
    check.name === "release-tag-resolves-to-checkout"
    && check.status === "FAIL"
  )));
});
```

Дополнительно покрыть:

```text
lightweight tag -> exact commit -> PASS
annotated tag -> tag object -> exact commit -> PASS
unknown tag object type -> FAIL
tag object cycle -> FAIL
malformed 200 release -> FAIL
release tag_name mismatch -> FAIL
draft release -> FAIL
prerelease release -> FAIL
GitHub API 500 -> FAIL
```

Запустить:

```bash
node --test tests/test-release-ref.mjs
```

До изменения production-кода результат обязан быть красным на новом контракте точного коммита.

При работе только через `GitHub` сначала зафиксировать коммит только с тестом в черновом PR с `Fixes #452`.

### 2.3 Минимальная реализация

В `scripts/verify-release-ref.mjs` добавить один локальный исполнитель:

```js
import { execFileSync } from "node:child_process";

function runProcess(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf-8",
    ...options,
  }).trim();
}
```

Использовать один валидатор 40-символьных идентификаторов объектов:

```js
function requireObjectSha(value, context) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${context} does not contain an exact object SHA`);
  }
  return value;
}
```

Разрешение тега выполняет один внутренний алгоритм:

```text
GET /git/ref/tags/<tag>
  -> 404: tag absent
  -> object.type == commit: return object.sha
  -> object.type == tag: GET /git/tags/<sha>
       -> repeat until commit
```

Обязательные защиты:

```text
unknown object type -> error
malformed object SHA -> error
cycle -> error
depth > 16 -> error
API error -> error
```

Добавить одну общую функцию наблюдения:

```js
export async function observeReleaseTruth({
  repo,
  tag,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  fetchImpl = globalThis.fetch,
} = {}) {
  // 1. resolve tag to exact commit
  // 2. observe matching GitHub Release
  // 3. validate tag_name/draft/prerelease/html_url
  // 4. return normalized facts
}
```

Нормализованный результат:

```js
{
  tag,
  tag_exists,
  tag_commit,
  release_exists,
  published,
  draft,
  prerelease,
  release_url,
}
```

Семантика отсутствия:

```text
no tag
  -> tag_exists=false
  -> tag_commit=null
  -> release_exists=false
  -> published=false

exact tag, no release
  -> tag_exists=true
  -> tag_commit=<exact SHA>
  -> release_exists=false
  -> published=false
```

Черновой или предварительный выпуск существует, но не считается официально опубликованным.

Неполный ответ `200 OK` не считается отсутствием — это ошибка наблюдения.

`verifyReleaseRef` получает точный checkout через:

```js
const checkoutSha = requireObjectSha(
  run("git", ["rev-parse", "HEAD"], { cwd: packageRoot }),
  "Current checkout",
);
```

Строгая проверка использует `observeReleaseTruth`, но превращает ошибку наблюдения в структурированный `FAIL`:

```js
let truth;
try {
  truth = await observeReleaseTruth({
    repo,
    tag: expectedTag,
    token,
    fetchImpl,
  });
} catch (error) {
  checks.push(fail("release-observation", error.message));
  return { ok: false, packageVersion, expectedTag, repo, checks };
}
```

Затем требуется:

```text
supplied tag == v<package version>
tag exists
tag_commit == current checkout SHA
release exists
release.tag_name == expected tag
release.draft == false
release.prerelease == false
```

Обсерватория позже вызывает `observeReleaseTruth` напрямую. Поэтому ошибка наблюдения там прекращает сборку вместо публикации ложного состояния.

### 2.4 Проверка #452

Выполнить:

```bash
node --test tests/test-release-ref.mjs
npm test
npm run check:dist
```

Финальный PR:

```text
Fixes #452
change_type = governance
changed files = exactly 2
```

Он не должен касаться:

```text
package.json
package-lock.json
repo-policy.json
src/**
dist/**
schemas/**
.github/**
```

После зелёного чернового запуска получить зелёный `Run PR policy check` на той же голове, слить с `expected_head_sha` и дождаться зелёного послемержевого `CI`.

---

## 3. #453 — переход версии на `3.0.0`

### 3.1 Область

Изменить только:

```text
package.json
package-lock.json
tests/test-c3-7-version-truth.mjs
```

Начинать только после принятия #452.

### 3.2 Красный тест

Создать `tests/test-c3-7-version-truth.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
```

На принятой базе тест обязан упасть, потому что версия ещё `2.0.0`.

Сначала зафиксировать только этот тест в черновом PR с `Fixes #453`.

### 3.3 Минимальное исправление

В `package.json` изменить только:

```json
"version": "3.0.0"
```

В `package-lock.json` изменить только:

```text
/version = 3.0.0
/packages/""/version = 3.0.0
```

Не менять зависимости и не создавать тег.

Выполнить:

```bash
node tests/test-c3-7-version-truth.mjs
node tests/test-init.mjs
npm test
npm run check:dist
```

`tests/test-init.mjs` уже читает версию пакета динамически. Если он падает, локализовать расхождение; совместимый псевдоним не добавлять.

До готовности PR и после слияния проверить внешние факты:

```text
GET /repos/netkeep80/repo-guard/git/ref/tags/v3.0.0 -> 404
GET /repos/netkeep80/repo-guard/releases/tags/v3.0.0 -> 404
```

Если любой объект существует, остановить #453 и зафиксировать неожиданную историю выпуска.

### 3.4 Проверка #453

Финальный PR:

```text
Fixes #453
change_type = governance
changed files = exactly 3
```

Используется только санкция #453 на `package.json` и `package-lock.json` с атомарным смешанным срезом.

После зелёного чернового запуска получить зелёный Ready-запуск на той же голове, слить с `expected_head_sha`, дождаться зелёного послемержевого `CI`.

Затем дождаться автоматической публикации Обсерватории на том же `SHA` и проверить:

```text
package_version = 3.0.0
matching_release_tag = v3.0.0
matching_published_release = false
release_truth_status = package_only
```

---

## 4. #454 — единое наблюдение и финальная приёмка

### 4.1 Возможная область

```text
scripts/observatory/collect.mjs
scripts/observatory/render.mjs
tests/test-c3-6-observatory-snapshot.mjs
tests/test-c3-6-observatory-render.mjs
tests/test-c3-7-release-workflow.mjs
README.md
RELEASING.md
```

`.github/workflows/release-integrity.yml` только читается.

Начинать только после принятия #453.

Перед записью снова проверить отсутствие реального тега `v3.0.0` и выпуска.

### 4.2 Красный контракт снимка

Сначала изменить только тест снимка.

Для текущего состояния требовать:

```js
assert.equal(first.version.package_version, "3.0.0");
assert.equal(first.version.matching_release_tag, "v3.0.0");
assert.equal(first.version.matching_published_release, false);
assert.equal(first.version.release_commit, null);
assert.equal(first.version.release_truth_status, "package_only");
```

Добавить синтетическое опубликованное состояние с точным коммитом:

```js
const releaseCommit = "d".repeat(40);

assert.equal(published.version.matching_published_release, true);
assert.equal(published.version.release_commit, releaseCommit);
assert.equal(published.version.release_truth_status, "published");
```

Добавить предварительный выпуск и потребовать:

```text
matching_published_release = false
release_commit = null
```

До изменения сборщика тест обязан быть красным на отсутствии `release_commit` и разрешения тега.

### 4.3 Удалить дублирование в сборщике

В `scripts/observatory/collect.mjs` импортировать:

```js
import { observeReleaseTruth } from "../verify-release-ref.mjs";
```

Удалить локальные:

```text
validateReleasePayload
observeMatchingRelease
```

Использовать только:

```js
const release = await observeReleaseTruth({
  repo: repository,
  tag: matchingReleaseTag,
  token,
  fetchImpl,
});
```

Секция версии:

```js
version: {
  package_version: String(packageJson.version),
  matching_release_tag: matchingReleaseTag,
  matching_published_release: release.published,
  release_commit: release.published ? release.tag_commit : null,
  release_url: release.published ? release.release_url : null,
  release_truth_status: release.published ? "published" : "package_only",
  provenance: {
    origin: "github_observation",
    source: `releases/tags/${matchingReleaseTag}`,
    sha: acceptedSha,
  },
},
```

В `sources` добавить:

```text
scripts/verify-release-ref.mjs
```

Ошибка `observeReleaseTruth` прекращает сборку страниц. Она не превращается в `package_only`.

### 4.4 Показать точный коммит выпуска

В валидаторе снимка `release_commit` допускает только:

```text
null
OR exact 40-char SHA
```

Состояние `published` требует ненулевой `release_commit`.

В карточку «Версия и выпуск» добавить одну строку:

```text
Коммит выпуска: <immutable commit link | отсутствует до официального выпуска>
```

В тесте отрисовки доказать:

```text
package_only + null -> PASS
published + exact SHA -> PASS and immutable commit URL
published + null -> validation failure
```

Новой страницы и клиентского запроса к `GitHub API` нет.

### 4.5 Доказать существующий процесс выпуска без его изменения

Создать `tests/test-c3-7-release-workflow.mjs`.

Он разбирает `.github/workflows/release-integrity.yml` существующим `yaml` и требует:

```text
workflow permissions = contents: read only
no job permission override
checkout = actions/checkout@v6
checkout ref = release tag expression
fetch-depth = 0
same scripts/verify-release-ref.mjs is called with --tag
no npm publish
no gh release create
no git push
```

Этот тест ожидается зелёным без изменения рабочего процесса.

Если он красный, остановить #454 и зафиксировать точное расхождение управляющего контура. Не расширять область молча.

### 4.6 Синхронизировать документацию

В `RELEASING.md` удалить старую финальную последовательность с `npm version`.

Официальный выпуск после C3.10 должен быть описан одной цепочкой:

```text
package.json.version already accepted
-> C3.10 accepts exact SHA S
-> no code/version/docs edits
-> tag v3.0.0 -> S
-> published non-prerelease GitHub Release v3.0.0
-> release-integrity verifies same tag and commit
-> npm publish may follow
```

Сохранить обычное семантическое версионирование для будущих границ версии.

Не утверждать, что `v3.0.0` уже выпущен.

README менять только если после проверки нужна одна короткая фраза:

```text
Номер в package.json сам по себе не означает опубликованный выпуск; до официального тега и выпуска используйте полный SHA.
```

Если текущий README уже однозначен, не менять его ради галочки.

### 4.7 Финальная проверка #454 и C3.7

Выполнить:

```bash
node tests/test-release-ref.mjs
node tests/test-c3-7-version-truth.mjs
node tests/test-c3-6-observatory-snapshot.mjs
node tests/test-c3-6-observatory-render.mjs
node tests/test-c3-7-release-workflow.mjs
npm test
npm run check:dist
npm run compression:metrics
```

Архитектурные инварианты должны остаться:

```text
FactRef models = 1
FactRef sources = 4
runtime constraint kinds = 1
relation descriptors = 10
primitive descriptor registries = 1
public CLI = validate, check-diff, check-pr, init, doctor
```

Финальный PR использует `Fixes #454`.

При зелёном структурном тесте `.github/workflows/release-integrity.yml` не входит в diff.

После зелёного чернового запуска получить зелёный Ready-запуск на той же голове, слить с `expected_head_sha` и дождаться зелёного послемержевого `CI`.

Затем дождаться автоматической публикации `Policy Observatory Pages` на том же `SHA` после слияния.

Живой артефакт обязан показывать:

```text
package_version = 3.0.0
matching_release_tag = v3.0.0
matching_published_release = false
release_commit = null
release_truth_status = package_only
accepted SHA = exact final C3.7 main SHA
```

Последний раз проверить:

```text
GET /git/ref/tags/v3.0.0 -> 404
GET /releases/tags/v3.0.0 -> 404
```

Только после одновременного выполнения:

```text
#452 = completed
#453 = completed
#454 = completed
post-merge CI = GREEN
Pages deploy = GREEN on same SHA
v3.0.0 tag = absent
v3.0.0 GitHub Release = absent
```

добавить сводный audit в #378 и закрыть #378 как `completed`.

При закрытии #378 не создавать `v3.0.0`. Следующий этап — C3.8; официальный выпуск остаётся после C3.10.

---

## 5. Итоговая форма

```text
#452
existing verifier
+ exact lightweight/annotated tag -> commit
+ current HEAD equality
+ fail-closed published release
        ↓
#453
package.json = 3.0.0
+ package-lock derived mirror
+ no release
        ↓
#454
same observation in Observatory
+ exact published release commit
+ existing read-only release workflow proven
+ release docs converged
+ live Pages acceptance
        ↓
#378 completed
```

Новых постоянных сущностей нет. Единственное новое переиспользуемое поведение — `observeReleaseTruth` внутри уже существующего файла проверяющего механизма. Строгая проверка и проекция только для чтения используют одну и ту же вычисляемую истину.