# Пример контракта изменения для PR

Добавьте контракт изменения YAML в описание PR, чтобы `repo-guard` мог
проверить предлагаемые изменения относительно политики репозитория:

```repo-guard-yaml
change_type: bugfix
scope:
  - src/pagination.mjs
budgets:
  max_new_files: 0
  max_new_docs: 0
surface_debt:
  kind: temporary_growth
  reason: Ввести путь извлечения перед удалением дублированного кода
  expected_delta:
    max_new_files: 1
    max_net_added_lines: 60
  repayment_issue: 123
anchors:
  affects:
    - FR-014
  implements:
    - FR-014
  verifies:
    - FR-014
must_touch:
  - src/pagination.mjs
must_not_touch:
  - schemas/
  - repo-policy.json
expected_effects:
  - Пагинация возвращает правильное количество страниц
```
