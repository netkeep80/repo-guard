# C3.3e — сжатие хвоста `integration`, параллельного режима и управляющего слоя

Статус: письменная архитектурная спецификация для #411 просмотрена и одобрена пользователем 2026-09-09. До отдельного плана реализации производственный код не меняется.

Связанные задачи:

```text
#370 — Architecture Compression 3.0
#374 — C3.3 historical-family lowering
#398 — C3.3d runtime-tail convergence, accepted/closed
#411 — C3.3e integration + parallel/control-plane audit
```

Исходное принятое состояние:

```text
main = 52b3575eacebdc93cbc61dbe9239e5f2f5b55d0a
canonical C3.0 measurement baseline = 92432809fcddc290080beb51ba151e13a5761869
runtime constraint kinds = integration + primitive_relation
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
broad watchpoint: semantic_edit_sites = 16, rule_families = 12
```

## 1. Цель

C3.3e должен удалить последний специальный семантический путь `integration` и одновременно выполнить несовместимый переход третьей версии для старого параллельного и управляющего продукта.

После C3.3e исполняемая семантика политик должна иметь одну форму:

```text
high-level policy syntax
        ↓
finite typed facts
        ↓
one canonical FactRef model
        ↓
finite relation algebra
        ↓
primitive_relation
        ↓
one semantic evaluator
```

Целевое исполняемое состояние:

```text
runtime constraint kinds = 1
primitive_relation only
```

Операционная интеграция с GitHub не должна быть скрытым вторым интерпретатором политики.

## 2. Почему существующий `integration` является архитектурным хвостом

В принятом `main` функция `evaluateConstraintIR()` имеет два независимых семантических перехода:

```text
integration
  -> integrationConstraintEntries(...)

primitive_relation
  -> evaluatePrimitiveRelation(...)
```

Функция `integrationConstraintEntries()` самостоятельно реализует проверки для нескольких несвязанных областей:

```text
workflow events / event types
Action uses / ref pinning
step inputs
permissions
env/token presence
continue-on-error
run-command restrictions
summary publishing
template ChangeIntent blocks
doc mentions / file references
profile mentions
parallel readiness
```

Это второй специальный язык фактов и правил рядом с уже принятыми `FactRef` и конечной алгеброй отношений.

C3.3e не должен переименовывать этот путь или прятать его за новым интерфейсом.

## 3. Коррекция исторических фактов

Историческая параллельная программа #304/#311/#342 не дошла до принятого сквозного доказательства переносимого самоприменения.

В #342 планировался реальный конкурентный переход:

```text
M0
PR A READY
PR B READY
A -> M1
B refresh/revalidate -> M2
```

Эта граница приёмки не была завершена. Задачи #342 и #311 позднее закрыты как `not_planned`.

Это не означает, что текущая основная ветка не защищена. На исходном состоянии C3.3e GitHub сообщает:

```text
main protected = true
required checks = validate + smoke-pack
```

Спецификация различает три факта:

```text
historical P6 rollout evidence
!= current branch-protection state
!= proof that portable/parallel product surface is necessary
```

Текущая защита ветки остаётся реальной границей безопасности, но не доказывает необходимость старого переносимого координатора.

## 4. Принятое архитектурное решение

Выбран вариант максимального сжатия третьей версии.

Каждый компонент старого хвоста имеет только одну из трёх судеб:

```text
DELETE
LOWER_TO_CANONICAL_FACTS_RELATIONS
RETAIN_AS_SMALL_OPERATIONAL_UTILITY
```

Приоритет решений:

```text
DELETE
  > LOWER through existing facts/relations
  > RETAIN operational utility with proven current consumer
  > new primitive/source/subsystem
```

Последний вариант запрещён без независимого красного теста, который доказывает общий пробел возможностей.

Само наличие исходного кода, тестов, документации или исторической задачи не считается доказательством потребителя.

## 5. Жёсткие инварианты

