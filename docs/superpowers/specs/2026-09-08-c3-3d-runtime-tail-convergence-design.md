# C3.3d — сжатие оставшегося исторического исполняемого хвоста

Статус: архитектурный дизайн для #398 утверждён в чате; до подготовки плана реализации требуется отдельное одобрение этого письменного документа.

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

После C3.3c в исполняемой программе ограничений остаются шесть видов:

```text
surface_debt
size_rules
registry_rules
change_profile
integration
primitive_relation
```

C3.3d должен убрать первые четыре как самостоятельные семантические пути.

Целевое состояние:

```text
integration
primitive_relation
```

`integration` намеренно остаётся отдельным историческим хвостом. Его дальнейшая судьба относится к C3.3e и не смешивается с этой работой.

Требуемая архитектурная форма:

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

Если возможность не имеет доказанной ценности и её сохранение требует нового специального языка, селектора или исполнителя, возможность удаляется.

Порядок предпочтения:

```text
remove
  > reuse existing canonical facts/relations
  > add one small typed acquisition primitive if RED proves necessity
  > add subsystem
```

Последний вариант в C3.3d запрещён.

## 2. Неподвижные архитектурные границы

После C3.3d должны выполняться инварианты:

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
primitive semantic runtime kinds = 1
runtime constraint kinds = 2
new relation primitive = NONE
```

Четыре источника `FactRef` остаются неизменными:

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

Единственное допустимое расширение словаря фактов возможно только в C3.3d3 и только после доказанного RED:

```text
RepositoryFactSelector.anchor_values
+ RepositoryFactSelector.path_metric
```

Наличие этого пункта не разрешает добавлять `path_metric` заранее. Сначала тест должен доказать, что существующего словаря фактов недостаточно.

## 3. Что именно считается сохранением поведения

Для возможностей, которые остаются публичными, C3.3d обязан сохранить:

```text
pass / fail
blocking / advisory
transaction / state applicability
fail-closed conditions
```

Побайтное совпадение старого диагностического объекта и старые внутренние имена результатов не являются контрактом C3.3d.

Канонический результат отношения должен сохранять достаточную диагностику:

```text
source fact provenance
actual value or selected values
bound / expected relation
rule or lowering origin metadata
read/evaluation failure
```

Происхождение высокоуровневого ограничения может храниться как обычная метаинформация скомпилированной записи. Оно не создаёт отдельной семантики.

## 4. Почему C3.3d разбит на три среза

Четыре исторических вида имеют разную природу:

- `surface_debt` — декларация в `ChangeIntent`, но не источник полномочий;
- `registry_rules` — отдельный публичный язык сравнения множеств;
- `change_profile` — полезное высокоуровневое сокращение, используемое собственной политикой репозитория;
- `size_rules` — полезная возможность измерения состояния репозитория и роста изменения.

Один большой PR затруднит доказательство причин каждого изменения и повысит риск сохранить ненужный специальный путь.

Поэтому принимаются три последовательных среза:

```text
C3.3d1: delete surface_debt + registry_rules
C3.3d2: pure-lower change_profiles
C3.3d3: lower size_rules through canonical facts
```

Каждый срез имеет отдельный PR, отдельный тестовый RED, точный SHA принятой головы и отдельную проверку после слияния.

## 5. C3.3d1 — удалить `surface_debt`

### 5.1. Текущая семантика

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

Отсутствие `surface_debt` само по себе не запрещает изменение. Обычные бюджеты проверяются отдельно.

Следовательно, `surface_debt` не является:

- доверенным разрешением;
- заменой `GovernanceGrant`;
- способом ослабить `diff_rules`;
- необходимым входом ядра отношений.

Это самостоятельный исторический диагностический путь.

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

Если в будущем понадобится формальная временная санкция на рост, она проектируется как отдельная доверенная модель управления, а не как возврат этого диагностического объекта.

## 6. C3.3d1 — удалить `registry_rules`

### 6.1. Текущая форма

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

Исполнитель читает источники, нормализует значения и затем вызывает уже существующее сравнение множеств.

Есть явный архитектурный дрейф: публичная схема использует `set_equality`, а внутренний тип исполнителя — `equal`; равенство продолжает работать через резервную ветку. Это случайная совместимость, а не канонический контракт.

### 6.2. Решение

Удалить без слоя совместимости:

```text
repo-policy.registry_rules
registry schema vocabulary
checkRegistryRules
registry_rules runtime kind
registry runtime dispatch
registry-specific source types
registry-specific tests/docs/examples
```

Сравнения структурированных документов должны выражаться существующей формой:

```text
document_relations
  + document FactRef
  + set_equal / set_subset
