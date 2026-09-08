# C3.3d — план реализации сжатия оставшегося исполняемого хвоста

> **Для исполнителя:** перед рабочими изменениями обязателен навык `test-driven-development`, перед завершением каждого среза — `verification-before-completion`. Каждый срез выполняется отдельным запросом на слияние от фактически принятого `main`.

**Цель:** убрать самостоятельные исполняемые виды `surface_debt`, `registry_rules`, `change_profile`, `size_rules`, сохранив полезные возможности только как чистое разворачивание в канонические факты и существующую алгебру отношений.

**Архитектура:** после `compileConstraintProgram` семантика должна течь через один `FactRef`, десять канонических дескрипторов и один исполнитель `primitive_relation`. C3.3d не меняет `integration`.

Связанные задачи:

```text
#370 — Architecture Compression 3.0
#374 — C3.3 historical-family lowering
#398 — C3.3d runtime-tail convergence
#400 — C3.3d1 delete surface_debt + registry_rules
```

Утверждённый проект:

```text
docs/superpowers/specs/2026-09-08-c3-3d-runtime-tail-convergence-design.md
```

Исходное принятое состояние:

```text
main = 712ebec3d8040b42b0cf7ff4f0eaf9ed78fa0f35
C3.0 baseline = 92432809fcddc290080beb51ba151e13a5761869
runtime kinds = 6
```

Целевой храповик:

```text
C3.3d1: 6 -> 4
C3.3d2: 4 -> 3
C3.3d3: 3 -> 2

final:
integration
primitive_relation
```

На всём пути:

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
new relation descriptors = 0
```

## Общий протокол каждого среза

1. Перечитать точный `main`, родительскую и дочернюю задачи, открытые запросы на слияние.
2. Создать ветку только от принятого `main`.
3. Первый коммит — только целевой красный тест.
4. Зафиксировать в дочерней задаче точную ожидаемую причину красного `CI`.
5. Сделать минимальное рабочее изменение; `dist` получать обычной сборкой.
6. После целевого зелёного результата мигрировать исторические тесты.
7. Выполнить полный набор:

```bash
npm run build
npm run check:dist
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

8. Держать запрос на слияние черновиком до полного зелёного состояния.
9. Перевести в готовое состояние без изменения головы; получить успешные `validate`, `smoke-pack`, `Run PR policy check` на одной голове.
10. Слить только точную проверенную голову и проверить полный `CI` на новом `main`.
11. Только после этого создавать следующую дочернюю задачу и ветку.

Если утверждённая семантика требует нового источника фактов, нового дескриптора или второго исполнителя, остановиться на красном доказательстве и обновить #398; архитектуру молча не расширять.

---

# I. C3.3d1 — удалить `surface_debt` и `registry_rules`

## 1. Красный архитектурный тест

Создать:

```text
tests/test-c3-3d1-runtime-tail-deletion.mjs
```

До рабочих изменений зафиксировать остаток:

```bash
git grep -n -I -E 'surface_debt|surface-debt|registry_rules|registry-rules|checkSurfaceDebt|checkRegistryRules|RegistryRule' -- ':!dist/**'
```

Тест обязан утверждать конечное состояние:

```text
ChangeIntent schema rejects surface_debt
repo-policy schema rejects registry_rules
compiled program emits neither kind
runtime union/dispatch contains neither kind
src/checks/rules/registry-rules.mts absent
dist/checks/rules/registry-rules.mjs absent after build
self repo-policy consumes neither concept
runtime kinds exactly change_profile,size_rules,integration,primitive_relation
relation descriptors exactly 10
FactRef sources exactly change_intent,diff,document,repository
```

Проверки схем должны использовать валидный базовый объект плюс одно удаляемое поле, а не текстовый поиск.

До удаления первые архитектурные утверждения должны быть красными, последние инварианты — зелёными.

```bash
node tests/test-c3-3d1-runtime-tail-deletion.mjs
npm test
```

Коммит содержит только новый тест:

```text
test(c3.3d1): falsify runtime-tail deletion
```

