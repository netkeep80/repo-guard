# C3.3d — сжатие оставшегося исторического runtime-хвоста

Статус: утверждённый в чате архитектурный дизайн для #398; до реализации требуется отдельный review этого письменного документа.

Связанные задачи:

```text
#370 — Architecture Compression 3.0
#374 — C3.3 historical-family lowering
#398 — C3.3d runtime-tail convergence
```

Исходное принятое состояние:

```text
main = 712ebec3d8040b42b0cf7ff4f0eaf9ed78fa0f35
canonical C3.0 measurement baseline = 92432809fcddc290080beb51ba151e13a5761869
```

## 1. Цель

После C3.3c в исполняемой программе ограничений остаются шесть видов `runtime constraint`:

```text
surface_debt
size_rules
registry_rules
change_profile
integration
primitive_relation
```

C3.3d должен убрать первые четыре как самостоятельные семантические пути.

Итог C3.3d:

```text
integration
primitive_relation
```

`integration` намеренно остаётся отдельным историческим хвостом. Его дальнейшая судьба относится к следующему C3.3e и не должна смешиваться с этой работой.

Главный критерий — не уменьшить число строк само по себе, а добиться следующей формы:

```text
high-level policy syntax
        ↓
finite typed acquisition
        ↓
one canonical FactRef model
        ↓
finite relation algebra
        ↓
one primitive semantic evaluator
```

Если возможность не имеет доказанной ценности и её сохранение требует нового специального языка, селектора или исполнителя, предпочтительно удалить возможность.

Порядок решений:

```text
remove
  > reuse existing canonical facts/relations
  > add one small typed acquisition primitive if RED proves necessity
  > add subsystem
```

Последний вариант в C3.3d запрещён.

## 2. Неподвижные архитектурные границы

После C3.3d должны выполняться следующие инварианты:

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
primitive semantic runtime kinds = 1
runtime constraint kinds = 2
new relation primitive = NONE
```

Четыре источника `FactRef` остаются:

```text
change_intent
diff
document
repository
```

Запрещено добавлять:

```text
new FactRef source
new relation descriptor
second evaluator
compatibility alias
arbitrary expression language
transitional runtime path surviving merge
```

Допустимое расширение словаря фактов только одно и только при доказанной необходимости в C3.3d3:

```text
RepositoryFactSelector.anchor_values
+ RepositoryFactSelector.path_metric
```

Само наличие этого пункта не является разрешением добавить `path_metric` заранее. Сначала должен существовать RED, который невозможно корректно закрыть существующим словарём.

## 3. Уровень требуемой эквивалентности

Для сохраняемых возможностей C3.3d сохраняет семантическое решение:

```text
pass / fail
blocking / advisory
transaction / state applicability
fail-closed conditions
```

Не требуется сохранять побайтно прежний диагностический объект, старые имена внутренних результатов или historical aggregation shape.

Причина: сохранение старой формы отчёта не должно вынуждать оставить старый evaluator.

Канонический relation result обязан сохранять достаточную диагностику:

```text
source fact provenance
actual value or selected values
bound / expected relation
rule or lowering origin metadata
read/evaluation failure
```

Высокоуровневое происхождение ограничения может переноситься как обычная метаинформация compiled entry. Оно не даёт отдельной семантики.

## 4. Почему работа разбита на три принимаемых среза

Четыре исторических вида `runtime` имеют разную природу:

- `surface_debt` — самостоятельная декларация в `ChangeIntent`, но не источник полномочий;
- `registry_rules` — отдельный публичный язык для сравнения множеств;
- `change_profile` — полезный высокоуровневый пакет, активно используемый self-policy;
- `size_rules` — полезная capability, которой действительно требуется repository-state measurement.

Смешивание их в одном большом PR затруднит доказательство причины каждого изменения и позволит случайно сохранить ненужный специальный путь.

Поэтому C3.3d состоит из трёх последовательных принимаемых срезов:

```text
C3.3d1: delete surface_debt + registry_rules
C3.3d2: pure-lower change_profiles
C3.3d3: lower size_rules through canonical facts
```

Каждый срез имеет собственный RED-first PR, собственный точный head и post-merge проверку.

## 5. C3.3d1 — удалить `surface_debt`

### 5.1. Наблюдаемая текущая семантика

`surface_debt` объявляется в `ChangeIntent` и содержит:

```text
kind = temporary_growth
reason
expected_delta.max_new_files?
expected_delta.max_net_added_lines?
repayment_issue
```

Отдельный `checkSurfaceDebt` возвращает диагностическое состояние, например:

```text
undeclared
declared
declared_debt_exceeded
```

При этом отсутствие `surface_debt` не запрещает изменение само по себе. Обычные бюджеты продолжают проверяться отдельно.

Следовательно, `surface_debt` не является:

- доверенным разрешением;
- заменой `GovernanceGrant`;
- способом ослабить `diff_rules`;
- необходимым входом relation kernel.

Это отдельный исторический диагностический путь.

### 5.2. Решение

Удалить без замены:

```text
ChangeIntent.surface_debt
surface_debt schema
checkSurfaceDebt
surface_debt runtime kind
surface_debt dispatch
surface_debt tests/docs
```

Не создавать:

```text
debt relation
debt FactRef source
debt compatibility alias
```

Если в будущем понадобится формальная временная санкция на рост, она должна проектироваться как отдельная доверенная governance-модель, а не восстанавливать этот диагностический объект.

## 6. C3.3d1 — удалить `registry_rules`

### 6.1. Наблюдаемая текущая форма

`registry_rules` содержит собственный язык источников:

```text
json_array
markdown_section_links
```

и собственный язык отношений:

```text
set_equality
left_subset_of_right
right_subset_of_left
```

Исполнитель читает оба источника, нормализует ссылки и затем вызывает существующее сравнение множеств.

Уже существует архитектурный дрейф: публичная схема использует имя `set_equality`, а внутренний тип исполнителя — `equal`; equality продолжает работать через fallback-ветку. Это показатель случайной совместимости, а не канонического контракта.

### 6.2. Решение

Удалить без legacy-слоя:

```text
repo-policy.registry_rules
registry schema vocabulary
checkRegistryRules
registry_rules runtime kind
registry runtime dispatch
registry-specific source types
registry-specific tests/docs/examples
```

JSON/YAML сравнения должны выражаться существующей формой:

```text
document_relations
  + document FactRef
  + set_equal / set_subset
