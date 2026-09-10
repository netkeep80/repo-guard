# C3.7 — План реализации единой версии и истины выпуска

> **Для агентных исполнителей:** обязательно использовать `superpowers:subagent-driven-development` либо `superpowers:executing-plans` и выполнять задачи строго последовательно. Каждый поведенческий срез начинается с наблюдаемого отрицательного теста и заканчивается собственной приёмкой.

**Цель:** сделать `3.0.0` единственной канонической версией продукта и доказуемо выводить состояние выпуска из неизменяемого тега, точного коммита и опубликованного выпуска `GitHub`, не создавая отдельную подсистему состояния выпуска.

**Архитектура:** существующий `scripts/verify-release-ref.mjs` остаётся единственной строгой границей проверки выпуска и получает точное разрешение лёгких и аннотированных тегов до коммита. `package.json.version` остаётся единственным хранимым источником версии, `package-lock.json` — только производным зеркалом. Обсерватория повторно использует ту же функцию наблюдения и ничего не публикует сама.

**Стек:** `Node.js` 24 в `CI`, встроенный `node:test`, `Git`, `GitHub REST API`, существующий `yaml`, статический `GitHub Pages`.

**Спецификация:** `docs/superpowers/specs/2026-09-10-c3-7-release-truth-design.md`

## Глобальные ограничения

- Принятая база плана: `aee40dac928bf6ce20b7296a21d3525933f7ad4d`.
- Родитель: #378; дорожная карта: #370.
- Порядок исполнения: #452 → #453 → #454.
- `package.json.version` — единственный канонический источник версии.
- `package-lock.json` не становится источником версии и обязан только совпадать как производное зеркало.
- В C3.7 каноническая версия становится `3.0.0`.
- C3.7 не создаёт реальный тег `v3.0.0`, выпуск `GitHub` или публикацию `npm`.
- Реальный выпуск остаётся после финальной приёмки C3.10.
- До реального выпуска потребитель использует полный 40-символьный `SHA`.
- Не создавать `VERSION`, `release-state.json`, `target-version.json` и другие параллельные источники.
- Не создавать новый публичный `CLI` для выпуска.
- Не добавлять новый `FactRef`, дескриптор отношения, вид исполняемого ограничения или язык политики.
- Не менять C3.8, C3.9 и C3.10 в рамках этой работы.
- Не менять `.github/workflows/release-integrity.yml`, если отдельный структурный тест не докажет расхождение с принятой спецификацией.
- Любая ошибка чтения или неполный успешный ответ `GitHub API` в строгой проверке завершается запретом по умолчанию.
- Каждый `PR` проходит `DRAFT` → наблюдаемый отрицательный тест → минимальное исправление → полный зелёный набор → `Ready` → точный `check-pr` → слияние с `expected_head_sha` → послемержевый `CI`.
- Для управляющих путей использовать только узкие санкции из #452 и #453; ослабление политики не разрешено.
- Не запускать #453 до принятия #452 и не запускать #454 до принятия #453.

---

### Задача 1: #452 — точная истина `tag -> commit` в существующем проверяющем механизме

**Файлы:**
- Изменить: `scripts/verify-release-ref.mjs`
- Изменить: `tests/test-release-ref.mjs`

**Интерфейсы:**
- Потребляет: `package.json.version`, текущий `HEAD`, `GitHub REST API`.
- Сохраняет: `expectedTagForVersion(version)` и `verifyReleaseRef(options)`.
- Добавляет в тот же файл один переиспользуемый read-only интерфейс:

```js
export async function observeReleaseTruth({
  repo,
  tag,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  fetchImpl = globalThis.fetch,
} = {})
```

- `observeReleaseTruth` возвращает нормализованные факты:

```js
{
  tag,
  tag_exists,
  tag_commit,
  release_exists,
  published,
  draft,
  prerelease,
  release_url
}
```

- Отсутствующий начальный тег даёт `tag_exists: false`, `tag_commit: null`, `published: false`.
- Существующий тег без выпуска даёт точный `tag_commit`, но `published: false`.
- Черновой или предварительный выпуск существует, но не считается официально опубликованным.
- Неполный ответ `200`, неизвестный тип объекта, цикл тега и ошибка API являются ошибкой наблюдения, а не обычным отсутствием.
- `verifyReleaseRef` использует тот же `observeReleaseTruth` и дополнительно требует совпадения `tag_commit` с текущим `HEAD`.

