# C3.3e — сжатие integration / parallel / control-plane хвоста

Статус: архитектурное направление для #411 одобрено пользователем в чате 2026-09-09. Этот письменный design должен быть отдельно просмотрен и одобрен до подготовки implementation plan.

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

C3.3e должен удалить последний специальный семантический путь `integration` и одновременно провести breaking-v3 cutover старого parallel/control-plane продукта.

После C3.3e исполняемая policy semantics должна иметь одну форму:

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

Целевое runtime-состояние:

```text
runtime constraint kinds = 1
primitive_relation only
```

Операционная GitHub-интеграция не должна быть скрытым вторым policy evaluator.

## 2. Почему существующий `integration` — архитектурный хвост

В accepted main `evaluateConstraintIR()` имеет два разных semantic dispatch:

```text
integration
  -> integrationConstraintEntries(...)

primitive_relation
  -> evaluatePrimitiveRelation(...)
```

`integrationConstraintEntries()` самостоятельно реализует правила для:

```text
workflow events / event types
Action uses / ref pinning
step inputs
permissions
env/token presence
continue-on-error
run-command запретов
summary publishing
template ChangeIntent blocks
doc mentions / file references
profile mentions
parallel readiness
```

Это второй специальный язык фактов и правил рядом с уже принятым FactRef + relation kernel.

C3.3e не должен просто переименовать этот путь или спрятать его за другим adapter API.

## 3. Коррекция исторических фактов

Историческая parallel-программа #304/#311/#342 не дошла до принятого end-to-end portable self-host proof.

В частности, в #342 планировался реальный concurrent proof:

```text
M0
PR A READY
PR B READY
A -> M1
B refresh/revalidate -> M2
```

Эта acceptance boundary не была завершена; #342 и #311 впоследствии закрыты `not_planned`.

Однако это нельзя превращать в утверждение, что текущий `main` не защищён.

На исходном SHA C3.3e GitHub уже сообщает:

```text
main protected = true
required checks = validate + smoke-pack
```

Поэтому design различает три факта:

```text
historical P6 rollout evidence
!= current branch-protection state
!= proof that portable/parallel product surface is necessary
```

Текущая protection остаётся важной operational safety boundary и не является причиной сохранять старый portable coordinator.

## 4. Принятое архитектурное решение

Выбран максимальный v3 compression approach.

Каждый компонент старого хвоста классифицируется как одно из:

```text
DELETE
LOWER_TO_CANONICAL_FACTS_RELATIONS
RETAIN_AS_SMALL_OPERATIONAL_UTILITY
```

Приоритет:

```text
DELETE
  > LOWER через существующие facts/relations
  > RETAIN operational utility с доказанным текущим consumer
  > новый primitive/source/subsystem
```

Последний вариант запрещён без независимого RED, доказывающего generic capability gap.

Наличие исходного кода, тестов, документации или historical issue не является consumer evidence.

## 5. Hard invariants

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

Четыре FactRef source остаются:

```text
change_intent
diff
document
repository
```

Запрещено добавлять:

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

Если старый integration invariant нельзя выразить текущим finite vocabulary без создания нового специального языка, сначала проверяется, нужен ли этот invariant вообще.

## 6. Финальная судьба `integration` policy DSL

### 6.1. Решение

Top-level:

```text
repo-policy.integration
```

удаляется полностью.

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

Не создавать `integration_v3`, `workflow_relations` или иной replacement DSL.

### 6.2. Почему не pure-lower весь DSL

Большая часть workflow-проверок технически может быть выражена через direct YAML facts и canonical relations. Но механический перенос всех старых expectation полей дал бы только синтаксическое сжатие, а не архитектурное.

Например проверки:

```text
README должен упомянуть слово integration
profile id должен встречаться в README
template должен содержать конкретный fenced block
summary publishing должен существовать
```

не являются необходимыми runtime safety invariants repo-guard.

Они удаляются вместе с DSL, а не переносятся в десятки generic relations.

## 7. Что действительно должно пережить self-host cutover

Self-host correctness после C3.3e строится не на introspection собственного workflow, а на реально исполняемых границах:

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

Эти checks уже являются реальными обязательными GitHub gates.

C3.3e не должен создавать policy rule, который просто повторно доказывает, что workflow содержит текст, предназначенный для запуска этих же checks.

### 7.1. Workflow structural policy

По умолчанию old `integration.workflows` expectations удаляются без replacement relations.

Только если RED докажет конкретный silent-safety failure, который:

1. не блокируется branch protection;
2. не ловится реальным CI execution;
3. не ловится schema/tests;
4. имеет самостоятельную ценность для downstream users;

разрешено выразить этот один invariant существующим `document_relations`.

Новый generic selector/primitive не добавляется ради удобства поиска произвольного Action step.

### 7.2. PR/issue templates

`repo-guard init` продолжает генерировать PR/issue templates как UX scaffold.