Зафиксировать красный `CI` в #400.

## 2. Удалить `surface_debt`

Изменить:

```text
schemas/change-intent.schema.json
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
dist/checks/constraint-program.mjs
dist/checks/rules/constraints.mjs
```

Удалить:

```text
ChangeIntent.surface_debt
surface_debt schema property
surface_debt from ChangeIntentProjection
runtime emission surface-debt
SurfaceDebt interface
surface_debt from RuntimeConstraintKind
surface_debt from CONSTRAINT_PHASES
debt field
checkSurfaceDebt
surface_debt dispatch
calculateDiffGrowth import if it becomes unused
```

`additionalProperties: false` должен сам отвергать старую форму. Не добавлять пометки устаревания, псевдонимы и отдельную совместимость. Не менять `GovernanceGrant`, `diff_rules` и обычные бюджеты.

## 3. Удалить `registry_rules`

Изменить/удалить:

```text
schemas/repo-policy.schema.json
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
src/checks/rules/registry-rules.mts  DELETE
dist/checks/rules/registry-rules.mjs DELETE
```

Удалить:

```text
top-level registry_rules
registry_source and definitions used only by registry_rules
registry_rules from ConstraintPolicyProjection
runtime:registry-rules emission
checkRegistryRules import/dispatch
registry_rules RuntimeConstraintKind/phase
```

Перед удалением определений схемы подтвердить отсутствие других ссылок поиском. `markdown_section_links` в новый селектор не переносить. Новую обёртку вокруг `compareSets` не создавать.

Собрать и проверить:

```bash
npm run build
npm run check:dist
node tests/test-c3-3d1-runtime-tail-deletion.mjs
node tests/test-c3-3-historical-lowering.mjs
node tests/test-c3-3b-trace-anchor-lowering.mjs
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
node tests/test-canonical-relation-kernel.mjs
```

Рабочий коммит:

```text
refactor(c3.3d1): delete debt and registry runtimes
```

## 4. Мигрировать исторические тесты

Проверить минимум:

```text
tests/validate-schemas.mjs
tests/test-change-intent.mjs
tests/test-policy-compiler-boundary.mjs
tests/test-policy-delta-rules.mjs
tests/test-compression-rules.mjs
tests/test-execution-phases.mjs
tests/test-structured-output.mjs
tests/test-rule-registry.mjs
tests/test-enforcement-mode.mjs
README.md
examples/**
```

Поиск:

```bash
git grep -n -I -E 'surface_debt|surface-debt|registry_rules|registry-rules|checkSurfaceDebt|checkRegistryRules|markdown_section_links|set_equality' -- tests README.md examples schemas src
```

Удалить поведенческие тесты удалённых исполнителей; оставить отрицательные проверки:

```text
surface_debt rejected
registry_rules rejected
```

Не создавать пользовательскую документацию «устарело». Если #35 относится только к `surface_debt`, после принятия d1 закрыть её как поглощённую удалением концепта.

Тестовый коммит:

```text
test(c3.3d1): enforce deleted public concepts
```

## 5. Приёмка d1

Метрики должны дать:

```text
runtime_constraint_kinds = 4
runtime_constraint_kind_names = change_profile,integration,primitive_relation,size_rules
relation descriptors = 10
FactRef sources = 4
```

`repo-policy.json`, `.github/**`, `action.yml` и семантика `integration` в d1 не меняются. После общего протокола приёмки записать в #398 контрольную точку `6 -> 4`.

---

# II. C3.3d2 — чистое разворачивание `change_profiles`

## 1. Открыть работу только после принятого d1

Создать дочернюю задачу:

```text
[C3.3d2] Pure-lower change profiles into canonical diff relations
```

Зафиксировать новый точный `main` и цель:

```text
runtime kinds 4 -> 3
remaining = size_rules,integration,primitive_relation
relation descriptors = 10
FactRef sources = 4
new selector = NONE
```

Новая ветка и новый черновой запрос на слияние создаются только от этого принятого `main`.

## 2. Красный тест эквивалентности

