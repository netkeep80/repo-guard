# C3.7 — План реализации единой версии и истины выпуска

> **Для агентных исполнителей:** обязательно использовать `superpowers:subagent-driven-development` либо `superpowers:executing-plans`. Задачи выполнять строго последовательно; каждый новый поведенческий контракт сначала доказать красным тестом.

**Цель:** сделать `3.0.0` единственной канонической версией продукта и выводить официальный выпуск из неизменяемого тега, точного коммита и опубликованного выпуска `GitHub`, не создавая отдельного состояния выпуска.

**Архитектура:** существующий `scripts/verify-release-ref.mjs` остаётся единственной строгой границей проверки и предоставляет одну read-only функцию наблюдения, которую затем переиспользует Observatory. `package.json.version` — authority; `package-lock.json` — только производное зеркало.

**Стек:** `Node.js` 24, `node:test`, `Git`, `GitHub REST API`, существующий `yaml`, статический `GitHub Pages`.

**Спецификация:** `docs/superpowers/specs/2026-09-10-c3-7-release-truth-design.md`

## Глобальные ограничения

- Принятая база плана: `aee40dac928bf6ce20b7296a21d3525933f7ad4d`.
- Родитель: #378; дорожная карта: #370.
- Порядок: #452 → #453 → #454.
- `package.json.version` — единственный источник версии.
- `package-lock.json` только совпадает с ним как зеркало `npm`.
- C3.7 меняет версию на `3.0.0`, но не создаёт `v3.0.0`.
- Реальный тег, выпуск `GitHub` и публикация `npm` остаются после C3.10.
- До выпуска потребители используют полный 40-символьный `SHA`.
- Не создавать `VERSION`, `release-state.json`, `target-version.json` и аналоги.
- Не добавлять новый публичный `CLI`, `FactRef`, отношение, вид runtime-ограничения или release-specific DSL.
- Не менять C3.8, C3.9 и C3.10.
- Не менять `.github/workflows/release-integrity.yml`, если отдельный структурный тест не докажет реальное расхождение.
- Ошибка API или неполный успешный ответ запрещаются по умолчанию.
- Для #452 и #453 использовать только уже записанные узкие `GovernanceGrant`; ослабление политики не разрешено.
- Каждая задача проходит отдельный `DRAFT PR` → отрицательный тест → минимальное исправление → полный зелёный набор → `Ready` → exact-head `check-pr` → merge → post-merge `CI`.

---

## Задача 1 — #452: точный `tag -> commit` через существующий verifier

**Файлы:**

```text
scripts/verify-release-ref.mjs
tests/test-release-ref.mjs
```

**Итоговые интерфейсы:**

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

`observeReleaseTruth` живёт в том же `scripts/verify-release-ref.mjs`; нового release-модуля нет.

### 1.1 Красный контракт

- [ ] Создать ветку `c3/452-exact-release-truth` от свежего принятого `main`.
- [ ] Проверить, что #452 открыта и её санкция разрешает только `scripts/verify-release-ref.mjs` с атомарным смешанным срезом.
- [ ] Сначала изменить только `tests/test-release-ref.mjs`.

Добавить стабильные идентификаторы:

```js
const exactHead = "a".repeat(40);
const otherHead = "b".repeat(40);
const annotatedTagObject = "c".repeat(40);
const runAt = (sha) => () => sha;
```

Обновить успешный случай до полного лёгкого тега:

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

Добавить положительный случай аннотированного тега:

```js
it("resolves an annotated tag object to the exact checkout commit", async () => {
  const packageRoot = makePackageRoot("2.3.4");
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
          html_url: "https://example.invalid/release",
        },
      ],
    ], []),
  });

  assert.equal(result.ok, true);
});
```

Добавить отрицательные случаи:

```text
unknown tag object type
tag-object cycle
malformed 200 release
mismatching release tag_name
draft release
prerelease release
GitHub API 500
```

- [ ] Запустить только тест:

```bash
node --test tests/test-release-ref.mjs
```

Ожидается красный результат на новом exact-commit контракте.

В GitHub-only исполнении сначала закоммитить только тест и открыть `DRAFT PR` с `Fixes #452`, чтобы красный результат был наблюдаем в `CI`.