```

Отдельную поддержку `markdown_section_links` автоматически не переносить.

Её сохранение потребовало бы нового универсального словаря селекторов Markdown только ради исторической поверхности, а собственная политика репозитория такой необходимости не доказывает.

Если позже появится реальный потребитель с таким требованием, он станет новым проверочным примером для общего чтения документных фактов. Старый язык `registry_rules` ради гипотетического потребителя не сохраняется.

### 6.3. Цель C3.3d1

После среза:

```text
runtime constraint kinds:
6 -> 4

remaining:
change_profile
size_rules
integration
primitive_relation
```

При этом:

```text
relation descriptors = 10
FactRef sources = 4
```

## 7. C3.3d2 — `change_profiles` как чистое разворачивание

### 7.1. Что сохраняется

Публичный раздел `change_profiles` сохраняется. Он полезен и используется собственной политикой репозитория.

Он остаётся пользовательским сокращением для описания допустимой формы изменения по `change_type`.

Удаляется отдельная реализация семантики:

```text
checkChangeProfile
change_profile runtime kind
change_profile dispatch
```

### 7.2. Каноническая цель

Высокоуровневый профиль компилируется только в обычные `primitive_relation` через существующие факты `diff`.

Новый источник `FactRef` не нужен.

Новый примитив отношения не нужен.

Существующий `numeric_bound` уже поддерживает:

```text
min
max
```

Поэтому `require_surfaces` не требует нового вида отношения.

### 7.3. Выбор профиля

Выбор профиля по `ChangeIntent.change_type` выполняется при компиляции высокоуровневой политики.

Особая текущая семантика сохраняется:

```text
change_type = governance
```

Для этого значения обычные ограничения `change_profiles` не создаются. Управляющее разрешение по-прежнему определяется отдельным `GovernanceGrant` и доверенной базовой политикой.

Если профили существуют, а `change_type` отсутствует, компиляция завершается явной запрещающей диагностикой.

Если `change_type` не равен `governance` и не существует среди `change_profiles`, компиляция также завершается явной запрещающей диагностикой.

Отдельный исполняемый проверяющий модуль для этих ошибок не создаётся.

### 7.4. Пересекающиеся поверхности

Один изменённый путь может соответствовать нескольким поверхностям.

Поэтому нельзя заменять текущую семантику правилом:

```text
changed path belongs to at least one allowed surface
```

Путь может одновременно принадлежать разрешённой и запрещённой поверхности.

Правильное разворачивание `allow_surfaces` строится от всех известных неразрешённых поверхностей.

Для каждой такой поверхности:

```text
diff.changed_paths(patterns = that_surface)
        ↓
numeric_bound(max = 0)
```

Это сохраняет текущую семантику пересечений.

### 7.5. Полное разворачивание

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

`allow_unclassified_surfaces = false` проверяется только когда профиль действительно задаёт хотя бы одно ограничение поверхности:

```text
require_surfaces
or allow_surfaces
or forbid_surfaces
```

Это сохраняет текущую логику `usesConstraints`.

При наличии таких ограничений:

```text
diff.changed_paths(
  patterns = union(all declared surface patterns),
  mode = outside
)
        ↓
numeric_bound(max = 0)
```

Если ограничений поверхности нет, одно поле `allow_unclassified_surfaces = false` само по себе запрет не создаёт.

`new_files.allow_classes`:

Для каждого неразрешённого класса новых файлов:

```text
diff.changed_paths(
  patterns = that_class,
  statuses = added
)
        ↓
numeric_bound(max = 0)
```

Если `allow_classes` пуст, любой затронутый объявленный класс считается неразрешённым, как и сейчас.

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

разворачиваются через существующие метрики `diff` и `numeric_bound`.

`max_new_docs` продолжает учитывать исключение `paths.canonical_docs`, как текущая общая проверка бюджета.

### 7.6. Ссылочная целостность

До исполнения проверяются ссылки:

```text
allow_surfaces -> known surface
forbid_surfaces -> known surface
require_surfaces -> known surface
allow_classes -> known class
max_per_class keys -> known class
```

Эти проверки остаются частью компиляции политики и не превращаются во второй исполнитель семантики.

### 7.7. Цель C3.3d2

После среза:

```text
runtime constraint kinds:
4 -> 3