Создать:

```text
tests/test-c3-3d2-change-profile-lowering.mjs
```

Тест строит политику и `ChangeIntent`, вызывает каноническую компиляцию/оценку и проверяет минимум:

```text
allowed surface passes
forbidden surface fails
required surface present/missing
overlapping allowed+disallowed surface fails
unclassified checked only when surface constraints exist
allow_unclassified_surfaces=true permits unclassified
new allowed/disallowed class
empty allow_classes forbids touched declared classes
unclassified new file fails when new_files exists
max_per_class
new_files.max_new_files
profile max_new_docs with canonical_docs exclusion
profile max_new_files
profile max_net_added_lines
governance emits no profile constraints
missing change_type fails closed
unknown non-governance change_type fails closed
unknown surface/class reference fails compilation
runtime contains no change_profile
change-profiles evaluator absent after implementation
relation descriptors = 10
FactRef sources = 4
```

Первый коммит содержит только этот тест:

```text
test(c3.3d2): falsify change-profile lowering
```

## 3. Типизированное представление и выбор профиля

Основной файл:

```text
src/checks/constraint-program.mts
```

При необходимости только ссылочную проверку менять в:

```text
src/policy-compiler.mts
```

Заменить `change_profiles?: unknown` минимальными типизированными представлениями профиля, блока `new_files`, `surfaces`, `new_file_classes`; добавить `change_type?: string`, если его нет после d1.

Использовать только существующие факты и отношение:

```text
diff.changed_paths(patterns, mode, exclude_statuses)
diff.metric(new_docs|new_files|net_added_lines)
numeric_bound(min|max)
```

Не добавлять селектор или дескриптор.

Правила выбора:

```text
no change_profiles -> no profile constraints
change_type=governance -> no ordinary profile constraints
profiles + missing change_type -> compile-time blocking error
unknown non-governance change_type -> compile-time blocking error
```

Отдельного исполняемого вида для этих ошибок не создавать.

## 4. Развернуть поверхности

Для каждой `forbid_surfaces`:

```text
diff.changed_paths(surface patterns, exclude deleted)
  -> numeric_bound(max=0)
```

Для каждой `require_surfaces`:

```text
diff.changed_paths(surface patterns, exclude deleted)
  -> numeric_bound(min=1)
```

Для `allow_surfaces` создать отдельный запрет для каждой объявленной поверхности, которой нет в разрешённом наборе. Это сохраняет семантику пересечений; проверка «входит хотя бы в одну разрешённую» запрещена.

`allow_unclassified_surfaces=false` действует только если задано хотя бы одно из:

```text
require_surfaces
allow_surfaces
forbid_surfaces
```

Тогда:

```text
diff.changed_paths(
  patterns = union(all surface patterns),
  mode = outside,
  exclude deleted
)
  -> numeric_bound(max=0)
```

## 5. Развернуть новые файлы

Текущий `DiffFileStatus`:

```text
modified
added
deleted
```

Поэтому только добавленные файлы выбираются существующим:

```text
exclude_statuses = modified,deleted
```

Для каждого класса вне `allow_classes`:

```text
added paths matching class
  -> numeric_bound(max=0)
```

Неклассифицированный новый файл:

```text
diff.changed_paths(
  patterns = union(all new-file class patterns),
  mode = outside,
  exclude_statuses = modified,deleted
)
  -> numeric_bound(max=0)
```

`max_per_class[class]`:

```text
added paths matching class
  -> numeric_bound(max=configured limit)
```

`new_files.max_new_files`:

```text
diff.metric(new_files)
  -> numeric_bound(max=configured limit)
```

## 6. Развернуть бюджеты профиля

Переиспользовать верхнеуровневые метрики:

```text
max_new_docs -> diff.metric(new_docs, exclude_paths=canonical_docs)
max_new_files -> diff.metric(new_files)
max_net_added_lines -> diff.metric(net_added_lines)
```

Все через `numeric_bound(max=...)`. Не дублировать подсчёты и не использовать `classifyNewFiles`/`detectTouchedSurfaces` как отдельный семантический исполнитель.

