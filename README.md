# repo-guard — локальный causal compiler для репозитория

RepoGuard детерминированно проверяет точные `BASE/HEAD` по версионированным требованиям, отношениям, ограничениям и проекциям.

```text
Snapshot
+ SubjectRef
+ Requirement
+ Relation
+ Constraint
+ Projection
```

Обычный CI исполняет предметные тесты и доказательства. GitHub или другая платформа управляет review, required checks и правом слияния. RepoGuard не требует отдельного App, сервиса, секрета или сетевого control plane для семантического verdict.

## Каноническая проверка

```bash
repo-guard check --base <40-char-sha> --head <40-char-sha>
```

Компилятор проверяет:

- J2 — rooted Requirement closure;
- J1 — причинное обоснование tracked resources;
- J3 — причину перехода между точными снимками;
- scoped Constraints;
- Projection freshness и ownership.

Requirement остаётся нормативным субъектом. Отношения связывают адресуемые Requirement/Resource/Document subjects. Traceability не выдаёт write authority, а внешний domain truth выполняет обычный CI.

## Action

Закрепляйте принятую версию RepoGuard immutable SHA:

```yaml
- uses: netkeep80/repo-guard@<40-char-SHA>
  with:
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.event.pull_request.head.sha }}
```

Action является тонким адаптером над `repo-guard check`.

## Материализация Projection

```bash
repo-guard build --base <sha> --head <sha> --outputs outputs.json
```

`build` пишет только явно принадлежащие Projection файлы/области и сохраняет authored bytes вне owned regions.

[Нормативные требования](requirements/repo-guard/) хранятся по одному Requirement на файл. [Описание продукта](docs/product-requirements.md) — читаемое авторское представление, а не второй нормативный источник.

<a id="rg-cli-commands"></a>
## Команды

<!-- repo-guard:cli:start -->
Команды: `build`, `check`. [Назначение и границы](docs/cli-reference.md).
<!-- repo-guard:cli:end -->

## Разработка

```bash
npm ci
npm run check:dist
npm test
```

Новая generic возможность добавляется только после реального falsifier от потребителя. Удаление лишнего считается полноценным улучшением. Roadmap: [#518](https://github.com/netkeep80/repo-guard/issues/518).
