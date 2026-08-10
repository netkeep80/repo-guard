# repo-guard — исполняемая политика репозитория

`repo-guard` проверяет не только состояние проекта, но и **форму изменения**: какие файлы затронуты, укладывается ли изменение в заявленную область, насколько выросли поверхности, выполнены ли обязательные сопутствующие изменения и не ослабляет ли PR собственные правила проверки.

Инструмент рассчитан прежде всего на длительную разработку с участием людей и ИИ, где локально удобные добавления постепенно создают архитектурный дрейф. Политика делает ограничения на такой рост исполняемыми в CI.

## Архитектура

После Architecture Compression 2.0 у движка один основной семантический путь:

```text
Git / GitHub / filesystem
          ↓
RepositoryFacts + DocumentFacts
          ↓
Policy + ChangeIntent + policy packs
          ↓
named selectors
          ↓
Constraint Program
          ↓
relation kernel + diagnostics
          ↓
AnalysisReport
          ↓
text / json / summary
```

`RepositoryFacts` один раз нормализует diff, отслеживаемые файлы, классификацию путей и чтение содержимого. `DocumentFacts` даёт общий разбор `Markdown`, `JSON` и `YAML` для контрактов, интеграции, реестров, трассировки и текстовых проверок.

`surfaces`, `new_file_classes`, ограничения путей, бюджеты, сопутствующие изменения, размеры, реестры, профили изменений, трассировка и интеграционные ожидания по возможности компилируются в общий `Constraint Program`. Нормальная новая возможность должна переиспользовать существующие примитивы, а не создавать отдельный движок проверки.

Обычная политика и доверие разделены. `ChangeIntent` описывает, **что PR намерен изменить**. `GovernanceGrant` описывает, **что доверенный внешний субъект разрешил изменить**. PR не может выдать такой grant самому себе.

Проверка PR исполняется политикой базовой ветки. Сравнение старой и новой политики использует ту же нормализованную программу ограничений; неизвестная семантика считается `incomparable` и обрабатывается fail-closed.

## Установка

Требуется `Node.js` 20 или новее. Для `check-pr` также нужны `git`, `gh` и полная история репозитория.

```bash
npm install -g repo-guard
# либо
npx repo-guard
```

Для разработки самого проекта:

```bash
npm ci
npm test
node src/repo-guard.mjs
```

## Быстрый старт

```bash
repo-guard init --preset application --mode advisory
repo-guard doctor
```

`init` создаёт, не перезаписывая существующие файлы:

- `repo-policy.json`;
- `.github/workflows/repo-guard.yml`;
- `.github/PULL_REQUEST_TEMPLATE.md`;
- `.github/ISSUE_TEMPLATE/change-contract.yml`.

Сгенерированный workflow закрепляет Action за версией выпуска, а не за изменяемой веткой.

## Команды

| Команда | Назначение |
| --- | --- |
| `repo-guard` | проверить и скомпилировать политику |
| `repo-guard path/to/contract.json` | проверить политику и контракт из файла |
| `repo-guard check-diff` | проверить локальное изменение |
| `repo-guard check-diff --base main --head feature` | проверить диапазон ссылок Git |
| `repo-guard check-pr` | проверить PR в CI |
| `repo-guard init` | создать начальную конфигурацию |
| `repo-guard doctor` | проверить окружение и подключение |
| `repo-guard validate-integration` | проверить декларативный слой `integration` |

Грамматика команд задаётся одним реестром: неизвестные параметры, лишние позиционные аргументы и отсутствующие значения отвергаются до запуска обработчика.

В режиме `blocking` нарушение даёт ненулевой код выхода. В режиме `advisory` нарушение остаётся в отчёте, но не ломает задание CI.

## Минимальная политика

```json
{
  "policy_format_version": "0.3.0",
  "repository_kind": "tooling",
  "enforcement": { "mode": "blocking" },
  "paths": {
    "forbidden": ["*.bak", "*.log"],
    "canonical_docs": ["README.md"],
    "governance_paths": ["repo-policy.json"],
    "operational_paths": []
  },
  "diff_rules": {
    "max_new_docs": 2,
    "max_new_files": 15,
    "max_net_added_lines": 1000
  },
  "content_rules": [],
  "cochange_rules": []
}
```

Основные возможности политики:

- `diff_rules` ограничивает новые файлы, документы и чистый рост строк;
- `size_rules` ограничивает абсолютный размер и рост выбранных поверхностей;
- `surfaces` и `new_file_classes` именуют множества путей;
- `change_profiles` задаёт допустимую форму изменения по `change_type`;
- `content_rules` проверяет добавленный текст и язык документов;
- `cochange_rules` требует сопутствующие изменения;
- `registry_rules` сверяет канонические множества;
- `anchors` и `trace_rules` обеспечивают трассировку;
- `integration` описывает ожидаемое подключение workflow, шаблонов и документации;
- `profile` подключает встроенный policy pack.

JSON Schema является источником истины для структуры, типов и перечислений DSL. Семантический компилятор занимается только тем, чего схема выразить не может: ссылочной целостностью, регулярными выражениями, противоречиями и компиляцией ограничений.

## ChangeIntent: контракт изменения

Предпочтительная форма в PR и задачах:

```repo-guard-yaml
change_type: refactor
scope:
  - src/**
budgets:
  max_new_files: 0
  max_new_docs: 0
  max_net_added_lines: 0
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - src/**
must_not_touch:
  - schemas/**
expected_effects:
  - реализация становится компактнее без изменения поведения
```