remaining:
size_rules
integration
primitive_relation
```

`change_profiles` остаётся публичным высокоуровневым синтаксисом, но после компиляции отдельного вида `change_profile` в исполняемой программе нет.

## 8. C3.3d3 — `size_rules` через канонические факты

### 8.1. Что сохраняется

`size_rules` реально используется собственной политикой репозитория и предоставляет две категории ограничений:

```text
absolute repository-state size
transaction growth
```

Возможность сохраняется.

Удаляются:

```text
checkSizeRules
size_rules runtime kind
size_rules dispatch
special runtime-only invalid-combination handling
```

### 8.2. Сначала доказать нехватку словаря

До изменения `FactRef` пишется RED, выражающий требуемую поддерживаемую семантику `size_rules` через будущую каноническую программу.

Если существующие факты позволяют закрыть RED без нового селектора, `path_metric` не добавляется.

Если не позволяют, допускается ровно одно минимальное расширение существующего источника `repository`.

### 8.3. Предлагаемый `repository.path_metric`

Концептуальная типизированная форма:

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

Это примитив получения факта: он выбирает измеряемые пути из уже доступных фактов репозитория и изменения, читает текущее содержимое и возвращает число.

Он ничего не знает о:

```text
size_rules
max
max_growth
advisory
blocking
change_type
```

Эти понятия принадлежат разворачиванию высокоуровневой политики и общему режиму исполнения.

### 8.4. Абсолютные ограничения и фазы

Для файловой области:

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

Для области каталога абсолютная метрика считается по всей выбранной текущей поверхности:

```text
aggregate = sum
```

Для `metric = files` измеряется количество выбранных путей.

После получения числа всегда используется существующий `numeric_bound`.

Фаза ограничения должна сохранять текущую модель:

```text
all_tracked absolute max without change-type condition -> state
max_growth -> transaction
applies_to_change_types absolute max -> transaction
changed_only file absolute max -> transaction
```

В общем режиме `both` ограничения состояния и изменения оцениваются обычным механизмом фаз.

### 8.5. `applies_to_change_types`

Эта форма не требует нового селектора фактов.

`compileConstraintProgram` уже получает `ChangeIntent`, поэтому компилятор либо создаёт ограничение размера для текущего `change_type`, либо не создаёт его.

Для правила каталога с `all_tracked` и подходящим `change_type` измеряется вся текущая совпадающая поверхность, но само ограничение относится к фазе изменения.

Это сохраняет существующее поведение собственных правил репозитория, применимых только к рефакторингу.

### 8.6. `changed_only`

Текущая семантика различается по области.

Для файловой области:

```text
count = changed_only
```

означает измерять только текущие изменённые, не удалённые совпадающие файлы. Это естественно выражается через:

```text
repository.path_metric(population = changed)
```

и сохраняется.

Для области каталога текущая семантика иная:

```text
if no matching path changed -> skip rule
if any matching path changed -> measure entire current matching directory surface
```

Это условная историческая форма. Она не эквивалентна `population = changed`.

Базовое решение C3.3d3:

```text
scope = directory + count = changed_only
```

удалить из поддерживаемого публичного поднабора и отвергать на границе схемы или компилятора, если RED не обнаружит уже существующее простое каноническое выражение без нового вида отношения и без специального условного режима получения фактов.

Ради этой формы запрещено добавлять:

```text
tracked_if_changed
```

или отдельный условный исполнитель.

### 8.7. Рост изменения

Рост не должен создавать отдельную подсистему снимков репозитория.

Он относится к источнику `diff`.

Существующий `diff.metric` уже измеряет общие метрики изменения. При доказанной необходимости допустимо расширить его параметрами области:

```text
patterns
ignore
```

и добавить только недостающие конечные имена метрик, например:

```text
net_added_lines
net_files
```

Точные имена фиксируются в плане реализации после целевого RED-аудита.

Не допускается создавать:

```text
new growth FactRef source
size-growth relation
base repository snapshot evaluator
```

После получения числового факта изменения применяется существующий:

```text
numeric_bound(max = max_growth)
```

Отрицательный `max_growth` сохраняется и может требовать реального сжатия.

### 8.8. Невалидные исторические сочетания

Если форма `size_rules` не имеет однозначной поддерживаемой семантики через канонические факты и отношения, она отвергается на границе схемы или компилятора.

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

Минимум явно проверяются текущие ограничения:

```text
metric = files -> directory scope only
max_growth -> directory scope only
max_growth + bytes -> unsupported
```

Дополнительно `directory + changed_only` по умолчанию становится неподдерживаемым, если RED не докажет простое каноническое выражение.

### 8.9. Блокирующие и рекомендательные нарушения

Собственная политика использует как блокирующие, так и рекомендательные проверки размера.

Поэтому запись `primitive_relation` может нести общую метаинформацию исполнения:

```text
level = blocking | advisory
origin = size_rule:<id>
```

`level` не изменяет истинность отношения и не создаёт новый исполнитель.

Сначала отношение вычисляется единым способом; затем общий слой отчёта и принуждения решает, блокирует ли нарушение принятие изменения.

Если в текущей архитектуре уже существует общий эквивалентный механизм метаинформации, переиспользуется он.

### 8.10. Ошибка измерения закрывает проверку

Текущий исторический исполнитель может молча пропустить файл, если чтение вернуло `null`.

C3.3d3 намеренно ужесточает эту границу.

Если путь входит в измеряемое множество, но содержимое нельзя прочитать или измерить, путь нельзя молча пропускать.

Целевая семантика:

```text
matching path
+ measurement failure
= fact read failure
= relation evaluation failure
```

Такое изменение считается исправлением архитектурной границы, а не обязательством по совместимости со старым пропуском ошибки.

### 8.11. Цель C3.3d3

После среза:

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

Удаление одного из четырёх исторических видов не является поводом одновременно менять `integration`.

Следующая архитектурная тема после C3.3d:

```text
C3.3e — integration / parallel convergence audit
```

## 10. Порядок доказательства

Каждый принимаемый срез выполняется только через тестовый RED.

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

Первый коммит реализации каждого среза содержит только тесты.

Тесты утверждают конечную архитектуру, а не промежуточные конструкции.

После слияния не остаётся переходного исполнителя.

## 11. Требования к эквивалентности сохраняемых возможностей

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

Проверка сравнивает семантическое решение и запрещающие условия при ошибках. Точная старая форма диагностического объекта не сохраняется.

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

Если существующая форма не может быть корректно сохранена без нового специального механизма, она удаляется из публичной схемы, а тест проверяет её отклонение.

## 12. Измеримые критерии сжатия

После каждого среза запускается каноническое сравнение:

```text
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

