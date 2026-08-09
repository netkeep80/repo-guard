# Пример контракта изменения для задачи

При создании задачи, которая предлагает изменение кода, добавьте контракт изменения
в блоке YAML, чтобы `repo-guard` мог проверить заявленные границы:

```repo-guard-yaml
change_type: feature
scope:
  - src/auth.mjs
  - src/middleware/**
budgets:
  max_new_files: 5
  max_new_docs: 1
surface_debt:
  kind: temporary_growth
  reason: Временно добавить адаптер перед удалением старого пути middleware
  expected_delta:
    max_new_files: 1
    max_net_added_lines: 80
  repayment_issue: 456
anchors:
  affects:
    - FR-014
  implements:
    - FR-014
  verifies:
    - FR-014
must_touch:
  - src/auth.mjs
must_not_touch:
  - migrations/
expected_effects:
  - Добавлены новые точки /login и /logout
```
