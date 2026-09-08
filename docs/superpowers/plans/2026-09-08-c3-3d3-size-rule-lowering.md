# C3.3d3 — план реализации сведения `size_rules`

> **Для агентных исполнителей:** выполнять задачи последовательно с использованием `superpowers:subagent-driven-development` или `superpowers:executing-plans`. Флажки (`- [ ]`) отражают порядок работ.

**Цель:** удалить выделенный рантайм и вычислитель `size_rules`, сохранив только фронтенд политики и сведя поддерживаемую семантику к каноническим скалярным фактам и существующему отношению `numeric_bound`.

**Архитектура:** состояние репозитория измеряется универсальным селектором `repository.path_metric`; рост диффа — существующим `diff.metric`, расширенным ограничением по путям и `net_files`. Новые виды отношений, новые источники `FactRef`, второй вычислитель и второй `FactStore` запрещены.

**Спецификация:** `docs/superpowers/specs/2026-09-08-c3-3d3-size-rule-lowering.md`

## Глобальные ограничения

- Принятая база: `9ff00319f9828261ff997796bdb906b95e7a281f`.
- Ответственная issue: #409; родительская: #398.
- `FactRef models = 1`.
- `FactRef sources = 4`.
- `relation descriptors = 10`.
- Новый вид отношения не вводится.
- Новый источник `FactRef` не вводится.
- Второй вычислитель и второй `FactStore` не вводятся.
- Псевдонимы совместимости не вводятся.
- Итоговые виды рантайма строго: `integration`, `primitive_relation`.
- Последовательность `RED-first` обязательна.
- #398 и #374 в D3 не закрывать.

---

## Задача 1: контракт D3 в состоянии `RED`

**Создать:** `tests/test-c3-3d3-size-rule-lowering.mjs`.

- [ ] Проверить через реальное поведение, а не текст исходников:

```text
A. supported file rule -> primitive_relation/numeric_bound + repository.path_metric
B. directory absolute rule -> primitive_relation/numeric_bound + repository.path_metric
C. directory growth rule -> primitive_relation/numeric_bound + scoped diff.metric
D. mixed directory rule -> separate state and transaction primitives
E. advisory -> generic metadata, no size-rules-advisory topology
F. unreadable selected repository content -> fail closed
G. runtime kinds exclude size_rules
H. relation descriptors = 10; FactRef sources = 4
```

- [ ] Использовать минимальные `trackedFiles`, нормализованный дифф и `readFile`, включая один нечитаемый совпавший файл.
- [ ] Запустить:

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
```

Ожидание: `FAIL` на принятой базе из-за отсутствующего сведения.

- [ ] Закоммитить только тест:

```bash
git add tests/test-c3-3d3-size-rule-lowering.mjs
git commit -m "test(c3.3d3): add size-rule lowering falsifier"
```

---

## Задача 2: каноническое получение скалярных фактов

**Изменить:** `src/document-facts.mts`.  
**Дополнительно только при реальной необходимости:** `src/diff/classification.mts`.

Форма нового селектора внутри существующего источника репозитория:

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

Расширение существующего `diff.metric`:

```text
metric = new_docs | new_files | net_added_lines | net_files
patterns?: string[]
exclude_paths?: string[]
```

- [ ] Реализовать `repository.path_metric` без знаний о `size_rules`, лимитах, `ChangeIntent` и фазах исполнения.
- [ ] Для `population=tracked` использовать `facts.trackedFiles`.
- [ ] Для `population=changed` использовать текущие изменённые пути, пересечённые с текущими отслеживаемыми путями.
- [ ] `patterns` включает совпавшие пути; `exclude_paths` исключает их.
- [ ] Для `metric=files` содержимое не читать; значение пути равно `1`.
- [ ] Для `lines` считать строки текущего файла; для `bytes` — размер текущего содержимого в байтах.
- [ ] Для `aggregate=max` пустое множество даёт `0`; для `sum` — сумму измерений.
- [ ] Нечитаемый выбранный файл для `lines`/`bytes` должен давать структурированную ошибку чтения факта, а не пропускаться.
- [ ] Для `net_files`: добавленный файл `+1`, удалённый `-1`, изменённый `0` после ограничения по путям.
- [ ] Проверить:

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
node tests/test-document-facts-boundary.mjs
node tests/test-canonical-relation-kernel.mjs
```

Фокусный D3-тест после этого шага ещё может оставаться `RED` на компиляторе/рантайме; тесты канонических фактов должны быть `PASS`.

---

## Задача 3: сведение `size_rules` в `Constraint Program`

**Изменить:**

```text
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
```

- [ ] Для выбранных через `applies_to_change_types` правил выдавать:

```text
file absolute -> repository.path_metric(max) -> numeric_bound(max)
directory absolute -> repository.path_metric(sum) -> numeric_bound(max)
directory growth lines -> diff.metric(net_added_lines, scoped) -> numeric_bound(max_growth)
directory growth files -> diff.metric(net_files, scoped) -> numeric_bound(max_growth)
```

