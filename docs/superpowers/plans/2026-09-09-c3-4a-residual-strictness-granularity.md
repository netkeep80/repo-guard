# C3.4a — план реализации гранулярности остаточной strictness

> Для агентной реализации обязателен пошаговый режим по этому плану с `TDD`: сначала доказанный `RED`, затем минимальный `GREEN`, затем полная приёмка.

**Цель:** заменить один широкий остаточный указатель `/` детерминированными указателями на изменившиеся верхнеуровневые секции политики, сохранив запрет по умолчанию и существующую границу текущего словаря схемы.

**Архитектура:** `unknownProjection()` остаётся единственным владельцем понятия «части политики, не представленные в strictness программы ограничений». Меняется только сравнение двух уже построенных остаточных проекций: берётся объединение их верхнеуровневых ключей, ключи сортируются, каждое значение сравнивается атомарно, а для каждого изменившегося ключа создаётся отдельный `policy_incomparable`. Вложенная структура не рекурсирует. Код не знает имён предметных секций.

**Технологии:** `TypeScript 7`, `Node.js 24`, `node:test`, сгенерированный `ESM dist`, `GitHub Actions`.

**Спецификация:** `docs/superpowers/specs/2026-09-09-c3-4-canonical-self-policy-exemplar-design.md`

**Задача:** #420

**Принятая база:**

```text
48359c19dce0e4028c6991c21fbcf0f5f02e52bd
```

**Каноническая база метрик C3.0:**

```text
92432809fcddc290080beb51ba151e13a5761869
```

## Жёсткие границы всего среза

```text
runtime constraint kinds = 1
runtime kind = primitive_relation
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
new evaluator = NONE
new arbitrary expression language = NONE
compatibility alias = NONE
repo-specific bypass = NONE
```

Нельзя менять в C3.4a:

```text
repo-policy.json
schemas/**
.github/**
action.yml
README.md
templates/**
```

Допустимые файлы реализации:

```text
src/checks/constraint-program.mts
dist/checks/constraint-program.mjs
tests/test-current-policy-vocabulary-projection.mjs
```

`dist` меняется только результатом обычной сборки из `src`.

---

## Задача 1. Зафиксировать целевую семантику тестовым RED

**Файлы:**

- Изменить: `tests/test-current-policy-vocabulary-projection.mjs`
- Не менять: production-файлы

### Шаг 1.1. Расширить импорт только для прямой проверки comparator

- [ ] Добавить импорт:

```js
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
```

Существующий импорт `computePolicyDelta` сохранить.

### Шаг 1.2. Уточнить существующий fail-closed тест

Сейчас тест для изменения `content_rules` ожидает:

```js
assert.equal(relaxations[0]?.pointer, "/");
```

- [ ] Изменить только ожидаемый указатель на целевой:

```js
assert.equal(relaxations[0]?.pointer, "/content_rules");
```

Это обязано стать первым доказанным `RED` на принятой базе.

### Шаг 1.3. Добавить проверку независимых верхнеуровневых секций

- [ ] Добавить тест, который одновременно меняет две текущие остаточные секции.

Пример формы:

```js
it("reports independent residual sections with independent pointers", () => {
  const base = currentPolicy();
  const head = currentPolicy();
  head.content_rules = [{
    id: "no-debug",
    glob: "src/**",
    mode: "added_lines",
    forbid_regex: ["debug"],
  }];
  head.surfaces = { source: ["src/**"] };

  const pointers = computePolicyDelta(base, head).relaxations
    .map((item) => item.pointer)
    .sort();

  assert.deepEqual(pointers, ["/content_rules", "/surfaces"]);
});
```

Тест не утверждает вложенную гранулярность. Один верхнеуровневый ключ — одна единица остаточного сравнения.

### Шаг 1.4. Добавить проверку экранирования JSON Pointer

`computePolicyDelta` специально фильтрует поля через текущую схему, поэтому для произвольного имени ключа здесь нужно вызвать `compareConstraintPrograms` напрямую.

- [ ] Добавить тест:

```js
it("escapes residual top-level keys as JSON Pointer tokens", () => {
  const key = "future/semantic~v1";
  const base = { [key]: { mode: "strict" } };
  const head = { [key]: { mode: "changed" } };

  const comparison = compareConstraintPrograms(base, head);

  assert.deepEqual(
    comparison.incomparable.map((item) => item.pointer),
    ["/future~1semantic~0v1"],
  );
});
```

### Шаг 1.5. Сохранить исторический schema-vocabulary ratchet

- [ ] Не ослаблять существующий тест:

```text
retired BASE-only integration
→ current schema projection
→ no policy delta
```

Он доказывает, что C3.4a не возвращает семантические полномочия удалённому словарю.

### Шаг 1.6. Запустить focused test и зафиксировать RED

- [ ] Выполнить:

```bash
node tests/test-current-policy-vocabulary-projection.mjs
```

Ожидаемый результат на принятой реализации:

```text
FAIL: expected /content_rules, got /
FAIL: expected two pointers, got one /
FAIL: expected escaped top-level pointer, got /
```

