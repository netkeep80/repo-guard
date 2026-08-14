# Миграция на repo-guard v2.0.0

`v2.0.0` фиксирует новую несовместимую публичную границу `repo-guard`: чистую терминологию ChangeIntent, strict TypeScript source boundary и generic contract/conformance governance.

## Что изменилось несовместимо

### PR intent: `contract` → `ChangeIntent`

Сущность, описывающая намерение изменения PR, теперь называется только `ChangeIntent`.

- используйте блок `repo-guard-yaml` с полями `change_type`, `scope`, `budgets`, `anchors`, `must_touch`, `must_not_touch`, `expected_effects`;
- старые PR-level `contract` aliases и DSL удалены;
- термин `contract` освобождён для настоящих versioned machine/release contracts проекта.

### Шаблон задачи

Старое имя шаблона `change-contract.*` заменено на `change-intent.*`.

`repo-guard init` создаёт `.github/ISSUE_TEMPLATE/change-intent.yml`.

### GovernanceGrant отделён от ChangeIntent

`ChangeIntent` не выдаёт PR управляющих разрешений. Изменение governance paths или разрешённое ослабление политики требует отдельного доверенного `GovernanceGrant`, прочитанного из связанной задачи.

PR не может авторизовать собственное ослабление политики.

## Source и distribution boundary

Канонический редактируемый runtime находится только в strict TypeScript `src/**/*.mts`.

`dist/**/*.mjs` — checked generated build output для npm/GitHub Action. Он должен воспроизводиться штатным compiler/build и проходить `npm run check:dist`; `dist` не является вторым source tree.

## Contract/conformance governance

v2 добавляет generic, data-driven capability без domain-specific validator:

```text
DocumentFacts
  → exact JSON Pointer / typed scalar-set-path facts
  → generic document relations
  → Constraint Program
  → contract-conformance macro + evidence bindings
```

Capability умеет выражать current/previous contract-conformance topology, acceptance pointers, referenced repository paths, static blocking-CI coverage и semantic-ID → evidence-anchor coverage. Domain semantics и фактическое выполнение тестов остаются обязанностью проекта и его CI.

Никакие policy/contract данные не получают arbitrary shell execution, callbacks или filesystem/network plugin API.

## Action ref и pinning

`repo-guard init` больше не выдумывает ref из package version и не использует mutable `main`/`latest`.

Передавайте явно:

- полный 40-символьный commit SHA; либо
- официальный tag `v2.0.0`, когда tag и GitHub release уже опубликованы и совпадают с `package.json.version`.

До публикации официального release используйте immutable SHA принятого commit.

Исторические consumer SHA pins продолжают указывать на прежний код и не требуют compatibility layer внутри v2. Миграция consumer выполняется отдельно и осознанно.

## Проверка миграции

После repin consumer должен как минимум пройти собственный CI и blocking repo-guard gate. Для contract/conformance adoption рекомендуется сначала включить новую policy на accepted base, затем отдельным PR удалить только те bespoke repository-governance assertions, для которых доказана positive/negative parity.

MTS-specific или иная domain semantics не переносится в repo-guard только ради удаления локальных тестов.
