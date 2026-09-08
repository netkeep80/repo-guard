# C3.3c — удаление исторической проверки покрытия путей workflow

Статус: проект архитектуры для #394.

Родительская программа: #374.

Принятая база перед началом реализации:

```text
main = ae8aa89c5a780d4a33a70fbd7329d358f954b91d
C3.3b = accepted
runtime constraint kinds = 7
relation descriptors = 10
FactRef sources = 4
```

## 1. Цель

C3.3c удаляет историческую поверхность `workflow_path_coverage` целиком, не заменяя её новым отношением, новым источником фактов или новым специализированным evaluator.

Причина — архитектурная. Текущая форма не является фундаментальным отношением над уже существующими фактами. Она связывает три специально организованных элемента:

```text
source repository paths
+ integration workflow id
+ manually declared covers globs
```

Для сохранения этой формы пришлось бы вводить отдельную pattern-aware семантику главным образом ради исторического API. Это противоречит принятому приоритету Architecture Compression 3.0:

```text
remove > reuse > small generic primitive > new subsystem
```

Поэтому C3.3c является deletion slice, а не lowering slice.

## 2. Доказательства, на которых основано решение

На принятом `main` собственная политика repo-guard не содержит `evidence_bindings`. Следовательно, self-hosted exemplar не использует `workflow_path_coverage`.

Генератор `init` также не создаёт эту форму. Его integration-конфигурация описывает workflow entry points, но не создаёт evidence binding покрытия путей.

Текущий evaluator `checkWorkflowPathCoverage` проверяет только следующее:

```text
1. workflow с указанным id присутствует в extracted integration facts;
2. workflow.expect.enforcement == blocking;
3. каждый referenced path совпадает хотя бы с одним вручную заданным covers glob.
```

Он не доказывает фактическую trigger/path-фильтрацию workflow в GitHub Actions. Поле `covers` является дополнительной декларацией политики, а не извлечённым доказательством реального запуска workflow для конкретного пути.

Поэтому перенос этой семантики в canonical relation kernel не увеличивает универсальность ядра.

## 3. Граница продукта

C3.3c удаляет только историческую форму evidence coverage.

Не удаляются:

- extractor интеграционных фактов;
- команда `validate-integration`;
- integration policy как продуктовый surface;
- workflow/template/doc/profile факты;
- `anchor_value_coverage`, уже пониженный в `set_subset` в C3.3b.

Integration остаётся отдельным предметом следующего C3.3d.

## 4. Целевое состояние

После принятия C3.3c должны выполняться инварианты:

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
primitive runtime shapes = 1
runtime constraint kinds = 6
```

Ожидаемый набор runtime constraint kinds:

```text
surface_debt
size_rules
registry_rules
change_profile
integration
primitive_relation
```

`evidence_workflow_path_coverage` отсутствует.

## 5. Удаляемая поверхность

Из public schema удаляется вариант evidence binding:

```text
kind = workflow_path_coverage
workflow
covers
```

Из compiler/runtime удаляются:

```text
evidence_workflow_path_coverage
checkEvidenceWorkflowPathCoverage
checkWorkflowPathCoverage
соответствующая runtime dispatch-ветка
```

Удаляются или переписываются тесты и документация, которые считают эту форму поддерживаемым контрактом.

Если после удаления `checkWorkflowPathCoverage` файл `integration-constraints.mts` продолжает использоваться для integration runtime, сам файл остаётся. C3.3c не должен механически переносить или переименовывать оставшийся integration evaluator.

## 6. Что запрещено добавлять

C3.3c не создаёт:

- новый relation descriptor;
- новый `FactRef` source;
- selector для glob/pattern coverage;
- новый runtime kind;
- replacement evidence subsystem;
- compatibility alias для `workflow_path_coverage`;
- transitional dual evaluator, остающийся после merge.

Если RED неожиданно докажет, что удаление ломает реальный self-hosted или генерируемый `init` контракт, реализация останавливается и архитектура пересматривается. Нельзя автоматически создавать новый primitive только ради восстановления теста.

## 7. Поток данных после удаления

C3.3c не меняет основной поток выполнения:

```text
repository / diff / documents / ChangeIntent
        ↓
existing acquisition
        ↓
one canonical FactRef
        ↓
small relation kernel
        ↓
primitive_relation
```

Integration пока остаётся параллельным product-level state evaluator:

```text
integration policy
        ↓
extractIntegration
        ↓
integration facts
        ↓