- [ ] **Шаг 1: создать ветку только от свежего принятого `main`**

```bash
git fetch origin main
git switch --detach <fresh-main-sha>
git switch -c c3/452-exact-release-truth
```

Перед записью проверить, что `<fresh-main-sha>` совпадает с текущим `origin/main` и что #452 остаётся открытой с узким `GovernanceGrant` на `scripts/verify-release-ref.mjs`.

- [ ] **Шаг 2: переписать успешный тест так, чтобы он требовал точный лёгкий тег и точный `HEAD`**

В `tests/test-release-ref.mjs` добавить стабильные тестовые идентификаторы:

```js
const exactHead = "a".repeat(40);
const otherHead = "b".repeat(40);
const annotatedTagObject = "c".repeat(40);
const runAt = (sha) => () => sha;
```

Успешный случай должен передавать полный ответ ссылки тега и полный ответ выпуска:

```js
const result = await verifyReleaseRef({
  packageRoot,
  repo: "netkeep80/repo-guard",
  run: runAt(exactHead),
  fetchImpl: fakeFetch([
    [
      "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
      200,
      { object: { type: "commit", sha: exactHead } },
    ],
    [
      "/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
      200,
      {
        tag_name: "v2.3.4",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/netkeep80/repo-guard/releases/tag/v2.3.4",
      },
    ],
  ], calls),
});

assert.equal(result.ok, true);
```

Старый код должен перестать удовлетворять этому контракту после добавления следующих отрицательных случаев.

- [ ] **Шаг 3: добавить главный отрицательный тест неправильного коммита**

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
          html_url: "https://github.com/netkeep80/repo-guard/releases/tag/v2.3.4",
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

- [ ] **Шаг 4: добавить отрицательный/положительный контракт аннотированного тега**

```js
it("resolves an annotated tag object to the exact checkout commit", async () => {
  const packageRoot = makePackageRoot("2.3.4");
  const calls = [];
  const result = await verifyReleaseRef({
    packageRoot,
    repo: "netkeep80/repo-guard",
    run: runAt(exactHead),
    fetchImpl: fakeFetch([
      [
        "/repos/netkeep80/repo-guard/git/ref/tags/v2.3.4",
        200,
        { object: { type: "tag", sha: annotatedTagObject } },
      ],
      [
        `/repos/netkeep80/repo-guard/git/tags/${annotatedTagObject}`,
        200,
        { object: { type: "commit", sha: exactHead } },
      ],
      [
        "/repos/netkeep80/repo-guard/releases/tags/v2.3.4",
        200,
        {
          tag_name: "v2.3.4",
          draft: false,
          prerelease: false,
          html_url: "https://github.com/netkeep80/repo-guard/releases/tag/v2.3.4",
        },
      ],
    ], calls),
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((url) => url.endsWith(`/git/tags/${annotatedTagObject}`)));
});
```

Также добавить отдельный случай неизвестного типа или циклического `tag`-объекта и потребовать `FAIL`/ошибку наблюдения.

- [ ] **Шаг 5: добавить случаи строгой проверки выпуска**

Минимальный набор:

```js
for (const release of [
  {},
  {
    tag_name: "v9.9.9",
    draft: false,
    prerelease: false,
    html_url: "https://example.invalid/release",
  },
  {
    tag_name: "v2.3.4",
    draft: true,
    prerelease: false,
    html_url: "https://example.invalid/release",
  },
  {
    tag_name: "v2.3.4",
    draft: false,
    prerelease: true,
    html_url: "https://example.invalid/release",
  },
]) {
  // При точном теге и HEAD verifyReleaseRef обязан вернуть ok=false.
}
```

Добавить отдельный ответ `500` и доказать, что ошибка API не превращается в обычное отсутствие выпуска.

- [ ] **Шаг 6: зафиксировать наблюдаемый отрицательный результат до изменения production-кода**

```bash
node --test tests/test-release-ref.mjs
```

Ожидаемый результат: новый тест неправильного коммита не получает требуемый `FAIL` либо новый контракт ответа тега не поддерживается существующим кодом.

