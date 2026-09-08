# C3.3d3 — спецификация сведения `size_rules`

Ответственная issue: #409  
Родительская issue: #398  
Принятая база: `9ff00319f9828261ff997796bdb906b95e7a281f`

## Цель

Удалить выделенный рантайм-вид `size_rules` и вычислитель `checkSizeRules`. Поддерживаемые правила `size_rules` компилируются в существующие ограничения `primitive_relation`, семантика которых задаётся `numeric_bound` над каноническими скалярными фактами.

Целевые виды рантайма:

```text
integration
primitive_relation
```

## Изменение канонического получения фактов

Новый источник `FactRef` не вводится. Расширяются только существующие источники.

### `repository.path_metric`

```text
patterns: string[]
exclude_paths?: string[]
population: tracked | changed
metric: lines | bytes | files
aggregate: max | sum
```

Этот селектор отвечает только за получение факта. Он не должен знать об идентификаторах правил политики, `size_rules`, лимитах, рекомендательном режиме, `ChangeIntent` или фазах исполнения.

Если выбранный путь репозитория требует измерения содержимого, но файл невозможно прочитать, чтение факта должно завершаться закрытой структурированной ошибкой. Происхождение факта остаётся универсальным: совпавшие пути, измерения по путям, агрегат и итоговое значение.

### `diff.metric`

Сохраняется существующий вид селектора. Он расширяется необязательным ограничением по путям и одной скалярной метрикой:

```text
metric = new_docs | new_files | net_added_lines | net_files
patterns?: string[]
exclude_paths?: string[]
```

Для `net_files` добавленный файл даёт `+1`, удалённый `-1`, изменённый `0` после ограничения по путям.

## Сведение

Абсолютное правило для файла:

```text
repository.path_metric(population=all_tracked?tracked:changed,
                       metric=lines|bytes,
                       aggregate=max)
-> numeric_bound(max=rule.max)
```

Абсолютное правило для каталога:

```text
repository.path_metric(population=tracked,
                       metric=lines|bytes|files,
                       aggregate=sum)
-> numeric_bound(max=rule.max)
```

Правило роста каталога:

```text
diff.metric(metric=net_added_lines|net_files,
            patterns=[rule.glob],
            exclude_paths=rule.ignore)
-> numeric_bound(max=rule.max_growth)
```

Правило каталога, содержащее одновременно `max` и `max_growth`, компилируется в два независимых ограничения: абсолютное для фазы состояния и ограничение роста для фазы транзакции.

`applies_to_change_types` используется только для выбора на фронтенде. Невыбранное правило не порождает ни одного примитивного ограничения.

`level=advisory` — универсальная метаинформация рантайма и отчётности, применяемая после вычисления примитива; отдельный рекомендательный вычислитель или семейство результатов для размера не допускаются.

## Поддерживаемое публичное подмножество

```text
file:
  metric = lines | bytes
  max = required
  count = all_tracked | changed_only
  max_growth = forbidden
directory:
  metric = lines | bytes | files
  max = required
  count = all_tracked
  max_growth = allowed only for lines | files
```

Следующие сочетания должны быть недопустимы ещё до рантайма:

```text
file + metric=files
file + max_growth
directory + bytes + max_growth
directory + count=changed_only
```

Совместимый перевод этих форм не вводится.

## Инварианты

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
new relation descriptor = NONE
new FactRef source = NONE
second evaluator = NONE
compatibility alias = NONE
runtime kinds = 2
```

Не сохранять `size_violations[]`, `growth[]` или топологию `size-rules-advisory` как совместимый интерфейс. Диагностика должна формироваться из универсального происхождения факта и данных результата `numeric_bound`.

## Приёмка

Последовательность `RED-first` обязательна. До первого production-коммита должен существовать предшествующий падающий тест D3 на принятой базе, причём падение должно подтверждать именно отсутствующее требуемое поведение.

Приёмка точной головы `Ready` требует `validate`, `smoke-pack` и `Run PR policy check` в состоянии `GREEN` на одном и том же точном коммите. Финальная приёмка дополнительно требует post-merge `validate` и `smoke-pack` в состоянии `GREEN` на точном SHA merge-коммита.