- [ ] Для абсолютных ограничений по всем отслеживаемым файлам использовать фазу `state`.
- [ ] Для `changed_only` и роста использовать фазу `transaction`.
- [ ] Смешанное правило каталога с `max` и `max_growth` выдаёт два независимых ограничения.
- [ ] Не выдавать `kind=size_rules`.
- [ ] Удалить из `constraints.mts` выделенный `size_rules` dispatch, `projectSizeRules(...)`, импорт/вызов `checkSizeRules` и специальный результат `size-rules-advisory`.
- [ ] Рекомендательный режим переносить как универсальную метаинформацию `advisory=true` результата примитива.
- [ ] Проверить:

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
node tests/test-execution-phases.mjs
node tests/test-pipeline.mjs
node tests/test-rule-registry.mjs
```

Устаревшие проверки удалённой топологии мигрировать только после фактического падения; рабочую логику ради них не восстанавливать.

---

## Задача 4: ограничить публичную поверхность схемой

**Изменить:**

```text
schemas/repo-policy.schema.json
tests/validate-schemas.mjs
```

`examples/size-rules-policy.json` менять только при необходимости.

- [ ] Сначала отдельным `RED`-тестом схемы доказать, что следующие формы сейчас ошибочно допускаются:

```text
file + metric=files
file + max_growth
directory + bytes + max_growth
directory + count=changed_only
```

- [ ] Одновременно зафиксировать допустимые примеры:
  - файл с `lines`;
  - файл с `bytes` и `changed_only`;
  - каталог с ростом `lines`;
  - каталог с ростом `files`;
  - каталог с абсолютным `bytes`.
- [ ] Запустить `node tests/validate-schemas.mjs` и наблюдать ожидаемый `RED`.
- [ ] Сузить только `definitions.size_rule` через структурный `oneOf` или условия; полей совместимости не добавлять.
- [ ] Повторно запустить `node tests/validate-schemas.mjs`; ожидание — `PASS`.

---

## Задача 5: физически удалить выделенный вычислитель

**Удалить:** `src/checks/rules/size-rules.mts` и генерируемый `dist/checks/rules/size-rules.mjs` через стандартный процесс сборки.

Вероятные исторические потребители:

```text
tests/test-compression-rules.mjs
tests/test-execution-phases.mjs
tests/test-pipeline.mjs
tests/test-rule-registry.mjs
```

- [ ] Не выполнять массовую миграцию заранее: исправлять только первый фактически упавший потребитель.
- [ ] Не сохранять экспорт `checkSizeRules`.
- [ ] Не сохранять совместимые интерфейсы `size_violations[]`, `growth[]`, `size-rules-advisory`.
- [ ] Если исторический транзакционный тест использует недопустимое `directory + changed_only`, заменить его допустимым `file + changed_only`, не восстанавливая старую семантику.
- [ ] Регенерировать `dist` стандартной командой из `package.json`.
- [ ] Проверять по одному падению:

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
node tests/test-compression-rules.mjs
node tests/test-execution-phases.mjs
node tests/test-pipeline.mjs
node tests/test-rule-registry.mjs
```

---

## Задача 6: зафиксировать инварианты сжатия

- [ ] Проверить физическое отсутствие вычислителя `size-rules` в исходниках и `dist`.
- [ ] Проверить точный словарь видов рантайма:

```text
integration
primitive_relation
```

- [ ] Проверить `relation descriptors = 10`.
- [ ] Проверить `FactRef sources = 4`.
- [ ] Проверить свежесть `dist` и метрики сжатия точными командами из `package.json`.
- [ ] Запустить полный обнаруживаемый набор тестов:

```bash
node tests/run.mjs
```

Ожидание: все тестовые файлы `GREEN`.

---

## Задача 7: черновой `PR`, точное ревью, `Ready`, слияние

- [ ] `PR` #410 остаётся черновым до полного `GREEN` чернового прогона.
- [ ] В описании `PR` зафиксировать `Fixes #409`, точную принятую базу, evidence `RED`, семантические срезы, значения инвариантов и то, что #398/#374 остаются открытыми.
- [ ] На точной голове проверить весь diff: отсутствие скрытого вычислителя размера, второго `FactStore`, новых видов отношений/источников и псевдонимов совместимости.
- [ ] После полного чернового `GREEN` перевести `PR` в `Ready`.
- [ ] На точной голове `Ready` требовать:

```text
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

- [ ] Непосредственно перед слиянием проверить точные `SHA` головы и базы и отсутствие гонки.
- [ ] Сливать только проверенную точную голову.
- [ ] После слияния требовать на точном `SHA` merge-коммита:

```text
validate = SUCCESS
smoke-pack = SUCCESS
```

Только после этого считать C3.3d3 принятой, синхронизировать #409/#398/#374/#370 и оставить общую C3.3 открытой для аудита интеграции.