Repo-guard больше не обязан семантически проверять, что сами templates содержат ChangeIntent block. Реальный `check-pr` валидирует фактически предоставленный ChangeIntent, а не доказательство происхождения текста из template.

Template generation != template policy semantics.

### 7.3. Documentation mentions

README/profile mention checks удаляются полностью. Документация обновляется как часть public cutover, но упоминания не являются runtime constraints.

## 8. Parallel / provider product surface

### 8.1. Удалить provider model

Удаляются публичные concepts:

```text
portable
github_merge_queue
legacy provider
parallel protocol
repo_guard_portable_coordinator role
repo_guard_merge_group_gate role
```

Это не запрещает GitHub Merge Queue как платформенную функцию. Просто repo-guard v3 не содержит собственного provider abstraction без доказанного consumer need.

### 8.2. Agent lifecycle

`src/agent-lifecycle.mts` и публичный `status` lifecycle protocol удаляются.

Причины:

- модель содержит historical `legacy | portable | github_merge_queue`;
- она не является policy authority;
- она не получила принятого self-host/product proof;
- состояние PR уже существует в GitHub control plane;
- сохранение отдельной state machine создаёт дополнительную концептуальную поверхность.

Не создавать replacement lifecycle enum.

### 8.3. Parallel readiness

Удаляются:

```text
parallel-readiness
parallel-doctor
parallel-control-plane normalization
provider readiness reports
--parallel doctor mode
```

Current branch protection остаётся внешней реальностью GitHub, но repo-guard v3 не обязан моделировать её как отдельную provider readiness product model.

### 8.4. Portable coordinator

Удаляется весь product path:

```text
portable-integration/coordinator
planner
github-read
github-write
public-command
trusted-command
portable-coordinator CLI
portable-coordinator Action mode/inputs
self portable coordinator workflow
READY-label protocol
```

Generic GitHub helpers могут быть сохранены только если dependency audit докажет, что они реально используются оставшимся `check-pr`/doctor functionality. Они не сохраняются ради будущего coordinator.

### 8.5. Merge-group path

Удаляются:

```text
check-merge-group CLI
merge-group provider adapter
native provider-specific scaffold
provider-specific tests/docs/schema enums
```

Будущий state-phase consumer при реальной необходимости должен вызывать canonical evaluator напрямую через заново спроектированную минимальную boundary, а не восстанавливать старый provider subsystem.

## 9. Migration / compatibility machinery

Breaking v3 не поддерживает migration runtime между v2 и old parallel modes.

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

`repo-guard init` остаётся, но только как generator актуального v3 scaffold.

Не должно существовать понятия:

```text
old scaffold -> target scaffold
parallel -> legacy rollback
legacy-compatible init
```

Для существующего репозитория v3 migration — обычное явное изменение repository files через PR, а не специальный runtime repo-guard.

## 10. `init` после cutover

Сохраняется один deterministic scaffold path:

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

Базовый init продолжает генерировать:

```text
repo-policy.json
.github/workflows/repo-guard.yml
.github/PULL_REQUEST_TEMPLATE.md
.github/ISSUE_TEMPLATE/change-intent.yml
```

Scaffold должен использовать immutable Action ref согласно уже принятому v3 contract.

Generated policy не содержит `integration` section.

## 11. `doctor` после cutover

Обычный `repo-guard doctor` сохраняется как operational diagnostics для локальной среды и prerequisites.

Сохраняемые категории:

```text
repository root
git availability/history
repo-policy presence/schema/compiler validity
GitHub event context
auth/gh availability where реально required
```

Удаляются integration-specific paths:

```text
compileIntegrationPolicy
validate-integration alias
--integration
--parallel
parallel readiness
```

Также удаляется или существенно упрощается ad-hoc `workflow-config` regex introspection, если dependency audit подтверждает, что она только дублирует старый integration wiring concern.

Doctor не должен становиться вторым workflow semantics engine после удаления `integration`.

## 12. Public CLI target

После C3.3e целевой CLI surface:

```text
validate
check-diff
check-pr
init
doctor
```

Удаляемые команды:

```text
check-merge-group
status
migrate
portable-coordinator
validate-integration
```

Удаляемые doctor/init options:

```text
doctor --integration
doctor --parallel
doctor --persistent-branch
init --parallel
```

Если `--persistent-branch` dependency audit докажет независимую non-parallel функцию, его судьба должна быть отдельно обоснована в E0 inventory. По умолчанию он относится к old parallel doctor surface и удаляется.

## 13. Composite Action target

`action.yml` после cutover поддерживает только canonical policy execution modes:

```text
check-pr
check-diff
```

Удаляются portable inputs:

```text
repository
ready-label
merge-method
transaction-checks
state-checks
portable coordinator format semantics
```

Удаляется privileged coordinator branch из composite shell.

Не сохранять пустые/deprecated inputs и compatibility aliases.

## 14. Self repository policy после cutover

`repo-policy.json` должен перестать содержать top-level `integration`.

