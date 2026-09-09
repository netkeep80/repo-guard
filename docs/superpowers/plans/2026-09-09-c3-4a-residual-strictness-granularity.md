# C3.4a — план гранулярности остаточной строгости

> Реализация идёт строго через `TDD`: сначала доказанный `RED`, затем минимальный `GREEN`, затем полная приёмка.

**Цель:** заменить один широкий остаточный указатель `/` отдельными указателями на изменившиеся верхнеуровневые секции политики.

**Принцип:** проще и универсальнее. Новый код не знает имён предметных секций, не рекурсирует по произвольному `JSON` и не создаёт новой семантической подсистемы.

**Спецификация:** `docs/superpowers/specs/2026-09-09-c3-4-canonical-self-policy-exemplar-design.md`

**Задача:** #420

**Принятая база:**

```text
48359c19dce0e4028c6991c21fbcf0f5f02e52bd
```

**База метрик C3.0:**

```text
92432809fcddc290080beb51ba151e13a5761869
```

## Жёсткие границы

Должны сохраниться:

```text
runtime constraint kinds = 1
runtime kind = primitive_relation
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
second evaluator = NONE
compatibility aliases = NONE
repo-specific bypass = NONE
```

В C3.4a запрещено менять:

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

`dist` меняется только обычной сборкой из `src`.

---

## Задача 1. Зафиксировать тестовый `RED`

**Файл:** `tests/test-current-policy-vocabulary-projection.mjs`

### Шаг 1.1. Добавить прямой импорт сравнения

Добавить:

```js
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
```

Существующий `computePolicyDelta` сохранить.

### Шаг 1.2. Уточнить существующее ожидание

Сейчас изменение `content_rules` даёт:

```text
/
```

Целевое ожидание:

```text
/content_rules
```

Изменить только ожидаемый указатель. На принятой базе тест обязан стать красным именно из-за текущего корневого сравнения.

### Шаг 1.3. Проверить две независимые секции

Добавить тест, в котором одновременно меняются две текущие остаточные секции, например:

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

Один верхнеуровневый ключ остаётся одной единицей сравнения.

### Шаг 1.4. Проверить экранирование указателя

Для произвольного имени ключа вызвать `compareConstraintPrograms` напрямую:

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

Требуемое экранирование:

```text
~ -> ~0
/ -> ~1
```

### Шаг 1.5. Сохранить защиту от удалённого словаря

Не менять существующий тест:

```text
retired BASE-only integration
→ current schema projection
→ no policy delta
```

Он доказывает, что удалённые поля старой базовой схемы не получают семантических полномочий.

### Шаг 1.6. Доказать `RED`

Запустить:

```bash
node tests/test-current-policy-vocabulary-projection.mjs
```

Ожидаемая причина падения:

```text
/content_rules expected, / actual
two pointers expected, one / actual
escaped pointer expected, / actual
```

Если локальная среда не позволяет честный запуск, создать черновой `PR` с тестовым коммитом и использовать `CI` как доказательство.

До доказанного `RED` рабочий код не менять.

### Шаг 1.7. Зафиксировать тестовый коммит

Изменён только один тестовый файл.

Коммит:

```text
test(c3.4a): require residual pointer granularity
```

---

## Задача 2. Реализовать минимальный `GREEN`

**Исходник:** `src/checks/constraint-program.mts`

**Генерируемый файл:** `dist/checks/constraint-program.mjs`

### Шаг 2.1. Добавить экранирование одного токена

Добавить небольшую функцию:

```ts
const jsonPointerToken = (value: string): string =>
  value.replace(/~/g, "~0").replace(/\//g, "~1");
```

Функция не знает имён секций политики.

### Шаг 2.2. Не менять `unknownProjection()`

`unknownProjection()` остаётся единственным владельцем остаточной проекции.

Запрещено:

```text
добавлять специальные исключения ради C3.4b
читать схему из canonical kernel
переносить schema vocabulary logic в constraint-program
```

Фильтрация текущего словаря схемы остаётся на существующей внешней границе `policy-delta-rules.mts`.

### Шаг 2.3. Сравнивать верхнеуровневые ключи отдельно

Заменить один общий блок для `/` на универсальный цикл:

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

Почему нужны отдельные детали:

- `Object.hasOwn` отличает отсутствующий ключ от явного `null`;
- сортировка делает порядок диагностик детерминированным;
- экранирование формирует корректный указатель;
- значение одного ключа сравнивается атомарно.

### Шаг 2.4. Не вводить рекурсию

Изменение внутри:

```text
/content_rules
```

остаётся одним указателем.

Не создавать автоматически:

```text
/content_rules/0
/content_rules/0/id
```

Более глубокая гранулярность не нужна текущей задаче.

### Шаг 2.5. Собрать `dist`

Запустить:

```bash
npm run build
```

Ожидаемое изменение среди генерируемых файлов:

```text
dist/checks/constraint-program.mjs
```

### Шаг 2.6. Проверить сфокусированный `GREEN`

Запустить:

```bash
node tests/test-current-policy-vocabulary-projection.mjs
```

Ожидается полный успех.

### Шаг 2.7. Проверить соседние контракты

Запустить:

```bash
node tests/test-policy-delta-rules.mjs
node tests/test-compression-rules.mjs
```

Если исторический тест ожидает корневой `/` именно для остаточной семантики, изменить только ожидаемый указатель. Смысл запрета по умолчанию не ослаблять.

### Шаг 2.8. Проверить чистоту изменения

В рабочем `diff` не должно появиться:

```text
new runtime kind
new FactRef source
new relation descriptor
new evaluator
new policy field
repo-specific branch
```

Новый код сравнения использует только существующую проекцию, сравнение значений, объединение ключей, сортировку и экранирование.

### Шаг 2.9. Зафиксировать рабочий коммит

```text
feat(c3.4a): report residual policy changes by top-level pointer
```

---

## Задача 3. Полная проверка

### Шаг 3.1. Проверить свежесть `dist`

```bash
npm run check:dist
```

Ожидается:

```text
Generated dist is current.
```

### Шаг 3.2. Проверить архитектурные метрики

```bash
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

Обязательные значения:

```text
runtime constraint kinds = 1
runtime constraint kind names = primitive_relation
FactRef sources = change_intent,diff,document,repository
relation descriptors = 10
canonical FactRef model count = 1
primitive descriptor registry count = 1
```

C3.4a не обязана уменьшить число строк. Она обязана не увеличить семантическую поверхность.

### Шаг 3.3. Проверить собственную политику

```bash
node dist/repo-guard.mjs
```

Ожидается успех.

### Шаг 3.4. Проверить `doctor`

```bash
node dist/repo-guard.mjs doctor
```

Блокирующего сбоя быть не должно.

### Шаг 3.5. Запустить весь набор тестов

```bash
npm test
```

Ожидается полный успех.

### Шаг 3.6. Проверить точный `diff`

Перед готовностью запроса на слияние должны изменяться только:

```text
src/checks/constraint-program.mts
dist/checks/constraint-program.mjs
tests/test-current-policy-vocabulary-projection.mjs
```

Новый тестовый файл не создавать без доказанной необходимости.

---

## Задача 4. Приёмка через GitHub

### Шаг 4.1. Создать ветку реализации от принятой `main`

Перед началом повторно проверить живой GitHub.

Если `main` уже сдвинулась, использовать новый принятый SHA и не работать поверх устаревшей базы.

### Шаг 4.2. Создать черновой `PR` после тестового `RED`

Запрос должен ссылаться на #420 и #375.

Намерение изменения:

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

Первый запуск `CI` обязан доказать красное состояние именно на тестовом коммите.

### Шаг 4.3. После `RED` добавить рабочий коммит

Реализовать только задачу 2.

Черновой запуск должен стать полностью зелёным. Проверка готового PR в черновом состоянии может быть пропущена существующим рабочим процессом.

### Шаг 4.4. Перевести `PR` в готовое состояние

Только после зелёного чернового запуска.

На одном точном SHA требуются:

```text
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

### Шаг 4.5. Слить только проверенную вершину

Перед слиянием повторно проверить:

```text
PR OPEN
PR READY
mergeable = true
head SHA unchanged
required checks GREEN
```

Слияние выполнять с `expected_head_sha`.

### Шаг 4.6. Проверить состояние после слияния

Для нового SHA `main` найти запуск после отправки и требовать:

```text
validate = SUCCESS
smoke-pack = SUCCESS
```

### Шаг 4.7. Закрыть #420

Только после зелёной проверки после слияния.

В задаче зафиксировать:

```text
accepted merge SHA
RED CI run
ready exact-head CI run
post-merge CI run
runtime kinds = 1
FactRef sources = 4
relation descriptors = 10
```

После этого вернуться к #375, заново прочитать живую собственную политику и только тогда составить отдельный точный план C3.4b.

---

## Самопроверка плана

- [x] Рабочий код запрещён до доказанного `RED`.
- [x] C3.4a не меняет собственную политику, схему, `CI` или `Action`.
- [x] Новый алгоритм универсален и не знает имён будущих удаляемых секций.
- [x] Гранулярность ограничена одним верхнеуровневым ключом.
- [x] Экранирование указателя определено явно.
- [x] Отсутствующий ключ отличается от явного `null`.
- [x] Порядок диагностик детерминирован.
- [x] Проекция текущего словаря схемы остаётся на внешней границе `policy-delta-rules`.
- [x] Удалённый словарь старой базы остаётся без семантических полномочий.
- [x] Полная приёмка включает `dist`, собственную политику, метрики, весь набор тестов и проверки после слияния.
- [x] План C3.4b намеренно откладывается до принятия C3.4a.