C3.3d не меняет каноническую базовую точку измерений.

Ожидаемое уменьшение числа исполняемых видов:

```text
accepted before C3.3d = 6
C3.3d1 = 4
C3.3d2 = 3
C3.3d3 = 2
```

При этом на всём пути:

```text
relation descriptors = 10
FactRef sources = 4
FactRef models = 1
```

Число вариантов `RepositoryFactSelector` может увеличиться с 1 до 2 только в C3.3d3 и только после RED-доказательства необходимости.

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

Не сохраняются разделы «устарело», псевдонимы и слой миграционной совместимости.

История остаётся в системе контроля версий и обсуждениях задач и PR.

`change_profiles` и `size_rules` сохраняют пользовательские имена только пока остаются полезным высокоуровневым синтаксисом. После соответствующего разворачивания отдельные исполняемые виды с этими именами отсутствуют.

## 14. Разбиение будущего плана реализации

После письменного одобрения этого документа создаётся один общий план реализации. Он не исполняется одним PR.

План порождает три последовательные дочерние задачи и PR:

```text
C3.3d1 — deletion: surface_debt + registry_rules
C3.3d2 — lowering: change_profiles
C3.3d3 — lowering: size_rules
```

Каждый следующий срез ветвится только от принятого состояния `main` после предыдущего среза.

Ветки реализации для d2/d3 заранее не создаются: источником истины является фактически принятое состояние предыдущего среза.

Собственная политика разрешает не более двух новых документов в одном изменении. Первый слот занимает этот spec; второй предназначен общему плану реализации. Дополнительный итоговый документ C3.3d не создаётся.

## 15. Финальная приёмка C3.3d

C3.3d завершён только если одновременно доказано:

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

Каждый из трёх PR должен иметь успешные `validate`, `smoke-pack` и `Run PR policy check` в состоянии готовности к review, после чего сливается только проверенная точная голова. После слияния `main` снова обязан пройти полный CI.

Только после этого #398 закрывается как выполненная, а #374 получает новый checkpoint перед C3.3e.
