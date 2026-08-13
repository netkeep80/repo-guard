# Пример ChangeIntent для задачи

Обычная задача содержит только намерение изменения. `scope` является исполняемой границей: каждый изменённый путь должен входить в неё.

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
  affects: [FR-014]
  implements: [FR-014]
  verifies: [FR-014]
must_touch:
  - src/auth.mjs
must_not_touch:
  - migrations/**
expected_effects:
  - Добавлены новые точки login и logout
```

Если задача доверенно санкционирует изменение управляющих путей, добавляется **отдельный** блок. Он не является частью ChangeIntent:

```repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
allow_policy_relaxation: []
```

`GovernanceGrant` учитывается только из связанной задачи; такой блок в PR не выдаёт разрешений.