Точная формулировка `node:test` может отличаться. Важно, чтобы причина падения была только старой root-wide семантикой.

- [ ] Если локальная среда не позволяет честно выполнить тест, создать draft PR с test-only head и использовать CI как доказательство `RED`.
- [ ] Не писать production-код до зафиксированного `RED`.

### Шаг 1.7. Первый commit должен быть test-only

- [ ] Проверить diff: изменён только `tests/test-current-policy-vocabulary-projection.mjs`.
- [ ] Commit:

```text
test(c3.4a): require residual pointer granularity
```

---

## Задача 2. Реализовать минимальное универсальное сравнение

**Файлы:**

- Изменить: `src/checks/constraint-program.mts`
- Сгенерировать: `dist/checks/constraint-program.mjs`
- Не менять: другие production-файлы

### Шаг 2.1. Добавить только универсальное экранирование токена

- [ ] Рядом с небольшими comparator helpers добавить функцию уровня файла:

```ts
const jsonPointerToken = (value: string): string =>
  value.replace(/~/g, "~0").replace(/\//g, "~1");
```

Функция не знает имён секций политики.

### Шаг 2.2. Не менять unknownProjection

- [ ] Оставить `unknownProjection()` владельцем существующей остаточной проекции.

Не надо:

```text
добавлять туда специальные delete для C3.4b
читать схему из canonical kernel
переносить current-vocabulary projection из policy-delta-rules
```

Schema-derived фильтрация текущего словаря уже находится на правильной внешней границе в `policy-delta-rules.mts`.

### Шаг 2.3. Заменить один root-wide compare на цикл по верхнеуровневым ключам

Текущий блок:

```ts
const beforeUnknown = unknownProjection(basePolicy), afterUnknown = unknownProjection(headPolicy);
if (!same(beforeUnknown, afterUnknown)) {
  incomparableChanges.push({
    kind: "policy_incomparable",
    pointer: "/",
    before: beforeUnknown,
    after: afterUnknown,
    message: "policy sections outside the Constraint Program changed and require explicit governance review",
  });
  changed = true;
}
```

- [ ] Заменить его минимальной универсальной логикой концептуально следующей формы:

```ts
const beforeUnknown = unknownProjection(basePolicy) as Record<string, unknown>;
const afterUnknown = unknownProjection(headPolicy) as Record<string, unknown>;
const keys = [...new Set([
  ...Object.keys(beforeUnknown),
  ...Object.keys(afterUnknown),
])].sort();

for (const key of keys) {
  const beforePresent = Object.hasOwn(beforeUnknown, key);
  const afterPresent = Object.hasOwn(afterUnknown, key);
  const before = beforePresent ? beforeUnknown[key] : null;
  const after = afterPresent ? afterUnknown[key] : null;

  if (beforePresent === afterPresent && same(before, after)) continue;

  incomparableChanges.push({
    kind: "policy_incomparable",
    pointer: `/${jsonPointerToken(key)}`,
    before,
    after,
    message: `policy section "${key}" outside the Constraint Program changed and requires explicit governance review`,
  });
  changed = true;
}
```

`Object.hasOwn` нужен, чтобы различать:

```text
ключ отсутствует
```

и:

```json
{ "key": null }
```

Сортировка нужна для детерминированного порядка диагностик.

### Шаг 2.4. Не вводить рекурсию

- [ ] Убедиться, что изменение:

```json
{
  "content_rules": {
    "a": 1,
    "b": 2
  }
}
```

остаётся одним указателем:

```text
/content_rules
```

Не создавать:

```text
/content_rules/a
/content_rules/b
```

Это отдельный будущий semantic design, если когда-либо появится реальная необходимость.

### Шаг 2.5. Собрать generated dist

- [ ] Выполнить:

```bash
npm run build
```

- [ ] Проверить, что ожидаемое generated изменение появилось только в:

```text
dist/checks/constraint-program.mjs
```

### Шаг 2.6. Запустить focused GREEN

- [ ] Выполнить:

```bash
node tests/test-current-policy-vocabulary-projection.mjs
```

Ожидается полный `GREEN`.

### Шаг 2.7. Проверить соседний strictness contract

- [ ] Выполнить:

```bash
node tests/test-policy-delta-rules.mjs
node tests/test-compression-rules.mjs
```

Ожидается `GREEN`.

Если старый общий тест явно ожидает `/` для residual semantics, изменить только эту историческую ожидаемую диагностику на узкий указатель. Не менять смысл fail-closed проверки.

### Шаг 2.8. Проверить архитектурную чистоту diff

- [ ] В production diff должны отсутствовать:

```text
новая предметная ветка
новый runtime kind
новый FactRef source
новый relation descriptor
новый evaluator
новый policy field
```

- [ ] Новый comparator-код должен работать только через `Object.keys`, `same`, `Object.hasOwn`, сортировку и JSON Pointer escaping.

### Шаг 2.9. Commit реализации

- [ ] Commit:

```text
feat(c3.4a): report residual policy changes by top-level pointer
```

---

## Задача 3. Полная локальная и архитектурная проверка

### Шаг 3.1. Проверить generated boundary

- [ ] Выполнить:

```bash
npm run check:dist
```

Ожидается:

```text
Generated dist is current.
```

### Шаг 3.2. Проверить архитектурные метрики

- [ ] Выполнить:

```bash
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

Обязательные инварианты:

```text
runtime constraint kinds = 1
runtime constraint kind names = primitive_relation
FactRef sources = change_intent,diff,document,repository
relation descriptors = 10
canonical FactRef model count = 1
primitive descriptor registry count = 1
```

C3.4a не обязана уменьшать строки. Она обязана не увеличивать semantic surface.

### Шаг 3.3. Проверить собственную policy

- [ ] Выполнить:

```bash
node dist/repo-guard.mjs
```

Ожидается `GREEN`.

### Шаг 3.4. Проверить doctor

- [ ] Выполнить:

```bash
node dist/repo-guard.mjs doctor
```

Ожидается отсутствие blocking failure.

### Шаг 3.5. Запустить весь discovered suite

- [ ] Выполнить:

```bash
npm test
```

Ожидается полный `GREEN`.

### Шаг 3.6. Проверить exact diff

- [ ] Diff C3.4a implementation PR до Ready должен содержать только:

```text
src/checks/constraint-program.mts
dist/checks/constraint-program.mjs
tests/test-current-policy-vocabulary-projection.mjs
```

Дополнительный тестовый файл допустим только если существующая test boundary объективно недостаточна. Предпочтение — не создавать новый файл.

---

## Задача 4. GitHub-приёмка C3.4a

### Шаг 4.1. Создать implementation branch от принятого main

- [ ] Использовать exact base:

```text
48359c19dce0e4028c6991c21fbcf0f5f02e52bd
```

Если `main` сдвинулся до начала реализации, сначала повторно проверить live GitHub и ребазировать смысл плана на новый accepted base. Не реализовывать поверх устаревшего состояния молча.

### Шаг 4.2. Создать draft PR после test-only RED commit

- [ ] PR должен ссылаться на #420 и #375.
- [ ] PR ChangeIntent:

```repo-guard-yaml
change_type: feature
scope:
  - src/checks/constraint-program.mts
  - dist/checks/constraint-program.mjs
  - tests/test-current-policy-vocabulary-projection.mjs
budgets:
  max_new_files: 0
  max_new_docs: 0
  max_net_added_lines: 200
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - tests/test-current-policy-vocabulary-projection.mjs
must_not_touch:
  - repo-policy.json
  - schemas/**
  - .github/**
  - action.yml
expected_effects:
  - остаточные изменения политики получают узкие верхнеуровневые JSON Pointer
  - удалённый словарь BASE остаётся семантически неактивным
  - каноническая runtime-архитектура не растёт
```

- [ ] Первый draft CI должен доказать ожидаемый `RED` именно test-only head.

### Шаг 4.3. После RED добавить production commit

- [ ] Реализовать только задачу 2.
- [ ] Дождаться draft CI полного `GREEN`.

В draft `Run PR policy check` может быть пропущен по существующему CI-контракту; это нормально.

### Шаг 4.4. Перевести PR в Ready только после draft GREEN

- [ ] Зафиксировать exact head SHA.
- [ ] Mark Ready.
- [ ] Требовать на том же exact head:

```text
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

### Шаг 4.5. Merge только exact ready head

- [ ] Перед merge повторно проверить:

```text
PR OPEN
PR READY
mergeable = true
head SHA не изменился
required checks GREEN
```

- [ ] Merge с `expected_head_sha`.

### Шаг 4.6. Post-merge acceptance

- [ ] Проверить новый exact `main` SHA.
- [ ] Найти push-run этого SHA.
- [ ] Требовать:

```text
validate = SUCCESS
smoke-pack = SUCCESS
```

### Шаг 4.7. Закрыть #420 только после post-merge GREEN

- [ ] Добавить в #420 итоговое evidence:

```text
accepted merge SHA
RED CI run
ready exact-head CI run
post-merge CI run
runtime kinds = 1
FactRef sources = 4
relation descriptors = 10
```

- [ ] Закрыть #420 как `completed`.

- [ ] Вернуться к #375.
- [ ] Только после этого перепроверить live self-policy и написать отдельный точный план C3.4b.

---

## Самопроверка плана

- [x] План не содержит production implementation до test-only `RED`.
- [x] C3.4a не меняет self-policy, схему, CI или Action.
- [x] Новый алгоритм универсален и не знает имён будущих удаляемых секций.
- [x] Гранулярность ограничена одним верхнеуровневым ключом; рекурсивный язык не вводится.
- [x] JSON Pointer escaping определён явно.
- [x] Отсутствие ключа отличается от явного `null`.
- [x] Порядок диагностик детерминирован сортировкой ключей.
- [x] Current-schema vocabulary projection остаётся на внешней границе `policy-delta-rules`.
- [x] Retired BASE-only vocabulary остаётся без семантических полномочий.
- [x] Полная приёмка включает generated dist, self-policy, метрики, весь suite, Ready PR и post-merge checks.
- [x] C3.4b намеренно не спроектирована на уровне implementation до принятия C3.4a.