Это intentional breaking self-dogfooding proof: repo-guard сам использует ту же compressed architecture, которую предлагает downstream.

Self policy может использовать существующие generic relations только для тех invariants, которые имеют самостоятельную доказанную ценность.

Запрещено переносить все старые integration expectations 1:1 ради сохранения прежнего количества checks.

После cutover README/docs объясняют self-host через реальные gates:

```text
repo-policy
ChangeIntent
canonical relation evaluator
GitHub required checks
```

а не через `integration profile` vocabulary.

## 15. Implementation slicing

Implementation выполняется только после отдельного одобрения этого design и отдельного implementation plan.

Предпочтительная последовательность:

### E3a — удалить compatibility / agent / migration surface

Физически удалить:

```text
status/agent lifecycle
migrate/migration plan/apply
legacy provider/protocol
parallel init generation
related schema/docs/tests/dist
```

Цель: убрать явно противоречащий v3 compatibility слой до semantic lowering.

### E3b — удалить недоказанный provider/control-plane product

Физически удалить:

```text
portable coordinator
parallel readiness/doctor/control-plane
merge-group provider path
Action portable mode
self portable workflow
provider-specific examples/tests/docs/dist
```

Сохранить только реально reachable generic GitHub utilities.

### E3c — удалить final `integration` semantic runtime

В одном acceptance boundary:

```text
remove repo-policy.integration from self policy
remove integration schema/compiler/strictness/extractor
remove integrationConstraintEntries
remove runtime kind integration
remove validate-integration
remove CI validate-integration/parallel-readiness steps
update docs/examples/templates/tests/dist
```

Target:

```text
runtime constraint kinds: 2 -> 1
primitive_relation only
```

Если E3c требует retained structural invariant, сначала RED, затем existing document FactRef + existing relation; не добавлять новый integration primitive.

### E3d — C3.3 broad closure audit

После физического удаления повторно измерить:

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

C3.3e не закрывает автоматически #374. После E3d требуется отдельный parent acceptance review.

## 16. TDD и evidence discipline

Каждый implementation slice должен начинаться с тестового RED, фиксирующего именно ожидаемую новую архитектуру.

Для deletion slice RED означает, например:

```text
public command должен отсутствовать
schema должен отвергать removed vocabulary
runtime-kind ratchet должен требовать только primitive_relation
source reachability test должен запрещать legacy module
self policy fixture должен не содержать integration
```

Не писать сначала production deletion, а потом подгонять tests.

После GREEN каждый slice требует:

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

## 17. Governance/public-surface discipline

В отличие от C3.3d2/d3, C3.3e намеренно должен менять governance/public files, потому что удаляется публичный продуктовый surface.

Допустимые по design категории изменений:

```text
repo-policy.json
schemas/**
action.yml
.github/workflows/**
README/docs/examples/templates
src/dist/tests
```

Но каждый PR должен иметь узкий GovernanceGrant, разрешающий только реально необходимую часть.

Public deletion и её schema/docs/Action/CLI отражение выполняются в одном slice. Не допускается финальный «legacy cleanup later».

## 18. Что не является compatibility contract

Не сохраняются:

```text
старые CLI команды
старые Action inputs
старые integration policy fields
старые provider names
старые lifecycle states
старые migration dry-run outputs
старые diagnostic result names
старые generated parallel workflows
```

Это intentional v3 breaking cutover.

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

### Риск: удалить реально полезный generic GitHub helper

Контрмера: E0 reachability audit перед физическим удалением; shared helper сохраняется только если reachable из retained non-parallel command.

### Риск: ослабить self-host workflow незаметно

Контрмера: required GitHub checks `validate` + `smoke-pack` остаются protection boundary; каждый PR проходит их на exact head, post-merge снова проходит их на exact merge SHA.

### Риск: заменить integration DSL огромным набором document relations

Контрмера: никаких 1:1 migrations. Generic relation добавляется только для independently justified invariant.

### Риск: спрятать старый readiness engine в doctor

Контрмера: doctor после cutover — diagnostics prerequisites, не policy/workflow semantics evaluator.

### Риск: future parallel integration снова потребуется

Контрмера: будущая capability проектируется заново от concrete consumer proof поверх compressed kernel. Historical provider abstractions не сохраняются «на всякий случай».

## 20. Acceptance C3.3e

C3.3e может быть объявлен accepted только если одновременно истинно:

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

Отдельно должно быть доказано, что current branch protection продолжает требовать реальные accepted checks после workflow cutover.

## 21. Completion boundary относительно #374

Даже если C3.3e достигнет:

```text
runtime kinds = 1
```

это ещё не автоматическое завершение #374.

После C3.3e родитель #374 получает отдельный финальный review:

```text
rule_families
semantic_edit_sites
remaining historical public DSL
remaining specialized runtime/compilers
physical code/schema compression
self-host exemplar quality
```

Только после этого C3.3 считается полностью accepted и можно переходить к следующему этапу Architecture Compression 3.0.