### 1.2 Минимальная реализация

- [ ] В `scripts/verify-release-ref.mjs` добавить один локальный исполнитель `Git`:

```js
import { execFileSync } from "node:child_process";

function runProcess(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf-8",
    ...options,
  }).trim();
}
```

- [ ] Использовать один валидатор идентификаторов объектов:

```js
function requireObjectSha(value, context) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${context} does not contain an exact object SHA`);
  }
  return value;
}
```

- [ ] Разрешать лёгкий и аннотированный тег одной функцией:

```js
async function resolveTagCommit({ repo, tag, token, fetchImpl }) {
  const ref = await githubGet(
    `/git/ref/tags/${encodeURIComponent(tag)}`,
    { repo, token, fetchImpl },
  );

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
    const sha = requireObjectSha(object?.sha, `Git object for ${tag}`);

    if (type === "commit") return { exists: true, commit: sha };
    if (type !== "tag") {
      throw new Error(`Git tag ${tag} resolved to unsupported object type ${type}`);
    }
    if (seen.has(sha)) throw new Error(`Git tag ${tag} contains a cycle`);
    seen.add(sha);

    const tagObject = await githubGet(
      `/git/tags/${sha}`,
      { repo, token, fetchImpl },
    );
    if (!tagObject.ok) {
      throw new Error(`Git tag object ${sha} lookup failed: ${tagObject.message}`);
    }
    object = tagObject.body?.object;
  }

  throw new Error(`Git tag ${tag} exceeds the resolution depth limit`);
}
```

- [ ] Добавить общую read-only функцию:

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

  const release = await githubGet(
    `/releases/tags/${encodeURIComponent(tag)}`,
    { repo, token, fetchImpl },
  );
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

Не создавать второй API-клиент или `scripts/release-truth.mjs`.

- [ ] Расширить `verifyReleaseRef` только параметром `run = runProcess` и получить текущий checkout:

```js
const checkoutSha = requireObjectSha(
  run("git", ["rev-parse", "HEAD"], { cwd: packageRoot }),
  "Current checkout",
);
```

- [ ] В строгом verifier обернуть общее наблюдение в `try/catch` и превратить operational/malformed error в структурированный `FAIL`:

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
  return {
    ok: false,
    packageVersion,
    expectedTag,
    repo,
    checks,
  };
}
```

Это различие намеренное: строгий verifier возвращает доказательство `FAIL`, а Observatory позже вызывает `observeReleaseTruth` напрямую и при ошибке не публикует снимок.

- [ ] При существующем теге потребовать:

```js
truth.tag_commit === checkoutSha
```

с отдельной проверкой `release-tag-resolves-to-checkout`.

- [ ] Для официального выпуска потребовать:

```js
truth.release_exists === true
truth.draft === false
truth.prerelease === false
truth.published === true
```

### 1.3 Приёмка #452

- [ ] Выполнить:

```bash
node --test tests/test-release-ref.mjs
npm test
npm run check:dist
```

- [ ] Финальный PR должен менять ровно два файла и использовать `Fixes #452`.
- [ ] `ChangeIntent` должен иметь `change_type: governance`, `scope` только на script+test и не касаться `package*.json`, `src/**`, `dist/**`, схем и workflow.
- [ ] После draft GREEN перевести PR в `Ready`, получить зелёный `Run PR policy check` на exact head, слить с `expected_head_sha` и дождаться зелёного post-merge `CI`.

---

## Задача 2 — #453: версия `3.0.0` без реального выпуска

**Файлы:**

```text
package.json
package-lock.json
tests/test-c3-7-version-truth.mjs
```

### 2.1 Красный контракт

- [ ] Начать ветку `c3/453-version-3-cutover` только после принятия #452.
- [ ] Проверить санкцию #453: только `package.json`, `package-lock.json`, атомарный смешанный срез, без ослабления policy.
- [ ] Сначала создать `tests/test-c3-7-version-truth.mjs`:

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

- [ ] Запустить:

```bash
node tests/test-c3-7-version-truth.mjs
```

Ожидается красный результат, потому что принятая версия ещё `2.0.0`.

В GitHub-only исполнении сначала открыть test-only `DRAFT PR` с `Fixes #453` и зафиксировать этот failure.

