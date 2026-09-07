# C3.2 — Structural compression and pure macro lowering

Дата: 2026-09-07

Issue: #373

Принятая база дизайна: `6791fa3d842bb3031869d602601565a9e334fd1f`

## 1. Цель

C3.2 удаляет high-level/methodology-specific знание из canonical core и заменяет специальную обработку `contract_conformance.cochange` на одну универсальную структурную конструкцию.

После понижения высокоуровневого пакета должно выполняться:

```text
source pack vocabulary
    ↓ pure lowering
canonical policy / facts / constraints
```

Canonical Constraint Program, policy comparison и runtime evaluator не должны знать роли:

```text
current.contract
current.conformance
previous.contract
previous.conformance
acceptance
```

Эти роли допустимы только внутри high-level compiler/lowering слоя.

## 2. Текущее состояние и проблема

На базе C3.1 `contract_conformance` уже компилируется в generic `document_relations`, но `cochange` остаётся специальным случаем.

Сейчас high-level compiler делает следующее:

```text
contract_conformance.cochange = [r1, r2, ..., rN]
    ↓
N × (N - 1) directed cochange_rules
```

Для пяти ролей это даёт двадцать направленных правил.

Затем canonical `constraint-program.mts` пытается восстановить потерянное high-level происхождение:

```text
ordinary cochange_rules
    ↓ reverse recognition
contract-conformance role edges
```

Для этого core содержит:

- `ContractConformanceRole`;
- `CONTRACT_CONFORMANCE_DOCUMENT_ROLES`;
- `contractConformanceRolesByPath(...)`;
- `cochangeRoleEdge(...)`;
- `generatedContractConformanceCochange(...)`;
- отдельную generated-edge identity и диагностику.

Это нарушает pure lowering invariant: high-level смысл сначала уничтожается, затем canonical core пытается его восстановить.

Дополнительная проблема — positional identity обычных `cochange_rules`:

```text
cochange:<index>
cochange-policy:<index>
/cochange_rules/<index>
```

Она зависит от порядка массива и не выражает семантическую сущность ограничения.

## 3. Выбранное решение

Вводится одна generic canonical конструкция:

```json
{
  "cochange_groups": [
    {
      "id": "contract-conformance",
      "members": [
        "contracts/current.json",
        "conformance/current.json",
        "contracts/previous.json",
        "conformance/previous.json",
        "acceptance.json"
      ]
    }
  ]
}
```

Она domain-neutral. Ядро не знает, почему эти пути образуют группу.

### 3.1. Семантика

Для группы `members` определяется:

```text
C = changed_paths ∩ members

PASS ⇔ C = ∅ ∨ C = members
```

То есть:

- не изменился ни один участник — PASS;
- изменились все участники — PASS;
- изменилось любое непустое собственное подмножество — FAIL.

Это exactly-all-or-none constraint.

### 3.2. Область применения

Generic конструкция подходит не только для contract/conformance:

```text
schema + generated types
manifest + lockfile
contract + conformance
VERSION + release metadata
API spec + generated client
```

Наличие нескольких независимых применений — обязательное обоснование того, что primitive действительно generic, а не скрытый methodology-specific runtime.

## 4. Pure lowering `contract_conformance`

`policy-profiles.mts` остаётся единственным слоем, который имеет право знать high-level роли.

Понижение выполняется так:

```text
contract_conformance.cochange roles
    ↓ resolve role -> canonical repository path
one cochange_group
```

Например:

```text
[current.contract, current.conformance, acceptance]
    ↓
cochange_group {
  id: "contract-conformance",
  members: [<current-contract-path>, <current-conformance-path>, <acceptance-path>]
}
```

После `resolvePolicyProfile()` в canonical policy не остаётся role vocabulary.

Никаких generated directional edges для этого macro больше нет.

## 5. Canonical identity

У группы semantic identity:

```text
cochange-group:<id>
```

Runtime key, strictness owner и policy comparison должны опираться на `id`, а не на позицию массива.

Порядок `cochange_groups` не влияет на identity.

Порядок `members` также не должен менять семантику. Для сравнения members нормализуются как множество canonical repository paths.

## 6. Policy comparison / strictness

Сама сущность группы является required entity:

```text
owner = cochange-group:<id>
relation = required_entity
```

Удаление группы — policy relaxation.

Изменение `members` в C3.2 трактуется как:

```text
equal_or_incomparable
```

Причина: ни добавление, ни удаление участника не задаёт общий безопасный монотонный порядок. Такое изменение может усиливать одни допустимые переходы и ослаблять другие.

C3.2 не вводит фиктивную strictness только ради удобства сравнения.

## 7. Runtime model

Предпочтительная canonical runtime shape:

```text
kind: cochange_group
name: <semantic owner>
members: <canonical path set>
```

Execution phase:

```text
transaction
```

Runtime evaluator получает только diff facts / changed paths и список `members`.

Он не получает:

- contract/conformance roles;
- source macro metadata;
- generated-edge metadata;
- positional index как semantic identity.

Вторая evaluator-система не создаётся.

## 8. Отношение к существующим `cochange_rules`

Существующие directed `cochange_rules` имеют другую семантику:

```text
if A changed => at least one path from B changed
```

Поэтому C3.2 не объявляет их автоматически эквивалентными `cochange_group`.

Правило решения:

1. `contract_conformance` перестаёт генерировать directed `cochange_rules` безусловно.
2. Reverse recognition generated contract-conformance edges удаляется без legacy adapter.
3. Обычные generic `cochange_rules` сохраняются только если аудит обнаруживает реальную независимую ценность/потребителя.
4. Если аудит показывает, что они полностью поглощаются новой архитектурой без потери generic capability, они удаляются в том же accepted sequence.

Никакого compatibility alias между `cochange_rules` и `cochange_groups` не вводится.

## 9. Canonical core после cutover

Из `constraint-program.mts` должны исчезнуть все methodology-specific элементы:

```text
ContractConformanceRole
CONTRACT_CONFORMANCE_DOCUMENT_ROLES
contractConformanceRolesByPath
ochangeRoleEdge
generatedContractConformanceCochange
current.contract
current.conformance
previous.contract
previous.conformance
acceptance
```

Исправление опечатки выше не создаёт нового символа: фактический удаляемый helper называется `cochangeRoleEdge`.

Core должен видеть только generic:

```text
cochange_groups
id
members
changed_paths
```

## 10. Публичная схема

`cochange_groups` является canonical public policy syntax, а не скрытым IR.

Минимальная structural schema:

```json
{
  "cochange_groups": [
    {
      "id": "string",
      "members": ["repository/path", "repository/path"]
    }
  ]
}
```

Structural validation должна требовать:

- непустой `id`;
- минимум два distinct members;
- canonical repository paths;
- отсутствие duplicates внутри members;
- уникальный `id` среди групп.

High-level compiler обязан генерировать валидную canonical форму и не полагаться на runtime normalization для исправления malformed macro output.

## 11. Диагностика

FAIL должен сообщать semantic group id и полный набор изменённых/пропущенных участников, например:

```text
cochange group "contract-conformance" requires all members to change together
changed: [contracts/current.json]
missing: [conformance/current.json, acceptance.json]
```

Диагностика не должна упоминать:

- generated edges;
- role reconstruction;
- array index;
- внутреннюю историю lowering.

## 12. Falsifier / TDD contract

Первый RED должен доказать архитектуру, а не только одно поведение.

Для пяти contract roles:

```text
high-level roles = 5
canonical cochange groups = 1
canonical generated directed edges = 0
```

Behavior matrix:

```text
0 changed        -> PASS
1 changed        -> FAIL
2..N-1 changed   -> FAIL
N changed        -> PASS
```

Identity checks:

```text
reorder unrelated policy arrays -> same group identity
reorder cochange_groups         -> same group identity
reorder members                 -> same semantic shape
```

Core vocabulary checks:

```text
constraint-program.mts contains none of:
  current.contract
  current.conformance
  previous.contract
  previous.conformance
  acceptance
  CONTRACT_CONFORMANCE_DOCUMENT_ROLES
  generatedContractConformanceCochange
```

## 13. Compression metrics

C3.2 должна измеримо уменьшить архитектурную амплификацию.

Acceptance metrics:

```text
contract-conformance role vocabulary in canonical core = 0
generated-edge recognition helpers = 0
generated cochange constraints for N roles = 1
positional identity for macro-generated cochange = 0
high-level pack semantic edit-sites in canonical core = 0
```

Новая primitive допустима только если итоговый architecture concept/edit-site count уменьшается относительно accepted C3.1 state.

Tests, scenarios и observability не обязаны уменьшаться.

## 14. Документация

Так как `cochange_groups` становится public canonical syntax, тот же PR обязан синхронизировать:

- schema descriptions;
- README / architecture docs, где перечислена canonical policy surface;
- examples, если там показывается cochange;
- Compression 3 metrics/observability, если они учитывают structural primitives.

Русский остаётся основным языком пользовательской архитектурной документации; identifiers и machine syntax остаются техническими.

## 15. No legacy / forbidden outcomes

Запрещено:

- сохранять reverse-recognition helper под deprecated именем;
- поддерживать одновременно generated N² contract-conformance edges и canonical group;
- добавлять `contract_conformance` awareness в runtime evaluator;
- вводить второй evaluator;
- делать arbitrary predicate/expression language;
- делать `cochange_group` специальным contract primitive;
- сохранять positional identity для macro-generated group;
- ослаблять repo-guard self-policy ради прохождения C3.2.

## 16. Предлагаемая implementation boundary

Ожидаемая зона изменений:

```text
src/policy-profiles.mts
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
schemas/**
tests/**
dist/**
README.md / docs / examples — только если затронута соответствующая public surface
scripts/compression-metrics.mjs — только для измеримого C3.2 acceptance
```

Не предполагаются изменения:

```text
package.json version
release/tag
GitHub Pages
CI optimization
external consumer validation
```

Эти работы принадлежат более поздним фазам C3.

## 17. Acceptance

C3.2 считается принятой только если одновременно доказано:

1. high-level `contract_conformance` компилируется полностью до domain-neutral canonical policy;
2. для macro cochange создаётся одна `cochange_group`, а не N² edges;
3. canonical core не содержит contract/conformance role vocabulary;
4. reverse recognition полностью удалён;
5. identity группы semantic и не зависит от позиции;
6. unknown/malformed structure fail closed на schema/compiler boundary;
7. runtime semantics all-or-none доказана тестами;
8. policy comparison не придумывает ложный monotonic ordering для member changes;
9. generated dist current;
10. self repo-guard, `validate`, `smoke-pack` GREEN;
11. документация синхронизирована;
12. ни одного legacy alias/adapter не осталось.
