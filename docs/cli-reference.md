# Команды RepoGuard

Этот файл является GENERATED Projection из текущего CLI inventory и project-owned presentation model.

### `build`

Без сетевых вызовов материализует только явно принадлежащие Projection файлы и области; Requirement relation сама по себе не даёт write authority.

```bash
repo-guard build --base <sha> --head <sha> --outputs outputs.json
```

### `check`

Локально проверяет exact `BASE/HEAD`, Requirements, Relations, Constraints и Projection freshness/ownership без записи.

```bash
repo-guard check --base <40-char-sha> --head <40-char-sha>
```