В GitHub-only исполнении: сначала закоммитить только изменения теста, открыть `DRAFT PR` с `Fixes #452` и получить тот же красный результат в `CI` на точной голове.

- [ ] **Шаг 7: добавить единственный общий механизм разрешения тега в существующий файл**

В `scripts/verify-release-ref.mjs` добавить импорт:

```js
import { execFileSync } from "node:child_process";
```

И локальный исполнитель:

```js
function runProcess(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf-8",
    ...options,
  }).trim();
}
```

Проверка формы `SHA`:

```js
function requireCommitSha(value, context) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${context} does not contain an exact commit SHA`);
  }
  return value;
}
```

Разрешение тега должно оставаться в этом же файле:

```js
async function resolveTagCommit({ repo, tag, token, fetchImpl }) {
  const encodedTag = encodeURIComponent(tag);
  const ref = await githubGet(`/git/ref/tags/${encodedTag}`, {
    repo,
    token,
    fetchImpl,
  });

  if (!ref.ok && ref.status === 404) {
    return { exists: false, commit: null };
  }
  if (!ref.ok) {
    throw new Error(`Git tag ${tag} lookup failed: ${ref.message}`);
  }

  let object = ref.body?.object;
  const seen = new Set();

  for (let depth = 0; depth < 16; depth += 1) {
    const type = object?.type;
    const sha = requireCommitSha(object?.sha, `Git object for ${tag}`);

    if (type === "commit") {
      return { exists: true, commit: sha };
    }
    if (type !== "tag") {
      throw new Error(`Git tag ${tag} resolved to unsupported object type ${type}`);
    }
    if (seen.has(sha)) {
      throw new Error(`Git tag ${tag} contains a cycle`);
    }
    seen.add(sha);

    const tagObject = await githubGet(`/git/tags/${sha}`, {
      repo,
      token,
      fetchImpl,
    });
    if (!tagObject.ok) {
      throw new Error(`Git tag object ${sha} lookup failed: ${tagObject.message}`);
    }
    object = tagObject.body?.object;
  }

  throw new Error(`Git tag ${tag} exceeds the resolution depth limit`);
}
```

Если при реализации проверка `sha` нужна также для объекта `tag`, не вводить второй валидатор: использовать тот же `requireCommitSha`, потому что оба идентификатора имеют ту же 40-символьную форму.

- [ ] **Шаг 8: добавить общую read-only функцию наблюдения**

```js
export async function observeReleaseTruth({
  repo,
  tag,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation is available");
  }
  if (typeof repo !== "string" || !repo.includes("/")) {
    throw new Error("Repository must use owner/name form");
  }
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error("Release tag must use vX.Y.Z form");
  }

  const resolved = await resolveTagCommit({ repo, tag, token, fetchImpl });
  if (!resolved.exists) {
    return {
      tag,
      tag_exists: false,
      tag_commit: null,
      release_exists: false,
      published: false,
      draft: null,
      prerelease: null,
      release_url: null,
    };
  }

  const release = await githubGet(`/releases/tags/${encodeURIComponent(tag)}`, {
    repo,
    token,
    fetchImpl,
  });
  if (!release.ok && release.status === 404) {
    return {
      tag,
      tag_exists: true,
      tag_commit: resolved.commit,
      release_exists: false,
      published: false,
      draft: null,
      prerelease: null,
      release_url: null,
    };
  }
  if (!release.ok) {
    throw new Error(`GitHub release ${tag} lookup failed: ${release.message}`);
  }

  const body = release.body;
  if (
    body?.tag_name !== tag
    || typeof body?.draft !== "boolean"
    || typeof body?.prerelease !== "boolean"
    || typeof body?.html_url !== "string"
    || !body.html_url
  ) {
    throw new Error(`GitHub release ${tag} observation is malformed`);
  }

  return {
    tag,
    tag_exists: true,
    tag_commit: resolved.commit,
    release_exists: true,
    published: body.draft === false && body.prerelease === false,
    draft: body.draft,
    prerelease: body.prerelease,
    release_url: body.html_url,
  };
}
```

Не создавать `scripts/release-truth.mjs`: этот интерфейс живёт рядом с единственным строгим verifier и позже переиспользуется обсерваторией.

- [ ] **Шаг 9: усилить `verifyReleaseRef` через общую функцию, не создавая вторую семантику**

Расширить параметры:

```js
export async function verifyReleaseRef({
  packageRoot = defaultPackageRoot,
  repo = DEFAULT_REPO,
  tag = null,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  fetchImpl = globalThis.fetch,
  run = runProcess,
} = {})
```

После проверки `suppliedTag === expectedTag` получить точный `HEAD`:

```js
let checkoutSha;
try {
  checkoutSha = requireCommitSha(
    run("git", ["rev-parse", "HEAD"], { cwd: packageRoot }),
    "Current checkout",
  );
  checks.push(pass("checkout-sha", `Current checkout is ${checkoutSha}`));
} catch (error) {
  checks.push(fail("checkout-sha", error.message));
  return { ok: false, packageVersion, expectedTag, repo, checks };
}
```

Затем вызвать `observeReleaseTruth`. Если тег отсутствует, сохранить существующую диагностическую идентичность `published-git-tag = FAIL`. Если тег существует, добавить:

```js
if (truth.tag_commit !== checkoutSha) {
  checks.push(fail(
    "release-tag-resolves-to-checkout",
    `Git tag ${expectedTag} resolves to ${truth.tag_commit}, not ${checkoutSha}`,
  ));
} else {
  checks.push(pass(
    "release-tag-resolves-to-checkout",
    `${expectedTag} resolves to the current checkout`,
  ));
}
```

Для выпуска требовать одновременно:

```js
truth.release_exists === true
truth.draft === false
truth.prerelease === false
truth.published === true
```

Результат `ok` вычислять только из `checks`, как и сейчас.

- [ ] **Шаг 10: прогнать узкий тест и полный набор**

```bash
node --test tests/test-release-ref.mjs
npm test
npm run check:dist
```

Ожидаемо: всё зелёное; `src/**` и `dist/**` не изменены.

- [ ] **Шаг 11: провести self-dogfooding приёмку #452**

`DRAFT PR` должен содержать `Fixes #452` и только:

```text
scripts/verify-release-ref.mjs
tests/test-release-ref.mjs
```

`ChangeIntent`:

```repo-guard-yaml
change_type: governance
scope:
  - scripts/verify-release-ref.mjs
  - tests/test-release-ref.mjs
budgets:
  max_new_files: 0
  max_new_docs: 0
  max_net_added_lines: 350
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - scripts/verify-release-ref.mjs
  - tests/test-release-ref.mjs
must_not_touch:
  - package.json
  - package-lock.json
  - repo-policy.json
  - src/**
  - dist/**
  - schemas/**
  - .github/**
expected_effects:
  - существующий verifier доказывает точный commit тега
  - аннотированные теги разрешаются до commit
  - ошибочные ответы выпуска запрещаются по умолчанию
```

После зелёного draft-run перевести PR в `Ready`, получить на той же голове зелёные `validate`, `smoke-pack`, `Run PR policy check`, затем слить только с точным `expected_head_sha` и дождаться зелёного послемержевого `CI`.

---

### Задача 2: #453 — каноническая версия `3.0.0` без публикации выпуска

**Файлы:**
- Создать: `tests/test-c3-7-version-truth.mjs`
- Изменить: `package.json`
- Изменить: `package-lock.json`

**Интерфейсы:**
- Потребляет: усиленный `expectedTagForVersion` из принятой #452.
- Производит: единственную каноническую версию `3.0.0`.
- Не производит: `Git tag`, `GitHub Release`, отдельный файл состояния.

- [ ] **Шаг 1: начать только от послемержевого зелёного состояния #452**

```bash
git fetch origin main
git switch --detach <accepted-c3-7a-main-sha>
git switch -c c3/453-version-3-cutover
```

Перед записью проверить, что #452 закрыта как завершённая и #453 открыта с санкцией ровно на `package.json` и `package-lock.json`.

- [ ] **Шаг 2: сначала добавить отрицательный тест версии**

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

console.log("C3.7 canonical version truth passed");
```

- [ ] **Шаг 3: доказать отрицательное состояние до изменения версии**

```bash
node tests/test-c3-7-version-truth.mjs
```

Ожидаемо: падение на `packageJson.version`, потому что принятая база ещё содержит `2.0.0`.

В GitHub-only исполнении закоммитить только тест, открыть `DRAFT PR` с `Fixes #453` и получить тот же красный результат в `CI`.

- [ ] **Шаг 4: изменить только каноническую версию и её производное зеркало**

`package.json`:

```json
{
  "name": "repo-guard",
  "version": "3.0.0"
}
```

Сохранить все остальные поля файла неизменными.

В `package-lock.json` изменить только корневые зеркала:

```json
{
  "name": "repo-guard",
  "version": "3.0.0",
  "packages": {
    "": {
      "name": "repo-guard",
      "version": "3.0.0"
    }
  }
}
```

Не менять версии зависимостей и не создавать тег.

- [ ] **Шаг 5: проверить локальный контракт и существующий `init`**

```bash
node tests/test-c3-7-version-truth.mjs
node tests/test-init.mjs
npm test
npm run check:dist
```

`tests/test-init.mjs` уже читает `package.json.version` динамически, поэтому отдельная реализация `init` не ожидается. Если он падает после честного version cutover, остановить задачу и локализовать расхождение; не добавлять совместимый alias.

- [ ] **Шаг 6: проверить внешнее отсутствие официального выпуска**

До и после слияния проверить через GitHub:

```text
GET /repos/netkeep80/repo-guard/git/ref/tags/v3.0.0 -> 404
GET /repos/netkeep80/repo-guard/releases/tags/v3.0.0 -> 404
```

Если любой объект уже существует, не продолжать C3.7 как обычный cutover: зафиксировать неожиданную внешнюю историю в #453 и пересмотреть release candidate boundary.

- [ ] **Шаг 7: провести self-dogfooding приёмку #453**

Финальный PR содержит только:

```text
package.json
package-lock.json
tests/test-c3-7-version-truth.mjs
```

`ChangeIntent`:

```repo-guard-yaml
change_type: governance
scope:
  - package.json
  - package-lock.json
  - tests/test-c3-7-version-truth.mjs
budgets:
  max_new_files: 1
  max_new_docs: 0
  max_net_added_lines: 80
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - package.json
  - package-lock.json
  - tests/test-c3-7-version-truth.mjs
must_not_touch:
  - repo-policy.json
  - src/**
  - dist/**
  - schemas/**
  - scripts/**
  - .github/**
  - README.md
  - RELEASING.md
expected_effects:
  - каноническая версия становится 3.0.0
  - package-lock остаётся производным совпадающим зеркалом
  - официальный v3.0.0 всё ещё отсутствует
```

После draft GREEN перевести в `Ready`, получить реальный `check-pr` на той же голове, слить с `expected_head_sha`, дождаться послемержевого `CI`.

- [ ] **Шаг 8: проверить автоматическую промежуточную публикацию Observatory**

После зелёного послемержевого `CI` дождаться автоматического `Policy Observatory Pages` для того же `SHA` и проверить:

```text
Версия пакета: 3.0.0
Совпадающий тег: v3.0.0
Выпуск: не опубликован
Статус истины: package_only
```

Это промежуточное доказательство version cutover. Оно не заменяет финальный C3.7 Pages-срез #454.

---

### Задача 3: #454 — единое наблюдение выпуска, документация и финальная приёмка C3.7

**Файлы:**
- Изменить: `scripts/observatory/collect.mjs`
- Изменить: `scripts/observatory/render.mjs`
- Изменить: `tests/test-c3-6-observatory-snapshot.mjs`
- Изменить: `tests/test-c3-6-observatory-render.mjs`
- Создать: `tests/test-c3-7-release-workflow.mjs`
- Изменить: `README.md` только если нужна одна краткая публичная формулировка
- Изменить: `RELEASING.md`
- Только читать: `.github/workflows/release-integrity.yml`

**Интерфейсы:**
- Потребляет: принятый `observeReleaseTruth` из #452 и `package.json.version = 3.0.0` из #453.
- Сохраняет текущие поля внутреннего снимка:

```text
package_version
matching_release_tag
matching_published_release
release_url
release_truth_status
```

- Добавляет ровно одно производное поле для опубликованного состояния:

```text
release_commit
```

- `release_commit` равен `null`, пока официального опубликованного выпуска нет.
- При официальном опубликованном выпуске `release_commit` равен точному коммиту, до которого разрешился тот же тег.
- Не добавлять `matching_tag_commit`, отдельный status-файл или вторую модель состояния, если это не требуется для отображения официального выпуска.

- [ ] **Шаг 1: начать только от послемержевого зелёного состояния #453**

```bash
git fetch origin main
git switch --detach <accepted-c3-7b-main-sha>
git switch -c c3/454-release-truth-convergence
```

До записи снова проверить отсутствие реального `v3.0.0` tag/release.

- [ ] **Шаг 2: сначала изменить snapshot-тест так, чтобы он требовал общий tag-aware observation**

В `tests/test-c3-6-observatory-snapshot.mjs` заменить одноответный `release404` на маршрутизатор, который способен различить тег и выпуск:

```js
const absentReleaseTruth = async (url) => {
  if (
    url.endsWith("/git/ref/tags/v3.0.0")
    || url.endsWith("/releases/tags/v3.0.0")
  ) {
    return {
      status: 404,
      async json() { return { message: "not found" }; },
    };
  }
  throw new Error(`unexpected URL: ${url}`);
};
```

Для текущего состояния потребовать:

```js
assert.equal(first.version.package_version, "3.0.0");
assert.equal(first.version.matching_release_tag, "v3.0.0");
assert.equal(first.version.matching_published_release, false);
assert.equal(first.version.release_commit, null);
assert.equal(first.version.release_truth_status, "package_only");
```

Добавить синтетический опубликованный случай с точным лёгким тегом:

```js
const releaseCommit = "d".repeat(40);
const published = await collectObservatorySnapshot({
  ...input,
  fetchImpl: async (url) => {
    if (url.endsWith("/git/ref/tags/v3.0.0")) {
      return {
        status: 200,
        async json() {
          return { object: { type: "commit", sha: releaseCommit } };
        },
      };
    }
    if (url.endsWith("/releases/tags/v3.0.0")) {
      return {
        status: 200,
        async json() {
          return {
            tag_name: "v3.0.0",
            draft: false,
            prerelease: false,
            html_url: "https://github.com/netkeep80/repo-guard/releases/tag/v3.0.0",
          };
        },
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  },
});

assert.equal(published.version.matching_published_release, true);
assert.equal(published.version.release_commit, releaseCommit);
assert.equal(published.version.release_truth_status, "published");
```

Добавить preliminary-release вариант и потребовать `matching_published_release === false` и `release_commit === null`.

- [ ] **Шаг 3: получить отрицательный результат до изменения collector**

```bash
node tests/test-c3-6-observatory-snapshot.mjs
```

Ожидаемо: текущий collector не вызывает tag-resolution helper и не предоставляет `release_commit`.

В GitHub-only исполнении зафиксировать только тестовый commit в `DRAFT PR`, связанный с #454 через `Refs #454`, но пока не закрывать задачу.

- [ ] **Шаг 4: удалить локальную release-семантику collector и переиспользовать #452**

В `scripts/observatory/collect.mjs` импортировать:

```js
import { observeReleaseTruth } from "../verify-release-ref.mjs";
```

Удалить локальные функции:

```text
validateReleasePayload
observeMatchingRelease
```

Заменить вызов на:

```js
const release = await observeReleaseTruth({
  repo: repository,
  tag: matchingReleaseTag,
  token,
  fetchImpl,
});
```

Секция `version` становится:

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

В `sources` добавить существующий общий механизм:

```text
scripts/verify-release-ref.mjs
```

Не создавать новую библиотеку или второй HTTP-клиент.

- [ ] **Шаг 5: обновить renderer-контракт до одного необязательного exact commit**

В `validateObservatorySnapshot` добавить:

```js
const releaseCommit = snapshot.version.release_commit;
if (
  releaseCommit !== null
  && !/^[0-9a-f]{40}$/.test(releaseCommit ?? "")
) {
  throw new Error("invalid release commit SHA");
}
if (
  snapshot.version.release_truth_status === "published"
  && releaseCommit === null
) {
  throw new Error("published release requires exact release commit");
}
```

В карточке версии добавить только одну строку:

```js
const releaseCommitTruth = snapshot.version.release_commit
  ? `<a href="https://github.com/${escapeHtml(snapshot.repository.full_name)}/commit/${escapeHtml(snapshot.version.release_commit)}"><code>${escapeHtml(snapshot.version.release_commit)}</code></a>`
  : "отсутствует до официального выпуска";
```

И вывести:

```html
<p>Коммит выпуска: ${releaseCommitTruth}</p>
```

Не создавать отдельную страницу выпуска и не добавлять клиентский запрос `GitHub API`.

- [ ] **Шаг 6: обновить renderer-тест**

В `tests/test-c3-6-observatory-render.mjs` для `package_only` проверить текст отсутствия exact release commit.

Для синтетического опубликованного снимка:

```js
const releaseCommit = "d".repeat(40);
const publishedSnapshot = {
  ...snapshot,
  version: {
    ...snapshot.version,
    matching_published_release: true,
    release_truth_status: "published",
    release_commit: releaseCommit,
    release_url: "https://github.com/netkeep80/repo-guard/releases/tag/v3.0.0",
  },
};

const publishedHtml = renderObservatory(publishedSnapshot);
assert.ok(publishedHtml.includes(releaseCommit));
assert.ok(publishedHtml.includes(`/commit/${releaseCommit}`));
```

Также проверить, что `published` с `release_commit: null` отвергается валидатором снимка.

- [ ] **Шаг 7: добавить структурный тест уже существующего release-workflow**

Создать `tests/test-c3-7-release-workflow.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const path = resolve(".github/workflows/release-integrity.yml");
const document = parseDocument(readFileSync(path, "utf8"));
assert.equal(document.errors.length, 0);
const workflow = document.toJS();

assert.equal(workflow.permissions?.contents, "read");
assert.equal(Object.keys(workflow.permissions ?? {}).length, 1);

const job = workflow.jobs?.["verify-release-ref"];
assert.ok(job);
const steps = job.steps ?? [];

const checkout = steps.find((step) => step.uses === "actions/checkout@v6");
assert.equal(
  checkout?.with?.ref,
  "${{ github.event.release.tag_name || inputs.tag }}",
);
assert.equal(checkout?.with?.["fetch-depth"], 0);

const verify = steps.find((step) => (
  typeof step.run === "string"
  && step.run.includes("scripts/verify-release-ref.mjs")
));
assert.ok(verify);
assert.match(verify.run, /--tag/);

const serialized = JSON.stringify(workflow);
assert.doesNotMatch(serialized, /contents\s*:\s*write/i);
assert.doesNotMatch(serialized, /npm publish/);
```

Этот тест должен сразу проходить на принятом workflow. Если он падает, не менять workflow автоматически: остановить #454 и зафиксировать точное расхождение, потому что это уже новая governance-транзакция.

- [ ] **Шаг 8: синхронизировать `RELEASING.md` с принятой моделью**

Удалить старую часть последовательности, где официальный выпуск сам выбирает уровень и выполняет:

```bash
npm version patch
npm version minor
npm version major
```

Новая минимальная последовательность должна говорить по-русски:

```text
1. Версия продукта уже принята обычным PR и хранится в package.json.
2. Финальная C3.10-приёмка фиксирует точный SHA S.
3. После приёмки между S и тегом не меняются код, версия или документы.
4. Создаётся неизменяемый тег v3.0.0, указывающий ровно на S.
5. Публикуется обычный, не предварительный GitHub Release для того же тега.
6. release-integrity проверяет tag -> S и выпуск.
7. Только затем допустим npm publish.
```

Сохранить общую таблицу SemVer, но не утверждать, что `v3.0.0` уже существует.

- [ ] **Шаг 9: сделать README только навигационно достаточным**

Текущий README уже требует точный `SHA`, не подставляет `main`/`latest` и ссылается на `RELEASING.md`. Поэтому не переписывать разделы целиком.

Если после version cutover нужна явная фраза, добавить рядом с быстрым стартом только один смысл:

```text
Номер в `package.json` сам по себе не означает опубликованный выпуск; до появления совпадающего официального тега и выпуска используйте полный `SHA`.
```

Не добавлять копию процедуры из `RELEASING.md`.

- [ ] **Шаг 10: прогнать узкие и полные проверки**

```bash
node tests/test-c3-6-observatory-snapshot.mjs
node tests/test-c3-6-observatory-render.mjs
node tests/test-c3-7-release-workflow.mjs
node tests/test-release-ref.mjs
node tests/test-c3-7-version-truth.mjs
npm test
npm run check:dist
npm run compression:metrics
```

Ожидаемые архитектурные инварианты остаются:

```text
canonical FactRef model count = 1
canonical FactRef sources = 4
runtime constraint kinds = 1
relation descriptor count = 10
primitive descriptor registry count = 1
public CLI = validate, check-diff, check-pr, init, doctor
```

- [ ] **Шаг 11: провести финальный PR #454 без governance-раздувания**

Финальный PR закрывает #454 и содержит только реально потребовавшиеся файлы из заявленного списка. `.github/workflows/release-integrity.yml` должен отсутствовать в diff при зелёном структурном тесте.

Пример `ChangeIntent`:

```repo-guard-yaml
change_type: docs
scope:
  - scripts/observatory/collect.mjs
  - scripts/observatory/render.mjs
  - tests/test-c3-6-observatory-snapshot.mjs
  - tests/test-c3-6-observatory-render.mjs
  - tests/test-c3-7-release-workflow.mjs
  - README.md
  - RELEASING.md
budgets:
  max_new_files: 1
  max_new_docs: 0
  max_net_added_lines: 350
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - scripts/observatory/collect.mjs
  - tests/test-c3-6-observatory-snapshot.mjs
  - RELEASING.md
must_not_touch:
  - package.json
  - package-lock.json
  - repo-policy.json
  - src/**
  - dist/**
  - schemas/**
  - action.yml
  - .github/workflows/**
expected_effects:
  - Observatory использует ту же вычисляемую истину выпуска
  - опубликованное состояние содержит точный commit тега
  - документация не выдаёт package version за опубликованный выпуск
```

Если README после проверки не требует изменения, убрать его из `scope` и diff вместо добавления искусственной правки.

- [ ] **Шаг 12: выполнить точную финальную приёмку C3.7**

После `DRAFT` GREEN перевести PR в `Ready`, получить реальный `Run PR policy check` на той же голове, слить с `expected_head_sha` и дождаться послемержевого `CI`.

Затем дождаться автоматического `Policy Observatory Pages` на том же merge SHA и проверить живой артефакт:

```text
package version = 3.0.0
matching release tag = v3.0.0
matching published release = false
release commit = absent
release truth status = package_only
accepted SHA = exact final C3.7 main SHA
```

После этого свежепроверить внешние объекты:

```text
GET /git/ref/tags/v3.0.0 -> 404
GET /releases/tags/v3.0.0 -> 404
```

И только при одновременном выполнении всех условий:

```text
#452 = completed
#453 = completed
#454 = completed
post-merge CI = GREEN
Pages deploy = GREEN on exact same SHA
v3.0.0 tag = absent
v3.0.0 GitHub Release = absent
```

добавить сводный комментарий в #378 и закрыть #378 как `completed`.

Не создавать тег `v3.0.0` при закрытии #378. Следующий этап после этого — C3.8, а реальный выпуск остаётся за C3.10.

---

## Проверка полноты плана

Спецификация покрывается тремя последовательными задачами:

```text
#452
exact tag resolution
+ strict current HEAD equality
+ published non-draft non-prerelease release
        ↓
#453
package.json = 3.0.0
+ package-lock derived mirror
+ no actual release
        ↓
#454
same observation in Pages
+ exact release commit projection
+ release workflow structural proof
+ README/RELEASING convergence
+ live acceptance
        ↓
#378 completed
```

В плане нет отдельного файла версии, отдельного состояния выпуска, второй release-библиотеки, команды публикации, плавающего тега или автоматизации записи в `GitHub Releases`.

Типы и имена интерфейсов согласованы между задачами:

```text
expectedTagForVersion(version)
observeReleaseTruth({ repo, tag, token, fetchImpl })
verifyReleaseRef({ packageRoot, repo, tag, token, fetchImpl, run })
```

`observeReleaseTruth` появляется в #452 и повторно используется collector в #454. #453 не создаёт новой семантики и меняет только данные версии.

План не содержит необязательных ветвей реализации: единственная условная точка — структурная проверка существующего `release-integrity.yml`. Если она неожиданно красная, выполнение останавливается вместо молчаливого расширения governance scope.
