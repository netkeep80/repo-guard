Ужесточаем управляющую политику.

```repo-guard-yaml
change_type: governance
scope:
  - repo-policy.json
budgets:
  max_new_files: 0
  max_net_added_lines: 50
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - repo-policy.json
must_not_touch: []
expected_effects:
  - Управляющая политика стала строже
```

Fixes #77
