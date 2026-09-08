# C3.3d3 — план реализации сведения `size_rules`

> **Для агентных исполнителей:** при реализации по задачам использовать навык `superpowers:subagent-driven-development` (предпочтительно) или `superpowers:executing-plans`. Для отслеживания шагов используется синтаксис флажков (`- [ ]`).

**Цель:** удалить выделенный рантайм и вычислитель `size_rules`, а поддерживаемый язык свести к каноническим скалярным фактам репозитория/диффа и существующим отношениям `numeric_bound`.

**Архитектура:** `size_rules` остаётся только фронтендом политики. Измерение состояния репозитория выполняется через один универсальный селектор `repository.path_metric`; рост диффа — через существующий селектор `diff.metric`, расширенный ограничением по путям и `net_files`. Все лимиты исполняются существующим ядром примитивных отношений; новые виды отношений и источники `FactRef` не вводятся.

**Технологии:** `TypeScript` `.mts`, генерируемый `dist/*.mjs`, тесты `Node.js`, `Ajv JSON Schema`, `GitHub Actions`.

**Спецификация:** `docs/superpowers/specs/2026-09-08-c3-3d3-size-rule-lowering.md`

## Глобальные ограничения

- Принятая база строго равна `9ff00319f9828261ff997796bdb906b95e7a281f`.
- Ответственная issue — #409; родительская — #398.
- `FactRef models = 1`.
- `FactRef sources = 4`.
- `relation descriptors = 10`.
- Новый descriptor отношения не вводится.
- Новый источник `FactRef` не вводится.
- Второй вычислитель или второй `FactStore` не вводятся.
- Совместимый alias не вводится.
- Итоговые виды рантайма должны быть строго `integration`, `primitive_relation`.
- `RED-first`: production-изменения запрещены до коммита с падающим контрактным тестом D3 и наблюдаемого падения именно по отсутствующему требуемому поведению.
- В D3 не закрывать #398 или #374.

---

### Задача 1: архитектурный контракт D3 в состоянии `RED`

**Файлы:**
- Создать: `tests/test-c3-3d3-size-rule-lowering.mjs`

**Интерфейсы:**
- Использует текущие `compileConstraintIR`, `evaluateConstraintIR`, канонические экспорты `FactRef`/отношений и текущую схему через обычные тестовые поверхности.
- Даёт один fail-closed контрактный тест D3, доказывающий требуемую архитектуру до production-изменений.

- [ ] **Шаг 1: написать падающий тест**

Тест должен проверять всё перечисленное через реальное публичное/внутреннее поведение рантайма, а не снимки текста исходников:

```text
A. a supported file rule compiles to primitive_relation/numeric_bound using repository.path_metric
B. a supported directory absolute rule compiles to primitive_relation/numeric_bound using repository.path_metric
C. a directory growth rule compiles to primitive_relation/numeric_bound using scoped diff.metric
D. a mixed directory rule emits separate state and transaction primitive constraints
E. advisory remains generic metadata and reports warning rather than dedicated size-rules-advisory
F. unreadable selected repository content fails closed
G. runtime kinds no longer include size_rules
H. relation descriptor count stays 10 and FactRef source count stays 4
```

Использовать минимальный набор фактов с `trackedFiles`, нормализованными элементами диффа и `readFile`. Включить один случай совпавшего, но нечитаемого файла.

- [ ] **Шаг 2: запустить фокусный тест и подтвердить `RED`**

Запуск:

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
```

Ожидание: `FAIL`, потому что принятая база ещё выдаёт `kind=size_rules` и не имеет получения `repository.path_metric`/ограниченного по путям `diff.metric`.

- [ ] **Шаг 3: закоммитить только `RED`-тест**

```bash
git add tests/test-c3-3d3-size-rule-lowering.mjs
git commit -m "test(c3.3d3): add size-rule lowering falsifier"
```

В этом коммите не должно быть production-файлов.

---

### Задача 2: каноническое получение скалярных фактов

**Файлы:**
- Изменить: `src/document-facts.mts`
- Изменить только при необходимости повторного использования: `src/diff/classification.mts`
- Тест: `tests/test-c3-3d3-size-rule-lowering.mjs`

**Интерфейсы:**
- Добавляет форму селектора репозитория:

```ts
{
  kind: "path_metric";
  patterns: readonly string[];
  exclude_paths?: readonly string[];
  population: "tracked" | "changed";
  metric: "lines" | "bytes" | "files";
  aggregate: "max" | "sum";
}
```

- Расширяет существующий селектор метрик диффа значением `metric: "net_files"` и необязательными `patterns`, `exclude_paths`.

- [ ] **Шаг 1: минимально реализовать получение `repository.path_metric`**

Правила выбора:

```text
tracked population -> facts.trackedFiles
changed population -> checked diff paths intersected with tracked/current paths
patterns -> include matching paths
exclude_paths -> remove matching paths
files metric -> per-path value 1; no content read
lines -> count current file lines
bytes -> current file byte length
max -> maximum measurement, empty set = 0
sum -> sum measurements, empty set = 0
```

Если выбранный файл для `lines`/`bytes` невозможно прочитать, вернуть структурированную ошибку факта. Не пропускать файл.

Вернуть универсальное происхождение факта: вид селектора, совпавшие пути, измерения, агрегат и итоговое значение.

- [ ] **Шаг 2: расширить существующий `diff.metric`**

Применять необязательные `patterns`/`exclude_paths` до вычисления метрики. Если эти поля отсутствуют, сохранить прежнее поведение.

Реализовать:

```text
net_files = count(added) - count(deleted)
```

Изменённые файлы дают нулевой вклад.

- [ ] **Шаг 3: запустить фокусный тест D3**

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
```