```

Отдельную поддержку `markdown_section_links` не переносить автоматически.

Причина: её сохранение потребует нового универсального markdown-selector vocabulary только ради historical surface, а self-policy не доказывает такую необходимость.

Если реальный consumer позже предъявит use case, он должен стать новым falsifier для generic document acquisition, а не причиной сохранить старый `registry_rules` DSL.

### 6.3. Цель среза

После C3.3d1:

```text
runtime constraint kinds:
6 -> 4

remaining:
change_profile
size_rules
integration
primitive_relation
```

Число `relation descriptors` остаётся 10.

Число источников `FactRef` остаётся 4.

## 7. C3.3d2 — `change_profiles` как чистый high-level lowering

### 7.1. Что сохраняется

Публичный раздел `change_profiles` сохраняется, потому что он полезен и используется self-policy.

Он остаётся пользовательским сокращением для описания допустимой формы изменения по `change_type`.

Удаляется только самостоятельная семантическая реализация:

```text
checkChangeProfile
change_profile runtime kind
change_profile dispatch
```

### 7.2. Каноническая цель

Высокоуровневый профиль должен компилироваться до обычных `primitive_relation` через существующие `diff` facts.

Новый `FactRef source` не нужен.

Новый relation primitive не нужен.

Существующий `numeric_bound` уже поддерживает обе границы:

```text
min
max
```

Поэтому `require_surfaces` не требует нового relation kind.

### 7.3. Выбор профиля

Выбор профиля по `ChangeIntent.change_type` является frontend compilation concern.

Текущая особая semantics сохраняется:

```text
change_type = governance
```

не выбирает обычный `change_profile` и не создаёт profile constraints. Управляющее разрешение по-прежнему определяется отдельным `GovernanceGrant` и base-policy control plane.

Если профили существуют и `change_type` отсутствует, compilation должен завершаться fail-closed diagnostic.

Если `change_type` не равен `governance` и не существует среди `change_profiles`, compilation должен завершаться fail-closed diagnostic.

Эти ошибки не являются отдельным runtime evaluator.

### 7.4. Сохранение semantics пересекающихся поверхностей

Один изменённый путь может соответствовать нескольким поверхностям.

Поэтому неверно заменять текущую семантику проверкой вида:

```text
changed path belongs to at least one allowed surface
```

Такой путь может одновременно принадлежать разрешённой и запрещённой поверхности.

Правильное lowering для `allow_surfaces` строится от множества всех известных неразрешённых поверхностей.

Для каждой неразрешённой поверхности:

```text
diff.changed_paths(patterns = that_surface)
        ↓