integrationConstraintEntries
```

Это осознанный временный остаток, предназначенный для C3.3d. C3.3c не расширяет и не легитимизирует его как финальную архитектуру.

## 8. TDD и falsification

Реализация начинается отдельным test-only RED commit.

Focused falsifier утверждает целевое состояние C3.3c и на принятом исходном состоянии обязан падать именно потому, что historical surface ещё существует.

RED probes должны требовать:

```text
public schema rejects workflow_path_coverage
compiler does not emit evidence_workflow_path_coverage
runtime union does not contain evidence_workflow_path_coverage
runtime has no dedicated workflow coverage dispatch
checkWorkflowPathCoverage is absent
self repo-policy does not declare workflow_path_coverage
init scaffold does not generate workflow_path_coverage
anchor_value_coverage remains primitive_relation/set_subset
relation descriptor count remains 10
FactRef source count remains 4
```

На первом test-only head ожидаемые failing probes — первые пять требований удаления. Проверки отсутствия self-consumer, отсутствия `init`-consumer и сохранения уже канонических инвариантов должны быть GREEN уже до production deletion.

RED считается чистым только если failures объясняются исторической schema/compiler/runtime поверхностью, а существующие behavior tests до нового falsifier остаются GREEN.

После доказанного RED выполняется минимальное удаление schema/compiler/runtime helper, затем миграция тестов и документации.

## 9. Проверка эквивалентности после удаления

Здесь нет цели сохранить runtime-поведение удалённой формы. Эквивалентность означает сохранение всех остальных принятых контрактов.

Обязательные проверки:

- политика без `workflow_path_coverage` работает без изменений;
- `anchor_value_coverage` продолжает компилироваться в `set_subset`;
- integration validation продолжает проверять workflows/templates/docs/profiles;
- `init` продолжает создавать валидные scaffold-политики;
- schema отклоняет `workflow_path_coverage` как неизвестную историческую форму;
- runtime kinds становятся ровно шестью;
- relation descriptor count не растёт;
- FactRef vocabulary не растёт;
- generated `dist` совпадает с source;
- весь discovered suite GREEN;
- compression metrics GREEN;
- ready-state self-policy GREEN.

## 10. Ошибки и fail-closed поведение

После удаления policy, содержащая `workflow_path_coverage`, должна отвергаться на schema boundary. Не должно быть ситуации, когда историческая форма молча принимается, но игнорируется runtime.

Это принципиально важнее compatibility: unsupported historical syntax должна стать явной ошибкой конфигурации.

Оставшиеся integration extraction errors и integration policy violations продолжают работать по текущей fail-closed модели до C3.3d.

## 11. Изменяемые области

Ожидаемые production edit sites:

```text
schemas/repo-policy.schema.json
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
src/checks/integration-constraints.mts
```

`src/checks/integration-constraints.mts` изменяется только для удаления `checkWorkflowPathCoverage` и связанных типов/imports, если они больше не используются.

Также ожидаются:

```text
tests/**
docs/**
dist/**
```

`scripts/compression-metrics.mjs` меняется только если существующая метрика не способна доказать runtime reduction `7 -> 6`. Новую метрику ради самого факта изменения добавлять не нужно, если текущая уже считает runtime kinds.

## 12. Явно вне scope

C3.3c не выполняет:

```text
integration FactRef source
integration selector vocabulary
integration relation lowering
workflow role redesign
repo_guard_pr_gate redesign
parallel readiness deletion
portable coordinator deletion
merge queue redesign
validate-integration redesign
```

Эти вопросы принадлежат C3.3d.

## 13. Следующий slice C3.3d

После принятия C3.3c отдельный архитектурный slice должен исследовать integration runtime convergence.

Базовая гипотеза C3.3d:

```text
extractIntegration remains acquisition
        ↓
finite typed integration facts
        ↓
canonical FactRef addressing
        ↓
existing generic relations where sufficient
        ↓
delete integration runtime switchboard
```

Особенно отдельно проверяется, какие repo-guard/parallel-specific ожидания имеют реальную продуктовую ценность, а какие являются исторической методологией и должны быть удалены.

C3.3d не является частью acceptance C3.3c.

## 14. Acceptance

C3.3c может быть принят только при одновременном выполнении условий:

```text
focused RED existed before production deletion
workflow_path_coverage public syntax absent
runtime evidence_workflow_path_coverage absent
checkWorkflowPathCoverage absent
no replacement primitive/source/alias
runtime kinds = 6
relation descriptors = 10
FactRef sources = 4
anchor_value_coverage remains canonical
full tests GREEN
dist fresh
compression metrics GREEN
ready-state self-policy GREEN
post-merge main CI GREEN
```

После merge #394 закрывается как `completed`; #374 остаётся открытой для C3.3d и последующей исторической компрессии.