Ожидание: тест всё ещё `FAIL` на assertions компилятора/вида рантайма; assertions получения фактов уже могут проходить.

- [ ] **Шаг 4: запустить тесты канонических фактов**

```bash
node tests/test-document-facts-boundary.mjs
node tests/test-canonical-relation-kernel.mjs
```

Ожидание: `PASS`.

- [ ] **Шаг 5: закоммитить**

```bash
git add src/document-facts.mts src/diff/classification.mts tests/test-c3-3d3-size-rule-lowering.mjs
git commit -m "feat(c3.3d3): add canonical path metric facts"
```

Если `src/diff/classification.mts` не изменён, не включать его.

---

### Задача 3: свести `size_rules` в `Constraint Program`

**Файлы:**
- Изменить: `src/checks/constraint-program.mts`
- Изменить: `src/checks/rules/constraints.mts`
- Тест: `tests/test-c3-3d3-size-rule-lowering.mjs`

**Интерфейсы:**
- Существующий `primitiveRelation(...)` остаётся формой выдаваемого рантайма.
- При необходимости добавить только универсальную метаинформацию примитива:

```ts
advisory?: boolean
```

- [ ] **Шаг 1: компилировать выбранные правила размера в примитивные отношения**

Для каждого правила, выбранного через `applies_to_change_types`:

```text
file absolute -> repository.path_metric(max) -> numeric_bound(max)
directory absolute -> repository.path_metric(sum) -> numeric_bound(max)
directory growth lines -> diff.metric(net_added_lines, scoped) -> numeric_bound(max_growth)
directory growth files -> diff.metric(net_files, scoped) -> numeric_bound(max_growth)
```

Использовать фазу `state` для абсолютных ограничений по всем отслеживаемым файлам, а `transaction` — для file-ограничений `changed_only` и ограничений роста.

Смешанное правило каталога порождает два ограничения. `kind=size_rules` не выдавать.

- [ ] **Шаг 2: удалить выделенную ветвь исполнения правил размера**

Удалить из `constraints.mts`:

```text
size_rules runtime kind
CONSTRAINT_PHASES.size_rules
projectSizeRules(...)
checkSizeRules import/call
size-rules-advisory special result
```

Для примитивных ограничений с `advisory=true` после вычисления отношения универсально копировать `{ advisory: true }` в результат проверки.

