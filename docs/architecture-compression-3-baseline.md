# Сжатие архитектуры 3.0 — исходный измеримый срез

Статус документа: канонический базовый срез для программы #370.

Базовый этап: #371.

Текущий этап программы: #372.

Этот этап только измеряет существующую архитектуру. Он не меняет семантику политик, исполнение правил, схемы, рабочие процессы или выпуск.

## 1. Точная исходная точка

Все воспроизводимые метрики ниже привязаны к принятому состоянию:

```text
92432809fcddc290080beb51ba151e13a5761869
```

Это состояние `main` после слияния #369.

Воспроизведение машинной части:

```bash
node scripts/compression-metrics.mjs --ref 92432809fcddc290080beb51ba151e13a5761869
```

Историческое сравнение сохраняется в измерителе только как средство измерения:

```bash
node scripts/compression-metrics.mjs \
  --ref 92432809fcddc290080beb51ba151e13a5761869 \
  --compare <older-sha>
```

Это не означает поддержку старой архитектуры в рабочем ядре.

## 2. Физический размер

| Область | Файлы | Строки | Байты |
| --- | ---: | ---: | ---: |
| `src/**` | 62 | 10 471 | 494 446 |
| `schemas/**` | 3 | 1 032 | 38 637 |
| `tests/**` | 89 | 12 832 | 542 830 |
| `docs/**` | 7 | 454 | 35 481 |
| `examples/**` | 4 | 230 | 5 986 |

Совокупная производственная поверхность исходников и схем:

```text
lines = 11 503
bytes = 533 083
```

Тесты и документация намеренно не считаются поверхностью, которую следует сокращать любой ценой. В C3 они могут расти из-за исполняемых сценариев и наблюдаемости.

## 3. Текущая семантическая поверхность

Зарегистрировано шесть семейств правил:

```text
constraintRuleFamily
governancePathsRuleFamily
policyRelaxationRuleFamily
advisoryTextRuleFamily
anchorExtractionRuleFamily
contentRuleFamily
```

Фазы исполнения:

```text
both
state
transaction
```

В публичной схеме семь видов документных отношений:

```text
referenced_paths_exist
referenced_pointer_exists
scalar_equal
scalar_equals_literal
scalar_strictly_greater
set_equal
set_subset
```

Определено четыре вида документных селекторов:

```text
document_repository_path_set_selector
document_scalar_selector
document_string_selector
document_string_set_selector
```

В `Constraint Program` сейчас шесть типов документных фактов:

```text
boolean
repository_path
repository_path_set
scalar
string
string_set
```

В схеме два вида привязки доказательств:

```text
anchor_value_coverage
workflow_path_coverage
```

Текущий `relation-kernel` экспортирует только три операции:

```text
compareSets
implies
maxBound
```

Следовательно, текущее имя ядра не означает, что вся алгебра отношений действительно централизована там. Существенная часть семантики отношений остаётся в `constraint-program.mts` и `constraints.mts`.

Это исходный факт, а не изменение C3.0.

## 4. Знание высокого уровня внутри ядра

`constraint-program.mts` непосредственно знает доменные роли:

```text
current.contract
current.conformance
previous.contract
previous.conformance
acceptance
```

Там же находится специальная карта:

```text
CONTRACT_CONFORMANCE_DOCUMENT_ROLES
```

`policy-profiles.mts` содержит отдельную компиляцию:

```text
compileContractConformancePolicy
```

И там же присутствует пакет:

```text
requirements-strict
```

В текущую проекцию `Constraint Program` непосредственно входят исторические поверхности:

```text
diff_rules
paths
enforcement
size_rules
integration
registry_rules
trace_rules
change_profiles
cochange_rules
document_relations
evidence_bindings
```

Из `ChangeIntent` ядро непосредственно знает:

```text
budgets
surface_debt
scope
must_touch
must_not_touch
```

Это фиксирует исходную связанность. В следующих фазах такое знание должно быть либо сведено к универсальным фактам и отношениям, либо удалено вместе с заменённым исполнением.

## 5. Семантическая и позиционная идентичность

Документные отношения уже имеют семантический ключ на основе `id`:

```text
document-relation:<id>
```

У правил совместного изменения ситуация неоднородна.

Обычное правило получает позиционные идентификаторы:

```text
runtime key = cochange:<index>
strictness owner = cochange-policy:<index>
pointer = /cochange_rules/<index>
```

Одновременно `generatedContractConformanceCochange(...)` пытается распознать в хвосте массива сгенерированный полный ориентированный граф ролей. Для распознанного ребра владелец становится семантическим:

```text
cochange-policy:contract-conformance:<from>-><to>
```

Но рабочий ключ и указатель остаются позиционными.

Таким образом, исходная архитектура содержит смесь семантической и позиционной идентичности. Это отдельная причина для единого дескрипторного реестра в C3.1.

## 6. Проверочный контрпример #366 → #368

#366 требовала универсальное отношение:

```text
BASE VERSION < HEAD VERSION
```

Оно было правильно выражено существующим механизмом документных отношений:

```text
kind = scalar_strictly_greater
comparator = semver
```

Однако добавление одного общего примитива потребовало синхронных изменений в нескольких независимых слоях.

По следу PR #367 затронуты как минимум такие семантические места:

```text
1. schema relation form / kind
2. BASE/HEAD repository snapshot facts
3. Constraint Program selector snapshot compilation
4. Constraint Program relation-kind dispatch
5. execution-phase registration
6. comparator/runtime evaluator dispatch
7. check-diff and GitHub PR fact wiring
8. generated dist mirror
9. tests
```

`dist/**` здесь не считается самостоятельной семантикой, но его необходимость увеличивает физическое число синхронизируемых изменений.

Проверка потребителем затем обнаружила #368.

`policy-compiler.mts` имел отдельный список отношений, потребляющих `left/right`:

```text
scalar_equal
set_equal
set_subset
```

Новый вид в этот независимый переключатель не попал:

```text
scalar_strictly_greater
```

Из-за этого корректные документы считались неиспользуемыми. Дополнительно компилятор отдельно не принимал безрасширительный путь с форматом `plain_text`.

PR #369 исправил оба пропущенных места.

Вывод из проверочного примера:

```text
one generic primitive
→ schema
→ compiler operand switch
→ phase switch
→ Constraint Program switch
→ runtime switch
→ fact plumbing
→ generated mirror
→ tests
```

Текущая архитектура допускает рассинхронизацию этих переключателей. C3.1 обязана сделать вид примитива и его операнды свойствами одного канонического дескриптора.

## 7. Самополитика репозитория

Размер `repo-policy.json`:

```text
7 123 bytes
```

Число верхнеуровневых понятий:

```text
12
```

Их текущий набор:

```text
policy_format_version
repository_kind
enforcement
integration
paths
surfaces
new_file_classes
change_profiles
size_rules
diff_rules
content_rules
cochange_rules
```

Дополнительные количества:

```text
surfaces = 10
new_file_classes = 10
change_profiles = 5
size_rules = 3
content_rules = 2
cochange_rules = 1
integration.workflows = 2
integration.templates = 2
integration.docs = 1
integration.profiles = 1
```

C3.0 не меняет эту политику. Она служит исходным примером того, насколько большой стала поверхность собственного описания.

## 8. Исходное состояние CI

Основной рабочий процесс PR имеет два задания:

```text
validate
smoke-pack
```

Статическая топология исходного состояния:

```text
jobs = 2
npm ci = 2
explicit check:dist = 1
effective check:dist = 2
test = 1
unconditional fetch-depth: 0 = 1
composite action npm install --omit=dev = 1
setup-node mentions = 3
```

Второй проход `check:dist` появляется через `pretest`.

`check:dist` сам выполняет сборку, поэтому это реальное повторение работы, а не только повторная проверка имени файла.

Полная история в `validate` также загружает старые ветки. Это кандидат на C3.8, но не предмет изменения C3.0.

### 8.1 Представительный запуск

Для принятия #369 использован запуск:

```text
Actions run = 33918938534
wall-clock = 61 s
validate runner span ≈ 58 s
smoke-pack runner span ≈ 11 s
summed runner-time proxy ≈ 69 s
```

Ответ GitHub по времени запуска сообщает:

```text
run_duration_ms = 61000
billable.UBUNTU.total_ms = 0
billable jobs = 2
```

Поэтому для этого публичного репозитория зафиксированное значение оплачиваемого времени через API равно нулю. Для оптимизации C3.8 используется также сумма времени заданий как независимый показатель фактической нагрузки.

### 8.2 Чтения GitHub

Статический разбор обычного пути `check-pr` с одной связанной задачей показывает до четырёх чтений API:

```text
1. linked issue for ChangeIntent
2. linked issue again for author/trust context
3. pull request
4. collaborator permission
```

То есть в этом пути есть одно повторное чтение той же задачи.

Переносимый координационный путь делает дополнительные чтения. Представительный диагностический запуск уже показывал:

```text
merged_pr_head_inventory_api_error: spawnSync gh ENOBUFS
```

Поэтому общий счётчик чтений переносимого пути в C3.0 не объявляется точным: текущий запуск не даёт устойчивой полной выборки. Это зафиксированный дефект наблюдаемости для последующего аудита, а не повод выдумывать число.

## 9. Замороженные цели Compression 3

Цели относятся к конечному C3.10, если для отдельной фазы ниже не сказано более строго.

### 9.1 Усиление изменений

Новый общий примитив:

```text
semantic descriptor/kernel edit-sites <= 1
+ schema
+ tests
```

Новая возможность высокого уровня:

```text
canonical-core semantic edit-sites = 0
```

Финальные архитектурные мощности:

```text
canonical evaluator count = 1
canonical FactRef model count = 1
primitive descriptor registry count = 1
methodology-specific evaluator/primitive implementations in canonical core = 0
registered default rule families <= 3
```

Последний предел измеряет поверхность оркестрации. Он не разрешает второй evaluator.

### 9.2 Физическая поверхность

К концу C3.10 совокупные исходники и схемы должны быть меньше исходной точки:

```text
src + schemas lines < 11 503
src + schemas bytes < 533 083
```

Промежуточная фаза может временно увеличить размер только как часть принятой последовательности замены, которая заканчивается удалением старой реализации.

Для `repo-policy.json` конечные цели:

```text
bytes < 7 123
top-level concepts <= 10
```

Тесты, исполняемые сценарии и наблюдаемость не обязаны уменьшаться.

### 9.3 CI и чтения

Конечные цели без ослабления защитных инвариантов:

```text
representative PR wall-clock <= 50 s
summed runner-time proxy <= 55 s
effective check:dist passes = 1
dependency install operations <= 2
unconditional full-history checkouts = 0
normal linked-issue check-pr REST reads <= 3
duplicate linked-issue REST reads = 0
```

Если GitHub продолжает сообщать нулевое оплачиваемое время для публичного репозитория, этот показатель должен оставаться нулевым.

Ни один порог не разрешает:

```text
skip BASE policy
skip proposed HEAD policy
trust unvalidated PR artifact
weaken exact-head checks
turn blocking invariant into advisory
```

## 10. Что C3.0 намеренно не делает

Этот PR не меняет:

```text
src/**
dist/**
schemas/**
repo-policy.json
package.json
package-lock.json
.github/workflows/**
action.yml
```

Он не добавляет новую политику, не меняет язык правил, не оптимизирует CI, не строит сайт, не выпускает новую версию и не вводит поддержку старой архитектуры.

Единственные рабочие изменения этапа находятся в измерителе, его регрессионном тесте и этом отчёте.

## 11. Ворота следующей фазы

Историческое условие C3.1 выполнено: #371 принят в `main` через обычный защищённый процесс.

C3.2 (#373) запрещено начинать до принятия #372 в `main` через тот же защищённый процесс.

Этот документ и машинный измеритель остаются точкой сравнения для C3.1–C3.10.

## 12. C3.1 — каноническая ссылка на факт и единый реестр отношений

C3.1 устанавливает один внутренний тип `FactRef` как каноническую ссылку на типизированный факт. Старые внутренние типы селекторов удалены, а не сохранены как совместимые псевдонимы.

Единственный семантический реестр примитивных документных отношений находится в существующем `relation-kernel.mts`. Отдельный второй реестр не введён.

Все семь видов публичных документных отношений принадлежат этому реестру:

```text
referenced_paths_exist
referenced_pointer_exists
scalar_equal
scalar_equals_literal
scalar_strictly_greater
set_equal
set_subset
```

Рабочее представление документного отношения сведено к одной форме:

```text
primitive_relation
```

`policy-compiler.mts`, `constraint-program.mts` и `constraints.mts` больше не содержат собственных перечней этих семи видов отношений. Потребление операндов, фаза исполнения и вызов вычислителя выводятся из одного дескриптора.

Публичный синтаксис политики на этом этапе не расширен и не изменён. Схема остаётся отдельной структурной границей для недоверенного ввода.

### 12.1 Механическая защита от повторения #368

Тест C3.1 извлекает виды отношений непосредственно из:

```text
schemas/repo-policy.schema.json
  definitions.document_relation_rule.oneOf[*].properties.kind.const
```

и требует точного равенства с:

```text
relationDescriptors()
```

Поэтому расхождение между публичной схемой и рабочим реестром обнаруживается машинно.

Дополнительно `policy-compiler.mts` определяет потребляемые документы через метаданные операндов дескриптора. Ошибка класса #368, когда новый вид отношения забывали добавить в независимый список потребителей, больше не имеет отдельного переключателя, в котором она могла бы возникнуть.

Неизвестный вид отношения завершается закрытым отказом на границе реестра.

### 12.2 Измеримый результат

На проверенном состоянии PR #388:

```text
head = 53ba66c64c18aef741f10ee78ac891c6a4090415
Actions run = 34121242323
validate = success
smoke-pack = success
test files = 74 passed, 0 failed
```

Машинные показатели C3.1:

```text
canonical_factref_model_count = 1
primitive_descriptor_registry_count = 1
primitive_descriptor_kinds = 7
schema_relation_kinds_match_descriptors = true
primitive_runtime_shape_count = 1
independent_document_relation_switches = 0
semantic_edit_sites_per_new_primitive = 1
```

Таким образом, цель C3.0 для нового общего примитива достигнута:

```text
semantic descriptor/kernel edit-sites = 1
+ schema
+ tests
```

Это не означает, что вся программа C3 завершена. Специальное знание о согласованности контракта, правила совместного изменения и исторические семейства ограничений остаются предметом C3.2 и последующих фаз.