## 7. Удалить отдельный `change_profile`

Изменить/удалить:

```text
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
src/checks/rules/change-profiles.mts DELETE
dist/checks/rules/change-profiles.mjs DELETE
```

Удалить:

```text
runtime:change-profile emission
checkChangeProfile import
change_profile RuntimeConstraintKind
change_profile phase/dispatch
```

`facts.derived` удалять глобально нельзя без отдельного доказательства отсутствия потребителей.

Сборка и целевой тест:

```bash
npm run build
npm run check:dist
node tests/test-c3-3d2-change-profile-lowering.mjs
```

Рабочий коммит:

```text
refactor(c3.3d2): lower change profiles into relations
```

## 8. Мигрировать старые тесты и принять d2

Основные тесты:

```text
tests/test-policy-profiles.mjs
tests/test-compression-rules.mjs
tests/test-policy-compiler-boundary.mjs
tests/test-execution-phases.mjs
tests/test-structured-output.mjs
tests/test-self-hosting.mjs
tests/test-governance-paths.mjs
```

Удалить прямые импорты `checkChangeProfile`; полезные случаи перенести на `compileConstraintProgram` и канонические результаты отношений. Старую форму диагностического объекта контрактом не считать.

`repo-policy.json` не переписывать: его пять `change_profiles` должны пройти самопроверку через новое разворачивание.

Поиск:

```bash
git grep -n -I -E 'checkChangeProfile|change_profile|change-profiles.mjs' -- tests src dist
```

После миграции `change_profiles` допустим как публичный синтаксис; отдельный исполняемый `change_profile` запрещён.

Цель метрик:

```text
runtime_constraint_kinds = 3
runtime_constraint_kind_names = integration,primitive_relation,size_rules
relation descriptors = 10
FactRef sources = 4
```

После общего протокола приёмки записать контрольную точку в #398.

---

# III. C3.3d3 — `size_rules` через канонические факты

## 1. Открыть d3 только после принятого d2

Создать дочернюю задачу:

```text
[C3.3d3] Lower size rules through canonical repository and diff facts
```

Зафиксировать новый `main` и цель:

```text
runtime kinds 3 -> 2
remaining = integration,primitive_relation
relation descriptors = 10
FactRef sources = 4
RepositoryFactSelector may grow by at most one finite kind, only if RED proves need
```

Новая ветка создаётся только от принятого d2.

## 2. Красный тест сначала доказывает необходимость получения факта

Создать:

```text
tests/test-c3-3d3-size-rule-lowering.mjs
```

Группа чтения фактов должна проверить возможность получить:

```text
tracked file line max
tracked file byte max
directory sum lines
directory file count
ignore patterns
changed-only file population
empty selected set -> deterministic zero
matching unreadable file -> fail closed
```

Сначала попытаться выразить это текущим `FactRef`. Только доказанная невозможность получить числовой факт текущего состояния разрешает `repository.path_metric`.

Группа разворачивания должна проверить:

```text
file lines absolute pass/fail
directory lines absolute pass/fail
file count absolute pass/fail
ignore patterns
file changed_only
applies_to_change_types selected/not-selected
state phase for unconditional all_tracked absolute max
transaction phase for max_growth
transaction phase for applies_to_change_types
transaction phase for file changed_only
line growth pass/fail
file-count growth pass/fail
negative max_growth
advisory non-blocking
blocking blocking
measurement failure fail-closed
metric=files + file scope rejected before runtime
max_growth + file scope rejected before runtime
max_growth + bytes rejected before runtime
directory + changed_only rejected unless simple existing expression is proven
no size_rules runtime kind
no size-rules evaluator after implementation
```

Первый коммит — только тест:

```text
test(c3.3d3): falsify size-rule lowering
```

## 3. Если красный доказал необходимость — добавить один `repository.path_metric`

Основной файл:

```text
src/document-facts.mts
```

`src/facts/input.mts` менять только если существующий контекст чтения действительно не даёт нужных данных.