numeric_bound(max = 0)
```

Это сохраняет текущую overlap-semantics.

### 7.5. Полное lowering

`forbid_surfaces`:

```text
matching changed paths
        ↓
numeric_bound(max = 0)
```

`require_surfaces`:

```text
matching changed paths
        ↓
numeric_bound(min = 1)
```

`allow_unclassified_surfaces = false` проверяется только если профиль действительно задаёт хотя бы одно surface-ограничение:

```text
require_surfaces
or allow_surfaces
or forbid_surfaces
```

Это сохраняет текущую семантику `usesConstraints`.

При наличии таких ограничений lowering:

```text
diff.changed_paths(
  patterns = union(all declared surface patterns),
  mode = outside
)
        ↓
numeric_bound(max = 0)
```

Если surface-ограничения отсутствуют, одно поле `allow_unclassified_surfaces = false` само по себе не создаёт запрет.

`new_files.allow_classes`:

Для каждой неразрешённой file class:

```text
diff.changed_paths(
  patterns = that_class,
  statuses = added
)
        ↓
numeric_bound(max = 0)
```

Если `allow_classes` пуст, любая затронутая объявленная class считается неразрешённой, как и сейчас.

Не классифицированные новые файлы запрещаются при наличии блока `new_files` независимо от непустоты `allow_classes`:

```text
diff.changed_paths(
  patterns = union(all declared class patterns),
  mode = outside,
  statuses = added
)
        ↓
numeric_bound(max = 0)
```

`new_files.max_per_class`:

```text
added paths matching class
        ↓
numeric_bound(max = configured_limit)
```

`new_files.max_new_files`:

```text
diff.metric(new_files)
        ↓
numeric_bound(max = configured_limit)
```

Профильные бюджеты:

```text
max_new_docs
max_new_files
max_net_added_lines
```

компилируются через существующие `diff.metric` facts и `numeric_bound`.

`max_new_docs` продолжает учитывать исключение `paths.canonical_docs`, как текущий общий budget lowering.

### 7.6. Ссылочная целостность

Следующие ссылки проверяются до runtime evaluation:

```text
allow_surfaces -> known surface
forbid_surfaces -> known surface
require_surfaces -> known surface
allow_classes -> known class
max_per_class keys -> known class
```

Они остаются semantic frontend validation и не превращаются во второй evaluator.

### 7.7. Цель среза

После C3.3d2:

```text
runtime constraint kinds:
4 -> 3

