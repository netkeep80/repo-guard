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

## 3. Почему работа разбита на три принимаемых среза

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

## 4. C3.3d1 — удалить `surface_debt`

### 4.1. Наблюдаемая текущая семантика

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

### 4.2. Решение

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

## 5. C3.3d1 — удалить `registry_rules`

### 5.1. Наблюдаемая текущая форма

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

### 5.2. Решение

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

### 5.3. Цель среза

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

## 6. C3.3d2 — `change_profiles` как чистый high-level lowering

### 6.1. Что сохраняется

Публичный раздел `change_profiles` сохраняется, потому что он полезен и используется self-policy.

Он остаётся пользовательским сокращением для описания допустимой формы изменения по `change_type`.

Удаляется только самостоятельная семантическая реализация:

```text
checkChangeProfile
change_profile runtime kind
change_profile dispatch
```

### 6.2. Каноническая цель

Высокоуровневый профиль должен компилироваться до обычных `primitive_relation` через существующие `diff` facts.

Новый `FactRef source` не нужен.

Новый relation primitive не нужен.

### 6.3. Сохранение semantics пересекающихся поверхностей

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

### 6.4. Полное lowering

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

Если relation kernel хранит `numeric_bound` через другой параметризированный вид нижней границы, реализация должна переиспользовать текущий descriptor contract, а не создавать новый вид relation.

`allow_unclassified_surfaces = false`:

```text
diff.changed_paths(
  patterns = union(all declared surface patterns),
  mode = outside
)
        ↓
numeric_bound(max = 0)
```

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

Не классифицированные новые файлы:

```text
diff.changed_paths(
  patterns = union(all declared class patterns),
  mode = outside,
  statuses = added
)
        ↓
numeric_bound(max = 0)
```

`max_per_class`:

```text
added paths matching class
        ↓
numeric_bound(max = configured_limit)
```

Профильные бюджеты:

```text
existing diff metric FactRef
        ↓
numeric_bound
```

### 6.5. Выбор профиля и ошибки

Выбор конкретного профиля по `ChangeIntent.change_type` является frontend compilation concern.

Неизвестный или отсутствующий `change_type`, если `change_profiles` требует выбора профиля, должен завершаться fail-closed compilation diagnostic.

Проверки ссылочной целостности:

```text
allow_surfaces -> known surface
forbid_surfaces -> known surface
require_surfaces -> known surface
allow_classes -> known class
max_per_class keys -> known class
```

также остаются в semantic frontend validation.

Они не становятся вторым runtime evaluator.

### 6.6. Цель среза

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

## 7. C3.3d3 — `size_rules` через канонические факты

### 7.1. Что сохраняется

`size_rules` реально используется self-policy и предоставляет две различные категории ограничений:

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

### 7.2. Сначала доказать нехватку словаря

До изменения `FactRef` необходимо написать RED, выражающий полную требуемую семантику `size_rules` через будущую каноническую программу.

Если существующие факты неожиданно позволяют закрыть RED без нового селектора, `path_metric` не добавляется.

Если не позволяют, допускается ровно одно минимальное расширение существующего `repository` source.

### 7.3. Предлагаемый `repository.path_metric`

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

Это acquisition primitive: он только измеряет выбранную поверхность репозитория и возвращает число.

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

### 7.4. Абсолютные ограничения

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

Для directory scope:

```text
aggregate = sum
```

Для metric `files` измеряется количество выбранных путей.

После acquisition всегда используется существующий `numeric_bound`.

### 7.5. Рост транзакции

Рост не должен создавать repository snapshot subsystem.

Он относится к `diff` source.

Существующий `diff.metric` уже измеряет общие transaction metrics. При доказанной необходимости допустимо расширить его параметрами `patterns` и `ignore` и добавить только недостающие конечные metric names, например:

```text
net_added_lines
net_files
```

Конкретные имена должны быть минимальными и закрепляться implementation plan после RED-аудита.

Не допускается:

```text
new growth FactRef source
size-growth relation
base repository snapshot evaluator
```

После получения числового transaction fact применяется существующий `numeric_bound(max = max_growth)`.

### 7.6. Невалидные исторические сочетания

Если форма `size_rules` не имеет однозначной поддерживаемой semantics, она должна быть отвергнута на schema/compiler boundary.

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

Это относится, в частности, к комбинациям, для которых невозможно точно восстановить transaction delta имеющимися фактами.

Поддерживаемый публичный поднабор должен быть ровно тем, который можно выразить canonical facts + relations.

### 7.7. Уровень исполнения

Self-policy использует как blocking, так и advisory size checks.

Поэтому primitive runtime entry может нести execution/reporting metadata:

```text
level = blocking | advisory
```

`level` не изменяет истинность relation и не создаёт новый evaluator.

Один primitive relation сначала вычисляется одинаково; затем reporting/enforcement слой решает, является ли нарушение blocking или advisory.

Если в текущей архитектуре уже есть более общий эквивалентный execution metadata mechanism, необходимо переиспользовать его вместо добавления второго механизма.

### 7.8. Fail-closed measurement

Если путь входит в измеряемое множество, но содержимое нельзя прочитать или измерить, этот путь нельзя молча пропускать.

Целевая semantics:

```text
matching path
+ measurement failure
= fact read failure
= relation evaluation failure
```

Это устраняет fail-open поведение измерителя.

### 7.9. Цель среза

После C3.3d3:

```text
runtime constraint kinds:
3 -> 2

remaining:
integration
primitive_relation
```

## 8. Что C3.3d не делает

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

## 9. Порядок доказательства

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

## 10. Требования к equivalence для сохраняемых возможностей

Для `change_profiles` необходимо доказать минимум:

```text
allowed surface pass
forbidden surface fail
required surface pass/fail
overlapping allowed+disallowed surface fail
unclassified surface pass/fail according to flag
allowed/disallowed new-file class
unclassified new file
per-class budget
profile budget
missing change_type
unknown change_type
unknown surface/class reference
```

Сравнение должно проверять observable result, а не только форму compiled program.

Для `size_rules` необходимо доказать минимум:

```text
file lines absolute pass/fail
directory lines absolute pass/fail
file count absolute pass/fail
ignore patterns
changed_only vs all_tracked where retained
change-type applicability
line growth pass/fail
file-count growth pass/fail
advisory violation remains non-blocking
blocking violation remains blocking
measurement read failure is fail-closed
unsupported combinations are rejected before runtime
```

Если какая-либо существующая форма не может быть корректно сохранена без нового специального механизма, она должна быть явно удалена из публичной схемы, а regression test должен проверять rejection.

## 11. Измеримые критерии сжатия

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

## 12. Документация и публичная граница

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

## 13. Разбиение будущего implementation plan

После письменного review этого spec создаётся один master plan, который не реализуется одним PR.

Он должен породить три последовательных child issues/PR:

```text
C3.3d1 — deletion: surface_debt + registry_rules
C3.3d2 — lowering: change_profiles
C3.3d3 — lowering: size_rules
```

Каждый следующий срез ветвится только от принятого post-merge `main` предыдущего.

Не создавать заранее implementation branches для d2/d3: фактический accepted state предыдущего среза является их source of truth.

## 14. Финальная приёмка C3.3d

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