Допустимый конечный тип:

```ts
export type RepositoryFactSelector =
  | { kind: "anchor_values"; anchor_type: string }
  | {
      kind: "path_metric";
      patterns: readonly string[];
      ignore?: readonly string[];
      population: "tracked" | "changed";
      metric: "lines" | "bytes" | "files";
      aggregate: "max" | "sum";
    };
```

Вариант `repository` в `FactRef` должен оставаться конечным дискриминируемым объединением:

```text
anchor_values -> string_set
path_metric -> scalar
```

Не ослаблять тип до произвольного значения.

Семантика:

```text
population=tracked -> current tracked non-deleted paths
population=changed -> current changed non-deleted paths
metric=files -> count without reading contents
metric=lines|bytes -> every selected file must be readable
read failure -> fail closed
sum(empty) = 0
max(empty) = 0
```

Использовать существующие утилиты сопоставления путей. Маленькую чистую функцию подсчёта строк можно перенести из удаляемого исполнителя в каноническую границу; новую подсистему размеров не создавать.

Целевые проверки:

```bash
node tests/test-document-facts-boundary.mjs
node tests/test-c3-3d3-size-rule-lowering.mjs
```

Отдельный коммит получения факта:

```text
refactor(c3.3d3): add canonical repository path metric
```

Если тест закрывается без `path_metric`, этот шаг пропустить и зафиксировать отсутствие нового селектора в d3.

## 4. Расширить `diff.metric` только при доказанной необходимости

Текущие метрики:

```text
new_docs
new_files
net_added_lines
```

Сначала попытаться переиспользовать их и факты изменённых путей. Если рост по выбранной области иначе не выражается, допускается расширить существующий селектор:

```ts
patterns?: readonly string[];
ignore?: readonly string[];
```

и конечным именем:

```text
net_files
```

`net_files = added - deleted` на выбранной поверхности. `net_added_lines` с `patterns/ignore` считает дельту строк только выбранных файлов. Верхнеуровневые бюджеты без этих полей должны сохранить прежнюю семантику.

Новый источник `diff` или отдельная подсистема снимков запрещены.

## 5. Сузить публичную схему `size_rule`

Изменить:

```text
schemas/repo-policy.schema.json
tests/validate-schemas.mjs
```

До исполнения отвергать:

```text
scope=file + metric=files
scope=file + max_growth
metric=bytes + max_growth
scope=directory + count=changed_only
```

Последнюю форму сохранять только если красный тест докажет простое выражение существующими фактами/отношениями без условного режима получения фактов. Исходное решение — отвергать.

Сохранить текущие допустимые числовые диапазоны, включая отрицательный `max_growth`, если он уже разрешён. Псевдонимы совместимости не добавлять.

## 6. Развернуть абсолютные ограничения

В `src/checks/constraint-program.mts` сохранить модель строгости `size_rule`, но runtime строить как отношения.

Для `scope=file`:

```text
repository.path_metric(
  population = all_tracked ? tracked : changed,
  metric = lines|bytes,
  aggregate = max,
  patterns = rule glob,
  ignore = operational_paths + rule.ignore
)
  -> numeric_bound(max=rule.max)
```

Для `scope=directory`:

```text
repository.path_metric(
  population = tracked,
  metric = lines|bytes|files,
  aggregate = sum,
  patterns = rule glob,
  ignore = operational_paths + rule.ignore
)
  -> numeric_bound(max=rule.max)
```

Фазы:

```text
unconditional all_tracked absolute -> state
applies_to_change_types match -> transaction
file changed_only -> transaction
```

Если `applies_to_change_types` не содержит текущий `change_type`, отношение не создавать.

## 7. Развернуть рост

Для каждого `max_growth` создать отдельную `primitive_relation` фазы `transaction`:

```text
lines -> scoped diff.metric(net_added_lines)
files -> scoped diff.metric(net_files)
      -> numeric_bound(max=rule.max_growth)
```

Для истинности не создавать специальные объекты `before/after/delta`; каноническая диагностика показывает фактическое значение, предел и происхождение `size_rule:<id>`.