remaining:
size_rules
integration
primitive_relation
```

`change_profiles` остаётся публичным high-level syntax, но после компиляции его имя отсутствует в runtime program.

## 8. C3.3d3 — `size_rules` через канонические факты

### 8.1. Что сохраняется

`size_rules` реально используется self-policy и предоставляет две категории ограничений:

```text
absolute repository-state size
transaction growth
```

Capability сохраняется.

Удаляются:

```text
checkSizeRules
size_rules runtime kind
size_rules dispatch
special runtime-only invalid-combination handling
```

### 8.2. Сначала доказать нехватку словаря

До изменения `FactRef` необходимо написать RED, выражающий требуемую поддерживаемую семантику `size_rules` через будущую каноническую программу.

Если существующие факты позволяют закрыть RED без нового селектора, `path_metric` не добавляется.

Если не позволяют, допускается ровно одно минимальное расширение существующего `repository` source.

### 8.3. Предлагаемый `repository.path_metric`

Концептуальная typed-форма:

```text
source = repository
selector.kind = path_metric
selector.patterns = string[]
selector.ignore = string[]
selector.population = tracked | changed
selector.metric = lines | bytes | files
selector.aggregate = max | sum
type = scalar
```

Это acquisition primitive: он только выбирает измеряемые пути из уже доступных repository/diff facts, читает текущее содержимое и возвращает число.

Он ничего не знает о:

```text
size_rules
max
max_growth
advisory
blocking
change_type
```

Эти понятия принадлежат frontend lowering и execution metadata.

### 8.4. Абсолютные ограничения и фаза исполнения

Для file scope:

```text
metric = lines | bytes
aggregate = max
```

Например:

```text
every matching source file <= 900 lines
```

эквивалентно:

```text
max(lines(each matching file)) <= 900
```

Для directory scope абсолютная метрика считается по всей выбранной текущей поверхности:

```text
aggregate = sum
```

Для metric `files` измеряется количество выбранных путей.

После acquisition всегда используется существующий `numeric_bound`.

Фаза primitive constraint должна сохранять текущую модель:

```text
all_tracked absolute max without change-type condition -> state
max_growth -> transaction
applies_to_change_types absolute max -> transaction
changed_only file absolute max -> transaction
```

При выполнении общего режима `both` соответствующие state и transaction constraints оцениваются вместе обычным phase mechanism.

### 8.5. `applies_to_change_types`

Эта форма не требует нового fact selector.

`compileConstraintProgram` уже получает `ChangeIntent`, поэтому frontend либо компилирует size constraint для текущего `change_type`, либо не компилирует его.

Для directory rule с `all_tracked` и подходящим `change_type` измеряется вся текущая matching surface, но constraint имеет transaction phase.

Это сохраняет текущую semantics self-policy для refactor-only no-growth/absolute rules.

### 8.6. `changed_only`

Текущая semantics различается по scope.

Для file scope:

```text
count = changed_only
```

означает измерять только текущие изменённые, не удалённые matching files. Это чисто выражается через:

```text
repository.path_metric(population = changed)
```

и может быть сохранено.

Для directory scope текущая semantics иная:

```text
if no matching path changed -> skip rule
if any matching path changed -> measure entire current matching directory surface
```

Это условная историческая форма, которую нельзя маскировать значением `population = changed`.

Базовое решение C3.3d3:

```text
scope = directory + count = changed_only
```

удалить из поддерживаемого публичного поднабора и отвергать на schema/compiler boundary, если RED не обнаружит уже существующее простое каноническое выражение без нового relation primitive и без специального conditional acquisition mode.

Запрещено добавлять ради этой формы селектор наподобие:

```text
tracked_if_changed
```

или отдельный conditional evaluator.

### 8.7. Рост транзакции

Рост не должен создавать repository snapshot subsystem.

Он относится к `diff` source.

Существующий `diff.metric` уже измеряет общие transaction metrics. При доказанной необходимости допустимо расширить его pattern-scoped параметрами:

```text
patterns
ignore
```

и добавить только недостающие конечные metric names, например:

```text
net_added_lines
net_files
```

Конкретные имена закрепляются implementation plan после focused RED-аудита.

Не допускается:

```text
new growth FactRef source
size-growth relation
base repository snapshot evaluator
```

После получения числового transaction fact применяется существующий:

```text
numeric_bound(max = max_growth)
```

Отрицательный `max_growth` сохраняется и может требовать реального сжатия.

### 8.8. Невалидные исторические сочетания

Если форма `size_rules` не имеет однозначной поддерживаемой semantics в canonical facts + relations, она должна быть отвергнута на schema/compiler boundary.

Нельзя сохранять модель:

```text
schema accepts
    ↓
dedicated runtime detects unsupported combination
```

Целевая модель:

```text
schema/compiler rejects unsupported combination
```

Минимум должны быть явно проверены текущие ограничения:

```text
metric = files -> directory scope only
max_growth -> directory scope only
max_growth + bytes -> unsupported
```

Дополнительно, как определено выше, `directory + changed_only` по умолчанию становится unsupported, если equivalence RED не докажет простое каноническое выражение.

### 8.9. Уровень исполнения

Self-policy использует как blocking, так и advisory size checks.

Поэтому primitive runtime entry может нести общую execution/reporting metadata:

```text
level = blocking | advisory
origin = size_rule:<id>
```

`level` не изменяет истинность relation и не создаёт новый evaluator.

Один primitive relation сначала вычисляется одинаково; затем общий reporting/enforcement слой решает, является ли нарушение blocking или advisory.

Если в текущей архитектуре уже есть более общий эквивалентный механизм метаданных, необходимо переиспользовать его вместо добавления второго механизма.

### 8.10. Fail-closed measurement

Текущий historical evaluator может молча пропустить файл, если чтение вернуло `null`.

C3.3d3 намеренно ужесточает эту границу.

Если путь входит в измеряемое множество, но содержимое нельзя прочитать или измерить, этот путь нельзя молча пропускать.

Целевая semantics:

```text
matching path
+ measurement failure
= fact read failure
= relation evaluation failure
```

Это fail-closed изменение считается архитектурным исправлением, а не compatibility regression.

### 8.11. Цель среза

После C3.3d3:

```text
runtime constraint kinds:
3 -> 2

