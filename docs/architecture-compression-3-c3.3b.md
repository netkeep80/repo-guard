# Сжатие архитектуры 3.0 — C3.3b: трассировка и доказательства через канонические факты

Статус документа: каноническая запись ограниченного среза C3.3b (#392) программы #370.

Родительский этап: #374.

Исходный измеримый срез и предыдущие принятые этапы зафиксированы в `docs/architecture-compression-3-baseline.md`. Этот документ продолжает зафиксированную основу и не переписывает замороженные исходные значения C3.0.

## 1. Цель среза

C3.3b удаляет отдельное исполнение правил трассировки и покрытия значений якорей. Эти правила больше не имеют собственного вычислителя и собственного рабочего вида ограничения. Они понижаются в существующую конечную алгебру отношений и читают данные через единую модель `FactRef`.

Архитектурная цепочка после среза:

```text
repository / diff / documents / ChangeIntent
        ↓
typed facts
        ↓
canonical FactRef
        ↓
finite relation descriptor registry
        ↓
primitive_relation
        ↓
generic evaluator
```

Ни второй `FactStore`, ни второй вычислитель отношений не добавлены.

## 2. Расширение конечного набора источников `FactRef`

До C3.3b каноническая модель имела два источника:

```text
document
diff
```

После C3.3b та же единственная модель имеет четыре источника:

```text
change_intent
diff
document
repository
```

Число канонических моделей `FactRef` остаётся равным одному.

### 2.1 Факты репозитория

Для источника `repository` введён один ограниченный селектор:

```text
anchor_values(anchor_type)
```

Он возвращает нормализованное множество строковых значений якоря. При дедупликации значения не теряются исходные местоположения: сведения о происхождении сохраняют все экземпляры, включая несколько одинаковых значений в разных файлах или позициях.

Принципиальная форма результата:

```text
value = [unique sorted anchor values]
provenance.kind = anchor_instances
provenance.instances = all source locations
```

То есть отношение работает над множеством значений, а отчётность при необходимости всё ещё может показать, откуда пришло каждое значение.

### 2.2 Факты `ChangeIntent`

Для `change_intent` не введены специальные селекторы `affects`, `implements` или `verifies`.

Используется общий селектор на основе указателя JSON и необязательной проекции:

```text
JSON Pointer + optional projection
```

Например:

```text
/anchors/affects + array_items
```

Тем самым каноническое ядро не получает новый словарь методологических ролей.

## 3. Понижение правил трассировки

Исторические правила `trace_rules` компилируются в обычные `primitive_relation`.

### 3.1 Разрешение ссылок на якоря

```text
must_resolve
  repository.anchor_values(from_anchor_type)
  repository.anchor_values(to_anchor_type)
    -> set_subset
```

Левое множество должно быть подмножеством правого. Неразрешённые значения появляются как обычные `missing_values` результата `set_subset`.

Специальный результат `traceRuleResults` больше не существует.

### 3.2 Доказательство для изменённых файлов

```text
changed_files_require_evidence
  diff.changed_paths(if_changed)
  diff.changed_paths(must_touch_any)
    -> set_presence_implies
```

Если множество изменённых целевых файлов непусто, множество файлов доказательства также должно быть непустым.

### 3.3 Доказательство для объявленных якорей

```text
declared_anchors_require_evidence
  change_intent(pointer, projection)
  diff.changed_paths(must_touch_any)
    -> set_presence_implies
```

Здесь семантика наличия доказательства та же, а источник условия меняется с разницы файлов на канонический факт `ChangeIntent`.

## 4. Понижение покрытия значений якорей

Исторический рабочий вид `evidence_anchor_value_coverage` удалён.

Привязка:

```text
anchor_value_coverage
```

понижается в:

```text
document(selector)
repository.anchor_values(target_anchor_type)
  -> set_subset
```

Отдельный вычислитель покрытия значений не требуется. Повторные местоположения целевых якорей сохраняются в сведениях о происхождении правого факта и проходят через обычный результат отношения.

## 5. Семантика отношения отделена от планирования

`set_subset` остаётся общим отношением состояния:

```text
descriptor phase = state
```

Историческая семантика `must_resolve` требовала проверки перехода. Поэтому скомпилированный экземпляр отношения несёт локальное переопределение фазы:

```text
relation instance phase = transaction
```

Это не новый вид отношения. Один и тот же дескриптор определяет математическую семантику, а экземпляр ограничения определяет, когда именно её требуется вычислить.

Отдельный исполняемый тест доказывает одновременно:

```text
set_subset descriptor -> state
must_resolve instance -> transaction
must_resolve absent from state-only evaluation
```

## 6. Удалённая историческая поверхность

Из рабочего объединения удалены два вида ограничений:

```text
trace_rules
evidence_anchor_value_coverage
```

Число рабочих видов уменьшилось:

```text
9 -> 7
```

Текущий набор:

```text
change_profile
evidence_workflow_path_coverage
integration
primitive_relation
registry_rules
size_rules
surface_debt
```

Физически удалены:

```text
src/checks/trace-rules.mts
dist/checks/trace-rules.mjs
```

Вместе с ними исчезли отдельные семантические пути:

```text
buildTraceRuleDiagnostics
checkTraceRuleResult
special anchor-value coverage evaluator
```

Удаление защищено отдельным тестом: он проверяет отсутствие обоих файлов и отсутствие вызовов старых функций в `constraint-program`, рабочем выполнении ограничений и отчётности по якорям.

## 7. Граница отчётности

`buildAnchorDiagnostics` после C3.3b является только проекцией фактов. Он показывает:

```text
detected anchors
changed anchors
anchors declared by ChangeIntent
counts by anchor type
extraction errors
```

Он больше не вычисляет `unresolved` и не создаёт вторичную семантическую проекцию результатов трассировки.

Нарушения и доказательства доступны через единый поток:

```text
ruleResults
violations
primitive relation data
FactRef provenance
```

Таким образом, отчётность не становится скрытым вторым вычислителем.

## 8. Конечность алгебры отношений

C3.3b не добавляет новый дескриптор отношения.

До и после среза:

```text
relation descriptors = 10
public relation descriptors = 7
primitive descriptor registries = 1
primitive runtime shapes = 1
```

Публичный набор остаётся прежним:

```text
referenced_paths_exist
referenced_pointer_exists
scalar_equal
scalar_equals_literal
scalar_strictly_greater
set_equal
set_subset
```

Для внутреннего понижения повторно используется уже существующий `set_presence_implies`.

Компилятор высокоуровневого правила не дублирует публичное имя `set_subset`. Он запрашивает общую семантику сравнения множеств `left_subset`, а конкретный вид разрешается через метаданные единственного реестра дескрипторов.

Проверяемые метрики после этого изменения:

```text
canonical_factref_model_count = 1
primitive_descriptor_registry_count = 1
primitive_runtime_shape_count = 1
independent_document_relation_switches = 0
semantic_edit_sites_per_new_primitive = 1
runtime_constraint_kinds = 7
```

## 9. Проверка эквивалентности через отрицательные состояния

Работа шла через заранее ожидаемые состояния отказа.

Начальные отрицательные запуски #1177 и #1178 доказали отсутствие требуемых источников фактов, понижений и сведений о происхождении до основной реализации.

После реализации отдельная отрицательная проверка удаления #1206 имела ровно две причины отказа:

```text
src/checks/trace-rules.mts still exists
dist/checks/trace-rules.mjs still exists
```

Все проверки отсутствия старых вызовов в активных потребителях на том же запуске уже проходили. После физического удаления обоих файлов полный запуск #1208 на вершине ветки:

```text
f106da8f4829cc82315e761f8bfa3c2a5e567170
```

прошёл:

```text
check:dist = success
compression metrics = success
validate-integration = success
doctor = success
portable readiness diagnostics = success
discovered test suite = success
advisory self-check = success
smoke-pack = success
```

Отдельный запуск #1205 до удаления старого файла подтвердил переопределение фазы на экземпляре отношения и полный набор существующих тестов.

## 10. Что намеренно не входит в C3.3b

Этот срез не понижает:

```text
evidence_workflow_path_coverage
integration
```

Они остаются отдельными рабочими видами и должны рассматриваться следующим ограниченным этапом #374 только после отдельной отрицательной проверки и доказательства эквивалентности.

Также C3.3b не вводит:

```text
legacy compatibility layer
second evaluator
second FactStore
arbitrary expression language
methodology-specific canonical primitive
new public relation kind
```

## 11. Итог

C3.3b заменяет две исторические исполнительные подсистемы композициями уже существующей конечной алгебры.

Итоговая граница среза:

```text
FactRef sources: 2 -> 4
FactRef models: 1 -> 1
runtime constraint kinds: 9 -> 7
relation descriptors: 10 -> 10
public relation descriptors: 7 -> 7
historical trace evaluator files: 2 -> 0
```

Семантика трассировки теперь является обычной семантикой фактов и отношений, а не отдельной подсистемой.