## 8. Сделать `advisory` общей метаинформацией

Сначала проверить принятое d2: если общий путь уровня/происхождения уже существует, переиспользовать его. Иначе минимально добавить к исполняемой записи:

```ts
level?: "blocking" | "advisory";
origin?: string;
```

`level` не является параметром `evaluatePrimitiveRelation`. Одно и то же отношение вычисляется одинаково; общий слой отчётности решает, блокирует ли нарушение код выхода.

Добавить тест, где одно ложное отношение при `blocking` блокирует, а при `advisory` остаётся нарушением без блокирующего выхода.

## 9. Удалить отдельный `size_rules`

Изменить/удалить:

```text
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
src/checks/rules/size-rules.mts DELETE
dist/checks/rules/size-rules.mjs DELETE
```

Удалить:

```text
SizeRule import
checkSizeRules import
projectSizeRules
size_rules RuntimeConstraintKind
size_rules fixed phase/dispatch
size-rules-advisory special branch
```

После этого:

```ts
type RuntimeConstraintKind =
  | "integration"
  | "primitive_relation";
```

Сборка и целевой тест:

```bash
npm run build
npm run check:dist
node tests/test-c3-3d3-size-rule-lowering.mjs
```

## 10. Мигрировать старые тесты и принять C3.3d

Основные места:

```text
tests/test-compression-rules.mjs
tests/test-execution-phases.mjs
tests/test-policy-delta-rules.mjs
tests/test-self-hosting.mjs
tests/test-structured-output.mjs
tests/test-pipeline.mjs
tests/validate-schemas.mjs
examples/size-rules-policy.json
README.md
```

Удалить прямой импорт `checkSizeRules`; полезные случаи перенести на каноническую программу. Проверки строгости ослабления `max`, `level`, `count`, `max_growth` сохранить.

Собственная `repo-policy.json` должна остаться семантически прежней, если её три правила входят в сохраняемый поднабор. Если одна собственная форма требует удаления, остановиться и зафиксировать расхождение в #398; молча менять self-policy нельзя.

Поиск:

```bash
git grep -n -I -E 'checkSizeRules|size_rules|size-rules.mjs|changed_only|max_growth' -- tests examples README.md src dist repo-policy.json
```

Финальная архитектурная проверка:

```text
runtime_constraint_kinds = 2
runtime_constraint_kind_names = integration,primitive_relation
relation descriptors = 10
FactRef sources = 4
FactRef models = 1
primitive descriptor registries = 1
surface_debt absent public/runtime
registry_rules absent public/runtime
change_profile dedicated runtime absent
size_rules dedicated runtime absent
registry/change-profile/size evaluator files absent
integration unchanged
```

Если `repository.path_metric` добавлен, `RepositoryFactSelector` имеет ровно:

```text
anchor_values
path_metric
```

После общего протокола приёмки закрыть d3 и #398, затем обновить #374:

```text
C3.3d accepted:
surface_debt deleted
registry_rules deleted
change_profiles pure-lowered
size_rules pure-lowered
runtime kinds 6 -> 2
relation descriptors = 10
FactRef sources = 4
next = C3.3e integration / parallel convergence audit
```

---

# Запреты C3.3d

Ни один срез не добавляет:

```text
new FactRef source
new relation descriptor
second evaluator
second FactStore
arbitrary expression language
compatibility alias
legacy runtime path
methodology-specific canonical primitive
integration semantic redesign
parallel/control-plane redesign
```

`repository.path_metric` — единственное заранее допустимое потенциальное расширение словаря селекторов и только после красного доказательства d3.

# Документный бюджет

В #399 создаются ровно два документа:

```text
docs/superpowers/specs/2026-09-08-c3-3d-runtime-tail-convergence-design.md
docs/superpowers/plans/2026-09-08-c3-3d-runtime-tail-convergence.md
```

Третий итоговый документ не создавать. Доказательства хранить в #398, дочерних задачах, запросах на слияние и этих двух документах.