- [ ] **Шаг 3: запустить фокусный тест D3**

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
```

Ожидание: `GREEN`, кроме ещё не добавленных/применённых assertions сужения схемы.

- [ ] **Шаг 4: запустить тесты исполнения и pipeline**

```bash
node tests/test-execution-phases.mjs
node tests/test-pipeline.mjs
node tests/test-rule-registry.mjs
```

Ожидание: выявить только устаревшие assertions, фиксирующие удалённую топологию рантайма. Не менять production ради удовлетворения устаревшей топологии.

- [ ] **Шаг 5: закоммитить**

```bash
git add src/checks/constraint-program.mts src/checks/rules/constraints.mts tests/test-c3-3d3-size-rule-lowering.mjs
git commit -m "refactor(c3.3d3): lower size rules to primitive relations"
```

---

### Задача 4: перенести неподдерживаемые сочетания в ошибку схемы/фронтенда

**Файлы:**
- Изменить: `schemas/repo-policy.schema.json`
- Изменить: `tests/validate-schemas.mjs`
- Изменить `examples/size-rules-policy.json` только если это необходимо для попадания в утверждённое подмножество.
- Тест: `tests/test-c3-3d3-size-rule-lowering.mjs`

**Интерфейсы:**
- Публичное поддерживаемое подмножество строго соответствует спецификации; неподдерживаемые сочетания отклоняются до рантайма.

- [ ] **Шаг 1: добавить `RED`-assertions схемы**

Проверить как недопустимые:

```text
file + metric=files
file + max_growth
directory + bytes + max_growth
directory + count=changed_only
```

Проверить как допустимые репрезентативные формы: file lines, file bytes `changed_only`, directory lines growth, directory files growth, directory bytes absolute.

- [ ] **Шаг 2: запустить валидацию схемы и подтвердить `RED`**

```bash
node tests/validate-schemas.mjs
```

Ожидание: `FAIL`, потому что текущая схема шире утверждённого подмножества.

- [ ] **Шаг 3: сузить только `definitions.size_rule`**

Использовать структурную схему `oneOf`/условия так, чтобы недопустимые сочетания не могли дойти до рантайма. Поля совместимости не добавлять.

- [ ] **Шаг 4: запустить валидацию схемы**

```bash
node tests/validate-schemas.mjs
```

Ожидание: `PASS`.

- [ ] **Шаг 5: закоммитить**

```bash
git add schemas/repo-policy.schema.json tests/validate-schemas.mjs examples/size-rules-policy.json
git commit -m "refactor(c3.3d3): bound size-rule surface at schema"
```

Если файл примера не изменён, не включать его.

---

### Задача 5: удалить выделенный вычислитель и мигрировать только доказанно устаревшие тесты

**Файлы:**
- Удалить: `src/checks/rules/size-rules.mts`
- Изменять только доказанно устаревших потребителей; вероятные кандидаты: `tests/test-compression-rules.mjs`, `tests/test-execution-phases.mjs`, `tests/test-pipeline.mjs`, `tests/test-rule-registry.mjs`.
- Генерируемые аналоги в `dist/**` изменять через стандартную сборку репозитория, а не ручным семантическим расхождением.

**Интерфейсы:**
- Экспорт `checkSizeRules` должен исчезнуть.
- Результат рантайма с именем `size-rules` больше не требуется как контракт топологии; сведённые ограничения используют стабильные имена, производные от правил.

- [ ] **Шаг 1: удалить `size-rules.mts` и доказанно устаревшие прямые импорты**

Мигрировать тесты к каноническому поведению только когда они всё ещё доказывают полезную семантику. Assertions, единственная цель которых — закреплять удалённый вычислитель/топологию результата, удалить.

Для исторического транзакционного теста заменить `directory + changed_only` на допустимый случай `file + changed_only`; не воссоздавать семантику условного поддерева.

- [ ] **Шаг 2: собрать генерируемый `dist`**

Использовать стандартную команду сборки из текущего `package.json`, регенерирующую `dist`.

- [ ] **Шаг 3: запускать фокусные тесты по одному падению за раз**

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
node tests/test-compression-rules.mjs
node tests/test-execution-phases.mjs
node tests/test-pipeline.mjs
node tests/test-rule-registry.mjs
```

Ожидание: `PASS` после только доказанных evidence-backed миграций.

- [ ] **Шаг 4: закоммитить**

```bash
git add -A src/checks/rules/size-rules.mts dist tests
git commit -m "refactor(c3.3d3): delete size-rule runtime evaluator"
```

---

### Задача 6: зафиксировать инварианты сжатия и выполнить полную проверку

**Файлы:**
- Изменить `tests/test-c3-3d1-runtime-tail-deletion.mjs` или создать отдельный ratchet D3, если так яснее.
- Ожидания метрик сжатия изменять только там, где они представляют принятые архитектурные значения.

**Интерфейсы:**
- Виды рантайма строго: `integration`, `primitive_relation`.
- Descriptors отношений строго 10.
- Источники `FactRef` строго 4.

- [ ] **Шаг 1: добавить/скорректировать точные структурные ratchets**

Проверить физическое отсутствие source/dist-вычислителя `size-rules` и точное число видов рантайма `2`.

- [ ] **Шаг 2: проверить свежесть `dist` и метрики сжатия**

```bash
npm run check:dist
npm run check:compression
```

Если имена скриптов отличаются, использовать точные команды из текущего `package.json`; не придумывать заменяющие gates.

- [ ] **Шаг 3: запустить полный обнаруживаемый набор тестов**

```bash
node tests/run.mjs
```

Ожидание: все обнаруженные тестовые файлы `GREEN`.

- [ ] **Шаг 4: закоммитить изменения ratchet**

```bash
git add tests scripts docs
git commit -m "test(c3.3d3): ratchet two-kind runtime tail"
```

Добавлять только действительно изменённые файлы.

---

### Задача 7: draft `PR`, ревью точной головы, приёмка `Ready` и merge

**Файлы:** отсутствуют, если ревью не обнаружит дефект.

- [ ] **Шаг 1: открыть draft `PR`**

Заголовок `PR`:

```text
C3.3d3: lower size rules into canonical scalar facts
```

Описание должно содержать `Fixes #409`, точную принятую базу, evidence `RED`, семантические срезы, значения инвариантов и явное указание, что #398/#374 остаются открытыми.

- [ ] **Шаг 2: дождаться draft `CI` и проверить точную голову**

На проверяемой голове требуются `validate` и `smoke-pack` в состоянии `GREEN`. Проверить изменённые файлы на скрытую size-specific логику вычислителя, второй `FactStore`, новые виды отношений/источников и aliases совместимости.

- [ ] **Шаг 3: перевести в `Ready` и потребовать evidence политики `PR`**

На точной голове `Ready` требуются:

```text
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

- [ ] **Шаг 4: выполнить race-check и merge**

Непосредственно перед merge проверить SHA головы и базы `PR`. Merge разрешён только для этой точной головы.

- [ ] **Шаг 5: проверить точный SHA после merge**

Для push-`CI` требуются:

```text
validate = SUCCESS
smoke-pack = SUCCESS
```

Только после этого считать C3.3d3 принятой, синхронизировать #409/#398/#374/#370 и оставить общую C3.3 открытой для аудита интеграции.