### 2.2 Минимальный version cutover

- [ ] В `package.json` изменить только:

```json
"version": "3.0.0"
```

- [ ] В `package-lock.json` изменить только два корневых зеркала:

```text
/version = 3.0.0
/packages/""/version = 3.0.0
```

Не менять зависимости и не создавать новый файл версии.

- [ ] Выполнить:

```bash
node tests/test-c3-7-version-truth.mjs
node tests/test-init.mjs
npm test
npm run check:dist
```

`tests/test-init.mjs` уже читает package version динамически. Если он падает, не добавлять alias: локализовать реальное расхождение.

- [ ] До Ready и после merge проверить внешние факты:

```text
GET /repos/netkeep80/repo-guard/git/ref/tags/v3.0.0 -> 404
GET /repos/netkeep80/repo-guard/releases/tags/v3.0.0 -> 404
```

Если любой объект уже существует, остановить C3.7 и зафиксировать неожиданную историю в #453.

### 2.3 Приёмка #453

- [ ] Финальный PR меняет только три заявленных файла и использует `Fixes #453`.
- [ ] `ChangeIntent`: `change_type: governance`, точный `scope`, `max_new_files: 1`, `max_new_docs: 0`, запрет на scripts, docs, workflow, policy, src и dist.
- [ ] Получить draft GREEN, exact-head Ready GREEN, merge с `expected_head_sha`, post-merge GREEN.
- [ ] Дождаться автоматического Observatory deploy на том же SHA и проверить промежуточную правду:

```text
package_version = 3.0.0
matching_release_tag = v3.0.0
matching_published_release = false
release_truth_status = package_only
```

---

## Задача 3 — #454: единое наблюдение, документация и финальная приёмка

**Файлы, которые могут измениться:**

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

### 3.1 Красный контракт Observatory

- [ ] Начать `c3/454-release-truth-convergence` только после принятия #453.
- [ ] Снова проверить отсутствие реального `v3.0.0` tag/release.
- [ ] Сначала изменить snapshot-тест.

Для текущего состояния требовать:

```js
assert.equal(first.version.package_version, "3.0.0");
assert.equal(first.version.matching_release_tag, "v3.0.0");
assert.equal(first.version.matching_published_release, false);
assert.equal(first.version.release_commit, null);
assert.equal(first.version.release_truth_status, "package_only");
```

Добавить синтетическое опубликованное состояние:

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
            html_url: "https://example.invalid/release",
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

Добавить предварительный выпуск и потребовать `matching_published_release === false` и `release_commit === null`.

- [ ] Запустить snapshot-тест до изменения collector. Ожидается красный результат на отсутствии `release_commit` и tag-aware observation.

### 3.2 Удалить дублирование наблюдения

- [ ] В `scripts/observatory/collect.mjs` импортировать:

```js
import { observeReleaseTruth } from "../verify-release-ref.mjs";
```

- [ ] Удалить локальные `validateReleasePayload` и `observeMatchingRelease`.
- [ ] Использовать только:

```js
const release = await observeReleaseTruth({
  repo: repository,
  tag: matchingReleaseTag,
  token,
  fetchImpl,
});
```

- [ ] Секцию снимка оставить минимальной:

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

В `sources` добавить `scripts/verify-release-ref.mjs`.

Ошибка `observeReleaseTruth` здесь не ловится как `package_only`: Pages build обязан завершиться ошибкой вместо ложной публикации.

### 3.3 Показать exact release commit без новой страницы

- [ ] В `validateObservatorySnapshot` разрешить `release_commit` только как `null` либо точный 40-символьный `SHA`; для `published` требовать ненулевое значение.
- [ ] В карточку «Версия и выпуск» добавить одну строку «Коммит выпуска».
- [ ] Для ненулевого значения строить неизменяемую ссылку:

```text
https://github.com/<owner>/<repo>/commit/<release_commit>
```

- [ ] В `tests/test-c3-6-observatory-render.mjs` доказать:

```text
package_only -> release_commit отсутствует
published -> exact release_commit виден и является immutable link
published + null release_commit -> validation failure
```

Нового клиентского запроса и новой страницы нет.

### 3.4 Доказать, что текущий release-workflow уже достаточен