remaining:
integration
primitive_relation
```

## 9. Что C3.3d не делает

Строго вне области:

```text
integration FactRef source
integration selector vocabulary
workflow role redesign
repo_guard_pr_gate redesign
repo_guard_portable_coordinator redesign/deletion
merge-group redesign/deletion
parallel readiness redesign/deletion
validate-integration redesign
```

Не допускается использовать удаление одного из четырёх runtime kinds как повод одновременно менять `integration`.

Следующая архитектурная тема после C3.3d:

```text
C3.3e — integration / parallel convergence audit
```

## 10. Порядок доказательства

Каждый принимаемый срез выполняется только RED-first.

Обязательная последовательность:

```text
accepted main reread
exact branch base recorded
focused test-only RED commit
RED CI captured
minimal production lowering/deletion
focused GREEN
full suite
self repo-guard
compression metrics against exact C3.0 baseline
ready exact-head CI
exact-head merge
post-merge main CI
```

Первый implementation commit каждого среза содержит только тесты.

Тесты должны утверждать конечную архитектуру, а не внутренние промежуточные конструкции.

Никакой transitional evaluator не остаётся после merge.

## 11. Требования к equivalence для сохраняемых возможностей

Для `change_profiles` необходимо доказать минимум:

```text
allowed surface pass
forbidden surface fail
required surface pass/fail
overlapping allowed+disallowed surface fail
unclassified behavior only when surface constraints exist
allowed/disallowed new-file class
empty allow_classes behavior
unclassified new file
per-class budget
new_files.max_new_files
profile budgets
governance bypass
missing change_type
unknown change_type
unknown surface/class reference
```

Сравнение проверяет семантическое решение и fail-closed условия. Exact historical diagnostic shape сохранять не требуется.

Для `size_rules` необходимо доказать минимум:

```text
file lines absolute pass/fail
directory lines absolute pass/fail
file count absolute pass/fail
ignore patterns
file changed_only where retained
applies_to_change_types
state/transaction phase split
line growth pass/fail
file-count growth pass/fail
negative max_growth
advisory violation remains non-blocking
blocking violation remains blocking
measurement read failure is fail-closed
unsupported combinations are rejected before runtime
```

Если какая-либо существующая форма не может быть корректно сохранена без нового специального механизма, она явно удаляется из публичной схемы, а regression test проверяет rejection.

## 12. Измеримые критерии сжатия

После каждого среза запускается canonical comparison:

```text
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

C3.3d не имеет права менять canonical measurement baseline.

Ожидаемый runtime-kind ratchet:

```text
accepted before C3.3d = 6
C3.3d1 = 4
C3.3d2 = 3
C3.3d3 = 2
```

При этом:

```text
relation descriptors = 10 throughout
FactRef sources = 4 throughout
FactRef models = 1 throughout
```

Количество `RepositoryFactSelector` variants может увеличиться с 1 до 2 только в C3.3d3 и только после RED proof.

## 13. Документация и публичная граница

Удалённые публичные концепты удаляются в том же срезе из:

```text
schema
README/docs
examples
init/templates where applicable
tests
source
dist
```

Не сохранять разделы вида «устарело», aliases или migration compatibility.

Историческая информация остаётся в Git и GitHub issues/PRs.

`change_profiles` и `size_rules` сохраняют пользовательские имена только пока они остаются полезным high-level syntax. В runtime program эти имена после соответствующего lowering отсутствуют.

## 14. Разбиение будущего implementation plan

После письменного review этого spec создаётся один master plan, который не реализуется одним PR.

Он должен породить три последовательных child issues/PR:

```text
C3.3d1 — deletion: surface_debt + registry_rules
C3.3d2 — lowering: change_profiles
C3.3d3 — lowering: size_rules
```

Каждый следующий срез ветвится только от принятого post-merge `main` предыдущего.

Не создавать заранее implementation branches для d2/d3: фактический accepted state предыдущего среза является их source of truth.

Self-policy разрешает не более двух новых документов в одном изменении. Первый слот уже занимает этот spec; второй предназначается master implementation plan. Дополнительный итоговый документ C3.3d не создаётся.

## 15. Финальная приёмка C3.3d

C3.3d считается завершённым только если одновременно доказано:

```text
surface_debt public/runtime concept absent
registry_rules public/runtime concept absent
change_profiles has no dedicated runtime evaluator
size_rules has no dedicated runtime evaluator
runtime kinds exactly integration + primitive_relation
relation descriptors exactly 10
FactRef sources exactly 4
one FactRef model
one primitive descriptor registry
no legacy aliases
no second evaluator
no arbitrary expression language
integration semantics unchanged by C3.3d
```

Все три PR должны иметь GREEN ready-state `validate` и `smoke-pack`, успешный `Run PR policy check`, exact-head merge и GREEN post-merge `main`.

Только после этого #398 может быть закрыта `completed`, а #374 получает новый checkpoint перед C3.3e.
