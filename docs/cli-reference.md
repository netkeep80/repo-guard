# Команды RepoGuard

Этот файл является GENERATED Projection из текущего CLI inventory и project-owned presentation model.

### `build`

Без сетевых вызовов материализует только явно принадлежащие Projection файлы и области; Requirement relation сама по себе не даёт write authority.

```bash
repo-guard build --base <sha> --head <sha> --outputs outputs.json
```

### `check`

Локально проверяет exact `BASE/HEAD`, Requirements, Relations, Constraints и Projection freshness/ownership без записи. Авторитетный структурный переход выводится только из полных точных неизменяемых снимков: появление/исчезновение пути даёт add/delete, изменение объекта или mode в том же классе — modify, смена класса regular file/symlink/gitlink — type_change. Git/GitHub rename presentation, similarity и previous_filename не являются причинной authority; relocation представлен delete+add. `git.changed_resources` считает эти структурные deltas. `git.changed_lines` — optional need-driven observation с семантикой `git-numstat-v2`: LocalGit получает его только для активного Constraint через изолированный Myers `--numstat --no-renames`, с indent heuristic, без external diff/textconv, с versioned `.gitattributes` exact HEAD; binary `-/-` не создаёт numeric observation. Отсутствующее обязательное observation остаётся RED; GitHub additions/deletions/patch не принимаются как trusted metric. Сериализованные/provider-controlled данные не могут сами объявить `changed_lines`: data-only snapshot path без trusted acquisition capability оставляет активный `git.changed_lines` RED; LocalGit передаёт такую capability как исполняемую функцию, а не как поле JSON.

```bash
repo-guard check --base <40-char-sha> --head <40-char-sha>
```