- [ ] Создать `tests/test-c3-7-release-workflow.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const document = parseDocument(
  readFileSync(resolve(".github/workflows/release-integrity.yml"), "utf8"),
);
assert.equal(document.errors.length, 0);
const workflow = document.toJS();

assert.equal(workflow.permissions?.contents, "read");
assert.equal(Object.keys(workflow.permissions ?? {}).length, 1);

const job = workflow.jobs?.["verify-release-ref"];
assert.ok(job);
assert.equal(job.permissions, undefined);

const checkout = job.steps.find((step) => step.uses === "actions/checkout@v6");
assert.equal(
  checkout?.with?.ref,
  "${{ github.event.release.tag_name || inputs.tag }}",
);
assert.equal(checkout?.with?.["fetch-depth"], 0);

const verify = job.steps.find((step) => (
  typeof step.run === "string"
  && step.run.includes("scripts/verify-release-ref.mjs")
));
assert.ok(verify);
assert.match(verify.run, /--tag/);

const serialized = JSON.stringify(workflow);
assert.doesNotMatch(serialized, /npm publish|gh release create|git push/i);
```

Этот тест ожидается зелёным без изменения workflow. Если он красный, остановить #454 и зафиксировать точное governance-расхождение; не расширять scope молча.

### 3.5 Синхронизировать документацию без дублирования

- [ ] В `RELEASING.md` удалить старую последовательность, где финальный выпуск выполняет `npm version`.
- [ ] Описать один процесс:

```text
package.json.version уже принят обычным PR
        ↓
C3.10 принимает exact SHA S
        ↓
никаких code/version/docs edits
        ↓
tag v3.0.0 -> S
        ↓
published non-prerelease GitHub Release v3.0.0
        ↓
release-integrity + verify-release-ref
        ↓
только затем npm publish
```

- [ ] Сохранить обычное правило SemVer для будущих version boundaries, но не утверждать, что `v3.0.0` уже выпущен.
- [ ] README менять только если нужна одна короткая фраза рядом с быстрым стартом:

```text
Номер в `package.json` сам по себе не означает опубликованный выпуск; до появления совпадающего официального тега и выпуска используйте полный `SHA`.
```

Если текущий README уже выражает это однозначно, не менять его ради формальной галочки.

### 3.6 Проверки и закрытие C3.7

- [ ] Выполнить:

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

- [ ] Подтвердить, что архитектурные метрики не выросли:

```text
FactRef models = 1
FactRef sources = 4
runtime constraint kinds = 1
relation descriptors = 10
primitive descriptor registries = 1
public CLI = validate, check-diff, check-pr, init, doctor
```

- [ ] Финальный PR использует `Fixes #454`; `.github/workflows/release-integrity.yml` отсутствует в diff, если структурный тест зелёный.
- [ ] После draft GREEN получить exact-head Ready GREEN, merge и post-merge GREEN.
- [ ] Дождаться автоматического `Policy Observatory Pages` на том же merge SHA.
- [ ] Проверить живой артефакт:

```text
package_version = 3.0.0
matching_release_tag = v3.0.0
matching_published_release = false
release_commit = null
release_truth_status = package_only
accepted SHA = exact final C3.7 main SHA
```

- [ ] Последний раз проверить GitHub:

```text
GET /git/ref/tags/v3.0.0 -> 404
GET /releases/tags/v3.0.0 -> 404
```

- [ ] Только после этого добавить сводный audit в #378 и закрыть #378 как `completed`.
- [ ] Не создавать `v3.0.0` при закрытии #378. Следующий этап — C3.8; официальный выпуск остаётся после C3.10.

---

## Проверка полноты

```text
#452
one verifier
+ exact lightweight/annotated tag -> commit
+ exact current HEAD equality
+ fail-closed official release
        ↓
#453
package.json = 3.0.0
+ package-lock derived mirror
+ no actual release
        ↓
#454
same observation in Observatory
+ exact published release commit
+ existing read-only workflow proven
+ release docs converged
+ live Pages acceptance
        ↓
#378 completed
```

Новые постоянные сущности отсутствуют. Единственное новое переиспользуемое поведение — `observeReleaseTruth` внутри уже существующего verifier-файла; строгая проверка и read-only проекция используют его по-разному, но не создают две истины.