После C3.3e должны выполняться:

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
semantic evaluators = 1
runtime constraint kinds = 1
compatibility aliases = NONE
legacy provider/protocol = NONE
v2 migration/rollback machinery = NONE
```

Четыре источника `FactRef` остаются неизменными:

```text
change_intent
diff
document
repository
```

Без отдельного доказательства запрещено добавлять:

```text
integration FactRef source
workflow FactRef source
provider FactRef source
integration_* relation primitive
provider_* relation primitive
arbitrary recursive YAML query language
JMESPath/XPath-like policy expression language
second YAML parser for policy semantics
second readiness/policy evaluator
legacy compatibility alias
transitional old/new runtime surviving accepted merge
```

Если старый инвариант `integration` нельзя выразить текущим конечным словарём без нового специального языка, сначала проверяется необходимость самого инварианта.

## 6. Финальная судьба языка политики `integration`

Поле верхнего уровня удаляется полностью:

```text
repo-policy.integration
```

Вместе с ним удаляются:

```text
integration.workflows
integration.templates
integration.docs
integration.profiles
workflow roles
integration-specific expect DSL
integration compiler validation
integration strictness entries
integration extraction facts
integration runtime dispatch
validate-integration semantic command
```

Нельзя создавать замену вроде `integration_v3`, `workflow_relations` или другого специального языка.

### 6.1. Почему нельзя механически переносить весь старый язык

Большая часть проверок рабочих процессов технически может быть выражена прямыми фактами документов и каноническими отношениями. Но перенос всех старых ожиданий один к одному дал бы лишь переименование, а не архитектурное сжатие.

Например следующие проверки не являются необходимыми инвариантами безопасности исполнения:

```text
README must mention integration
profile id must occur in README
template must contain a particular fenced block
summary publishing must exist
```

Они удаляются вместе со старым языком, а не переводятся в десятки общих отношений.

## 7. Что действительно должно пережить самоприменение

Корректность самоприменения после C3.3e строится на реально исполняемых границах:

```text
GitHub branch protection
  requires validate + smoke-pack

validate
  -> policy/schema validation
  -> dist freshness
  -> compression metrics
  -> ordinary doctor prerequisites
  -> discovered test suite
  -> exact PR policy check on ready PR

smoke-pack
  -> packaged artifact proof
