# C3.3c — удаление исторической проверки покрытия путей

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

C3.3c полностью удаляет историческую поверхность `workflow_path_coverage`, не заменяя её новым отношением, новым источником фактов или новым специализированным вычислителем.

Причина архитектурная. Текущая форма не является фундаментальным отношением над уже существующими фактами. Она связывает три специально организованных элемента:

```text
source repository paths
+ integration workflow id
+ manually declared covers globs
```

Для сохранения этой формы пришлось бы вводить отдельную семантику сопоставления с шаблонами главным образом ради исторического интерфейса. Это противоречит принятому приоритету архитектурного сжатия 3.0:

```text
remove > reuse > small generic primitive > new subsystem
```

Поэтому C3.3c является срезом удаления, а не срезом понижения.

## 2. Доказательства, на которых основано решение

На принятом `main` собственная политика `repo-guard` не содержит `evidence_bindings`. Следовательно, самопроверяемый пример не использует `workflow_path_coverage`.

Генератор `init` также не создаёт эту форму. Его конфигурация интеграции описывает точки входа автоматизации, но не создаёт привязку доказательств покрытия путей.

Текущий вычислитель `checkWorkflowPathCoverage` проверяет только следующее:

```text
1. workflow с указанным id присутствует в extracted integration facts;
2. workflow.expect.enforcement == blocking;
3. каждый referenced path совпадает хотя бы с одним вручную заданным covers glob.
```

Он не доказывает фактическую фильтрацию запуска сценария по путям в `GitHub Actions`. Поле `covers` является дополнительной декларацией политики, а не извлечённым доказательством реального запуска сценария для конкретного пути.

Поэтому перенос этой семантики в каноническое ядро отношений не увеличивает универсальность ядра.

## 3. Граница продукта

C3.3c удаляет только историческую форму доказательства покрытия путей.

Не удаляются:

- извлечение интеграционных фактов;
- команда `validate-integration`;
- политика интеграции как продуктовая поверхность;
- факты сценариев автоматизации, шаблонов, документации и профилей;
- `anchor_value_coverage`, уже пониженный в `set_subset` в C3.3b.

Интеграция остаётся отдельным предметом следующего C3.3d.

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

Ожидаемый набор исполняемых видов ограничений:

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

Из публичной схемы удаляется вариант привязки доказательств:

```text
kind = workflow_path_coverage
workflow
covers
```

Из компилятора и исполняемого пути удаляются:

```text
evidence_workflow_path_coverage
checkEvidenceWorkflowPathCoverage
checkWorkflowPathCoverage
соответствующая runtime dispatch-ветка
```

Удаляются или переписываются тесты и документация, которые считают эту форму поддерживаемым контрактом.

Если после удаления `checkWorkflowPathCoverage` файл `integration-constraints.mts` продолжает использоваться для исполняемой проверки интеграции, сам файл остаётся. C3.3c не должен механически переносить или переименовывать оставшийся вычислитель интеграции.

## 6. Что запрещено добавлять

C3.3c не создаёт:

- новый дескриптор отношения;
- новый источник `FactRef`;
- новый селектор покрытия по шаблонам путей;
- новый исполняемый вид ограничения;
- новую подсистему доказательств взамен удаляемой;
- псевдоним совместимости для `workflow_path_coverage`;
- переходный второй вычислитель, остающийся после слияния.

Если красный тест неожиданно докажет, что удаление ломает реальный самопроверяемый или генерируемый через `init` контракт, реализация останавливается и архитектура пересматривается. Нельзя автоматически создавать новый примитив только ради восстановления теста.

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

Интеграция пока остаётся параллельным продуктовым вычислителем состояния:

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

## 8. Разработка через тестирование и фальсификация

Реализация начинается отдельным коммитом, содержащим только красный тест.

Сфокусированный фальсификатор утверждает целевое состояние C3.3c и на принятом исходном состоянии обязан падать именно потому, что историческая поверхность ещё существует.

Красные проверки должны требовать:

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

На первом тестовом коммите ожидаются пять падений, соответствующих требованиям удаления. Проверки отсутствия собственного потребителя, отсутствия потребителя в `init` и сохранения уже канонических инвариантов должны быть зелёными ещё до изменения производственного кода.

Красный результат считается чистым только тогда, когда падения объясняются исторической схемой, компилятором и исполняемой поверхностью, а существующие поведенческие тесты до нового фальсификатора остаются зелёными.

После доказанного красного результата выполняется минимальное удаление из схемы, компилятора и исполняемых помощников, затем миграция тестов и документации.

## 9. Проверка эквивалентности после удаления

Здесь нет цели сохранить исполняемое поведение удалённой формы. Эквивалентность означает сохранение всех остальных принятых контрактов.

Обязательные проверки:

- политика без `workflow_path_coverage` работает без изменений;
- `anchor_value_coverage` продолжает компилироваться в `set_subset`;
- проверка интеграции продолжает проверять сценарии, шаблоны, документацию и профили;
- `init` продолжает создавать валидные заготовки политики;
- схема отклоняет `workflow_path_coverage` как неизвестную историческую форму;
- число исполняемых видов ограничений становится ровно шестью;
- число дескрипторов отношений не растёт;
- словарь источников `FactRef` не растёт;
- сгенерированный каталог `dist` совпадает с исходниками;
- весь автоматически обнаруживаемый набор тестов проходит;
- метрики архитектурного сжатия проходят;
- самопроверка политики в состоянии готовности проходит.

## 10. Ошибки и закрытое поведение при неопределённости

После удаления политика, содержащая `workflow_path_coverage`, должна отвергаться на границе схемы. Не должно быть ситуации, когда историческая форма молча принимается, но игнорируется при выполнении.

Это принципиально важнее совместимости: неподдерживаемый исторический синтаксис должен стать явной ошибкой конфигурации.

Оставшиеся ошибки извлечения интеграции и нарушения политики интеграции продолжают работать по текущей закрытой модели до C3.3d.

## 11. Изменяемые области

Ожидаемые места изменения производственного кода:

```text
schemas/repo-policy.schema.json
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
src/checks/integration-constraints.mts
```

`src/checks/integration-constraints.mts` изменяется только для удаления `checkWorkflowPathCoverage` и связанных типов или импортов, если они больше не используются.

Также ожидаются изменения:

```text
tests/**
docs/**
dist/**
```

`scripts/compression-metrics.mjs` меняется только в том случае, если существующая метрика не способна доказать уменьшение числа исполняемых видов ограничений с семи до шести. Новую метрику ради самого факта изменения добавлять не нужно, если текущая уже считает эти виды.

## 12. Явно вне границ среза

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

## 13. Следующий срез C3.3d

После принятия C3.3c отдельный архитектурный срез должен исследовать схождение исполняемой проверки интеграции к каноническому ядру.

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

Особенно отдельно проверяется, какие специальные ожидания `repo-guard` и параллельного контура имеют реальную продуктовую ценность, а какие являются исторической методологией и должны быть удалены.

C3.3d не является частью критериев принятия C3.3c.

## 14. Критерии принятия

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

После слияния #394 закрывается как `completed`; #374 остаётся открытой для C3.3d и последующего удаления исторических поверхностей.