`scope` — **исполняемая граница**, а не комментарий: каждый изменённый путь обязан совпасть хотя бы с одним шаблоном `scope`. `must_touch` требует хотя бы одного заявленного пути, а `must_not_touch` запрещает совпавшие пути. Поля `anchors.affects`, `anchors.implements` и `anchors.verifies` связывают изменение с трассируемыми якорями.

`check-pr` сначала ищет ChangeIntent в теле PR. Если его нет и PR однозначно связывает одну задачу через `Fixes #N`, `Closes #N` или `Resolves #N`, ChangeIntent может быть прочитан из этой задачи.

Схема ChangeIntent находится в `schemas/change-contract.schema.json`. Привилегированные разрешения в неё не входят.

## GovernanceGrant: внешняя управляющая санкция

Пути из `paths.governance_paths` нельзя менять только потому, что PR объявил такое намерение. Связанная доверенная задача должна содержать отдельный блок:

```repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
  - .github/workflows/**
allow_policy_relaxation: []
```

`repo-guard-grant` читается **только из связанной issue**. Такой блок в PR не считается источником доверия. Схема находится в `schemas/governance-grant.schema.json`.

`authorized_governance_paths` разрешает перечисленные управляющие пути. `allow_policy_relaxation` разрешает только явно указанные ослабления политики. Если доверенную базовую политику или доверенный источник grant получить нельзя, проверка завершается ошибкой.

## Контроль сжатия

`size_rules.max_growth` ограничивает рост поверхности относительно базы:

```json
{
  "id": "refactor-source-no-growth",
  "scope": "directory",
  "metric": "lines",
  "glob": "src/**",
  "max": 10000,
  "max_growth": 0,
  "applies_to_change_types": ["refactor"]
}
```

Ноль запрещает рост, отрицательное значение требует сжатия, положительное разрешает ограниченный рост. Сам `repo-guard` применяет это правило к `src/**` и `schemas/**`, а refactor-профиль дополнительно запрещает положительный чистый рост строк.

Архитектурные метрики доступны для разработки:

```bash
npm run compression:metrics
npm run compression:metrics -- --compare <base-sha>
```

Цель — уменьшать не LOC любой ценой, а количество специальных механизмов и независимых semantic edit-sites.

## Policy pack requirements-strict

`requirements-strict` — data-driven policy pack для проектов, где `JSON`-требования являются каноническими якорями трассировки. Публичный интерфейс остаётся простым:

```json
{
  "profile": "requirements-strict",
  "profile_overrides": {
    "strict_heading_docs": ["docs/**/*.md"],
    "evidence_surfaces": ["src/**", "tests/**", "docs/**"]
  }
}
```

Pack является данными плюс чистое macro-разворачивание в обычные `anchors` и `trace_rules`; он не получает отдельного runtime family, сетевого доступа или файлового API. Подробности — в [`docs/requirements-strict-profile.md`](docs/requirements-strict-profile.md).

## Интеграционный слой

Секция `integration` описывает ожидаемые workflow, шаблоны PR и задач, документы и профили. Канонический extractor превращает эти файлы в нормализованные facts, после чего интеграционные ожидания исполняются тем же `Constraint Program`, что и остальные ограничения.

`validate-integration` — тонкий командный адаптер этого общего механизма, а не отдельный validation engine:

```bash
repo-guard validate-integration
repo-guard validate-integration --format json
repo-guard doctor --integration --format summary
```

Миграция с собственных валидаторов описана в [`docs/removing-bespoke-validators.md`](docs/removing-bespoke-validators.md). После доказанной эквивалентности старый валидатор удаляется, а не остаётся вторым источником правил.

## Структурированный результат

Все режимы анализа сводятся к общему `AnalysisReport`. Основные поля: `command`, `mode`, `result`, `ok`, `exitCode`, `ruleResults`, `violations`, `advisoryWarnings`, `hints` и `repositoryRoot`.

Поддерживаются форматы `text`, `json` и `summary`.

## Самопроверка и core freeze

Репозиторий применяет собственную политику к самому себе. Команды, тесты и обычные capabilities по возможности **выводятся**, а не дублируются ручными списками. [`docs/self-hosting-coverage.md`](docs/self-hosting-coverage.md) описывает модель; машинный файл рядом хранит только честные исключения.

После Compression 2.0 ядро считается архитектурно замороженным по умолчанию:

> Новый primitive допустим только по реальному consumer case, который нельзя выразить существующими facts, selectors, policy packs и Constraint Program.

Новая абстракция должна сразу сворачивать больше специализированной семантики, чем добавляет. Новая high-level capability предпочтительно реализуется как pack/macro + tests. Неизвестная семантика сравнения политики остаётся fail-closed.

Это не запрет развития. Это запрет спекулятивного роста DSL без доказанной потребности из downstream-репозитория.

## Разработка, выпуск и портфель

```bash
npm ci
npm test
npm run compression:metrics
```

Порядок выпуска описан в [`RELEASING.md`](RELEASING.md). Роль проекта в портфеле — в [`PORTFOLIO.md`](PORTFOLIO.md). Центральное направление и consumer-driven rollout находятся в `netkeep80/roadmap`.

`repo-guard` не заменяет предметные тесты, security review или инженерное ревью. Его задача — сделать структурные ограничения изменения репозитория воспроизводимыми и исполняемыми.