```

Эти проверки уже являются обязательными воротами GitHub. Политика не должна повторно доказывать текстовое устройство рабочего процесса, который запускает те же проверки.

### 7.1. Структурная политика рабочих процессов

По умолчанию старые ожидания `integration.workflows` удаляются без заменяющих отношений.

Сохранить отдельный структурный инвариант можно только после красного теста, если одновременно доказано, что он:

1. не защищён настройкой ветки;
2. не ловится реальным исполнением непрерывной интеграции;
3. не ловится схемой или тестами;
4. имеет самостоятельную ценность для внешних потребителей.

В таком случае используется существующий механизм `document_relations`. Новый селектор или примитив ради поиска произвольного шага рабочего процесса не добавляется.

### 7.2. Шаблоны запросов на изменение и задач

Команда `repo-guard init` продолжает генерировать шаблоны как удобную заготовку.

Сам инструмент больше не обязан семантически доказывать, что шаблон содержит блок `ChangeIntent`. Команда `check-pr` проверяет фактически предоставленное намерение изменения.

Генерация шаблона не является семантикой политики шаблона.

### 7.3. Упоминания в документации

Проверки упоминаний в `README` и профилях удаляются полностью. Документация обновляется вместе с публичным переходом, но сами упоминания не являются исполняемыми ограничениями.

## 8. Параллельная и провайдерная поверхность продукта

### 8.1. Удаление модели провайдеров

Удаляются публичные понятия:

```text
portable
github_merge_queue
legacy provider
parallel protocol
repo_guard_portable_coordinator role
repo_guard_merge_group_gate role
```

Это не запрещает очередь слияния GitHub как внешнюю функцию платформы. Третья версия просто не содержит собственной провайдерной абстракции без доказанного потребителя.

### 8.2. Жизненный цикл агента

Файл `src/agent-lifecycle.mts` и публичный протокол команды `status` удаляются.

Основания:

- модель содержит исторические варианты `legacy`, `portable` и `github_merge_queue`;
- она не является источником истины политики;
- она не получила принятого продуктового доказательства;
- состояние запроса на изменение уже существует в управляющем слое GitHub;
- отдельная машина состояний создаёт лишнюю концептуальную поверхность.

Новый перечислимый тип жизненного цикла не создаётся.

### 8.3. Готовность параллельного режима

Удаляются:

```text
parallel-readiness
parallel-doctor
parallel-control-plane normalization
provider readiness reports
--parallel doctor mode
```

Текущая защита ветки остаётся внешним фактом GitHub, но инструмент больше не моделирует её отдельным продуктом готовности провайдера.

### 8.4. Переносимый координатор

Удаляется весь продуктовый путь:

```text
portable-integration/coordinator
portable-integration/planner
portable-integration/github-read
portable-integration/github-write
portable-integration/public-command
portable-integration/trusted-command
portable-coordinator CLI
portable-coordinator Action mode/inputs
self portable coordinator workflow
READY-label protocol
```

Общие вспомогательные функции GitHub могут остаться только после аудита достижимости, если они реально нужны сохранённым командам `check-pr` или `doctor`. Они не сохраняются на будущее.

### 8.5. Путь группы слияния

Удаляются:

```text
check-merge-group CLI
merge-group provider adapter
native provider-specific scaffold
provider-specific tests/docs/schema enums
```

Если позднее появится реальный потребитель фазы состояния, минимальная граница проектируется заново поверх канонического вычислителя, а старый провайдерный слой не восстанавливается автоматически.

## 9. Миграция и совместимость

Несовместимая третья версия не поддерживает специальную миграцию между второй версией и старым параллельным режимом.

Удаляются:

```text
migrate CLI
migration-plan
migration-apply
known v2 scaffold detection
legacy/parallel scaffold matching
parallel rollback
provider switch rollback
legacy fallback semantics
```

Команда `repo-guard init` сохраняется только как генератор актуальной заготовки третьей версии.

Не должно оставаться понятий:

```text
old scaffold -> target scaffold
parallel -> legacy rollback
legacy-compatible init
```

Переход существующего внешнего репозитория на третью версию является обычным явным запросом на изменение файлов репозитория, а не отдельной подсистемой инструмента.

## 10. Команда `init` после перехода

Сохраняется один детерминированный путь:

```text
repo-guard init
```

Удаляются:

```text
--parallel
ParallelProvider
parallelIntegration()
parallelTransactionWorkflow()
portableCoordinatorWorkflow()
nativeMergeGroupWorkflow()
```

Базовая команда продолжает генерировать:

```text
repo-policy.json
.github/workflows/repo-guard.yml
.github/PULL_REQUEST_TEMPLATE.md
.github/ISSUE_TEMPLATE/change-intent.yml
```

Ссылка на действие должна оставаться неизменяемой согласно уже принятому контракту. Генерируемая политика не содержит раздел `integration`.

## 11. Команда `doctor` после перехода

Обычная команда `repo-guard doctor` сохраняется как диагностика операционных предпосылок.

Сохраняемые категории:

```text
repository root
git availability/history
repo-policy presence/schema/compiler validity
GitHub event context
auth/gh availability where required
```

Удаляются специальные пути интеграции и параллельного режима:

```text
compileIntegrationPolicy
validate-integration alias
doctor --integration
doctor --parallel
doctor --persistent-branch
parallel readiness
```

Функция `checkWorkflowConfig()` с регулярными выражениями удаляется полностью. После C3.3e команда `doctor` не анализирует семантику рабочих процессов и не ищет текстовые признаки `fetch-depth`, токена или вызова инструмента в файлах `.github/workflows/**`.

Причина: это ещё один специальный путь семантики рабочих процессов рядом с `integration`. Реальные исполнения непрерывной интеграции и защита ветки являются авторитетными доказательствами самоприменения.

После перехода `doctor` проверяет предпосылки, а не интерпретирует политику рабочего процесса.

## 12. Целевая публичная командная строка

После C3.3e остаются:

```text
validate
check-diff
check-pr
init
doctor
```

Удаляются:

```text
check-merge-group
status
migrate
portable-coordinator
validate-integration
```

Удаляются параметры:

```text
doctor --integration
doctor --parallel
doctor --persistent-branch
init --parallel
```

Параметр `--persistent-branch` удаляется вместе со старой диагностикой параллельного режима без замены.

## 13. Целевое составное действие

Файл `action.yml` после перехода поддерживает только два режима канонического исполнения политики:

```text
check-pr
check-diff
```

Удаляются переносимые входы:

```text
repository
ready-label
merge-method
transaction-checks
state-checks
portable coordinator format semantics
```

Удаляется привилегированная ветвь оболочки координатора. Пустые или устаревшие входы и псевдонимы совместимости не сохраняются.

## 14. Собственная политика репозитория после перехода

Файл `repo-policy.json` должен перестать содержать верхний раздел `integration`.

Это намеренное самоприменение несовместимой третьей версии: инструмент сам использует ту же сжатую архитектуру, которую предлагает внешним потребителям.

Собственная политика может использовать существующие общие отношения только для инвариантов с самостоятельной доказанной ценностью.

Нельзя переносить старые ожидания `integration` один к одному ради сохранения прежнего числа проверок.

После перехода документация объясняет самоприменение через реальные границы:

```text
repo-policy
ChangeIntent
canonical relation evaluator
GitHub required checks
```

а не через старый словарь профилей `integration`.

## 15. Разбиение реализации

Реализация начинается только после принятия этой спецификации и создания отдельного подробного плана.

Предпочтительная последовательность:

### E3a — удалить совместимость, агентский и миграционный слой

Физически удалить:

```text
status/agent lifecycle
migrate/migration plan/apply
legacy provider/protocol
parallel init generation
related schema/docs/tests/dist
```

Цель — убрать слой, прямо противоречащий третьей версии, до сжатия семантики.

### E3b — удалить недоказанный провайдерный и управляющий продукт

Физически удалить:

```text
portable coordinator
parallel readiness/doctor/control-plane
merge-group provider path
Action portable mode
self portable workflow
provider-specific examples/tests/docs/dist
```

Сохраняются только реально достижимые общие вспомогательные функции GitHub.

### E3c — удалить финальный семантический путь `integration`

В одной границе приёмки:

```text
remove repo-policy.integration from self policy
remove integration schema/compiler/strictness/extractor
remove integrationConstraintEntries
remove runtime kind integration
remove validate-integration
remove CI validate-integration/parallel-readiness steps
update docs/examples/templates/tests/dist
```

Цель:

```text
runtime constraint kinds: 2 -> 1
primitive_relation only
```

Если для E3c нужен сохраняемый структурный инвариант, сначала создаётся красный тест, затем используются существующие `document`-факты и существующее отношение. Новый специальный примитив не добавляется.

### E3d — широкий аудит закрытия C3.3

После физического удаления повторно измеряются:

```text
runtime kinds
rule families
semantic edit sites
src files / lines / bytes
schema surface
CLI commands/options
Action inputs/modes
provider/migration concepts
FactRef models/sources
relation descriptors
```

C3.3e не закрывает автоматически #374. После E3d нужен отдельный обзор принятия родительской задачи.

## 16. Дисциплина тестирования и доказательств

Каждый срез реализации начинается с тестового красного состояния, фиксирующего ожидаемую новую архитектуру.

Для среза удаления красный тест может требовать:

```text
public command must be absent
schema must reject removed vocabulary
runtime-kind ratchet must require primitive_relation only
source reachability test must reject legacy module
self policy fixture must not contain integration
```

Нельзя сначала удалить производственный код, а затем подогнать тесты.

После зелёного состояния каждый срез требует:

```text
focused tests GREEN
full discovered suite GREEN
dist fresh
self policy GREEN
compression metrics against 92432809fcddc290080beb51ba151e13a5761869
ready-state validate + smoke-pack + Run PR policy check GREEN
exact-head merge
post-merge validate + smoke-pack GREEN on exact merge SHA
```

## 17. Дисциплина управляющих и публичных файлов

C3.3e намеренно меняет управляющие и публичные файлы, потому что удаляется публичная поверхность продукта.

Допустимые по спецификации категории:

```text
repo-policy.json
schemas/**
action.yml
.github/workflows/**
README/docs/examples/templates
src/dist/tests
```

Каждый запрос на изменение должен иметь узкое разрешение `GovernanceGrant`, допускающее только реально необходимые пути.

Публичное удаление и соответствующие изменения схемы, документации, действия и командной строки выполняются в одном срезе. Финальная отложенная очистка совместимости запрещена.

## 18. Что не является контрактом совместимости

Не сохраняются:

```text
old CLI commands
old Action inputs
old integration policy fields
old provider names
old lifecycle states
old migration dry-run outputs
old diagnostic result names
old generated parallel workflows
```

Это намеренный несовместимый переход третьей версии.

Сохраняется смысл ядра:

```text
policy validation
ChangeIntent validation
canonical diff/state facts
canonical relation evaluation
fail-closed fact acquisition/evaluation
blocking/advisory enforcement
self-host CI gates
```

## 19. Риски и контрмеры

### Риск: удалить полезную общую функцию GitHub

Контрмера: перед физическим удалением выполняется аудит достижимости. Общая функция сохраняется только при реальном вызове из сохраняемой непараллельной команды.

### Риск: незаметно ослабить самоприменение

Контрмера: обязательные проверки GitHub `validate` и `smoke-pack` остаются границей защиты. Каждый запрос проходит их на точной вершине, а после слияния они повторяются на точном принятом состоянии.

### Риск: заменить старый язык огромным набором отношений документов

Контрмера: перенос один к одному запрещён. Новое общее отношение возможно только для независимо доказанного инварианта.

### Риск: спрятать старый механизм готовности в `doctor`

Контрмера: текстовый анализ рабочих процессов и параллельная диагностика удаляются. Команда `doctor` остаётся только проверкой предпосылок.

### Риск: параллельная интеграция понадобится позднее

Контрмера: будущая возможность проектируется заново от конкретного доказанного потребителя поверх сжатого ядра. Исторические провайдерные абстракции не сохраняются заранее.

## 20. Приёмка C3.3e

C3.3e может быть объявлен принятым только при одновременном выполнении:

```text
runtime kinds = primitive_relation only
no integration dispatch
no integration policy DSL
no integration extractor/evaluator
no validate-integration command
no legacy provider/protocol
no migration/rollback machinery
no portable coordinator product path
no parallel readiness/provider model
no merge-group provider command
no agent lifecycle/status protocol
no doctor workflow-config semantics path
init has one non-parallel scaffold path
action.yml has no portable coordinator mode/inputs
self policy has no integration section
self CI has no validate-integration/parallel-readiness dependency
FactRef models = 1
FactRef sources = 4
relation descriptors = 10 unless separate RED explicitly proves a generic gap
full exact-head and post-merge evidence GREEN
broad rule-family/edit-site metrics re-measured
```

Отдельно должно быть доказано, что текущая защита основной ветки продолжает требовать реальные принятые проверки после изменения рабочего процесса.

## 21. Граница завершения относительно #374

Даже достижение:

```text
runtime kinds = 1
```

не завершает #374 автоматически.

После C3.3e родительская задача получает отдельный финальный обзор:

```text
rule_families
semantic_edit_sites
remaining historical public DSL
remaining specialized runtime/compilers
physical code/schema compression
self-host exemplar quality
```

Только после этого C3.3 считается полностью принятым и можно переходить к следующему этапу Architecture Compression 3.0.
