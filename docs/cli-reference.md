# Команды RepoGuard

Этот файл является GENERATED Projection из текущего CLI inventory и project-owned presentation model.

### `build`

Без сетевых вызовов материализует только явно принадлежащие Projection файлы и области; Requirement relation сама по себе не даёт write authority.

```bash
repo-guard build --base <sha> --head <sha> --outputs outputs.json
```

### `check`

Локально проверяет exact `BASE/HEAD`, Requirements, Relations, Constraints и Projection freshness/ownership без записи. Для `git.changed_lines` и `git.changed_resources` используется единая фиксированная Git diff-семантика: Myers, indent heuristic включён, rename detection 50% с limit 1000, copy detection выключен, submodule transitions учитываются, external diff и textconv выключены. `git.changed_lines` — сумма additions+deletions `--numstat` по resulting path; binary `-/-` не создаёт numeric observation. Атрибуты читаются только из versioned `.gitattributes` exact HEAD; repository/user/system Git config, `.git/info/attributes`, global/system attributes и diff-related environment не являются semantic input. Воспроизводимость остаётся зависимой от совместимой реализации Git для Myers, rename similarity, binary classification и attribute semantics и требует Git с поддержкой используемого `--attr-source`.

```bash
repo-guard check --base <40-char-sha> --head <40-char-sha>
```
