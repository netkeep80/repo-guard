# repo-guard

`repo-guard` - это CLI и GitHub Action для исполняемой политики репозитория. Он
валидирует `repo-policy.json`, извлекает change contract из PR или issue и
проверяет реальный git diff: какие файлы изменены, сколько добавлено, какие
поверхности затронуты и есть ли нарушение правил проекта.

Инструмент полезен, когда в репозиторий попадают лишние файлы, PR выходит за
рамки заявленного намерения, документация дублируется, изменения кода идут без
тестов или нужно зафиксировать правила для AI-assisted разработки. Это не
linter, не security scanner и не замена тестам: `repo-guard` проверяет
структуру и дисциплину изменений, а не качество кода.

## Установка

Требования: Node.js 20 или новее. Для `check-pr` в GitHub Actions также нужны
`git`, `gh`, pull request event context и полный checkout history.

```bash
npm install -g repo-guard

# или без глобальной установки
npx repo-guard
```

В репозитории с исходниками можно запускать напрямую:

```bash
npm ci
node src/repo-guard.mjs
```

## Быстрый старт

Создайте базовую конфигурацию:

```bash
repo-guard init --preset application --mode advisory
```

`init` не перезаписывает существующие файлы и создает:

| Файл | Назначение |
| --- | --- |
| `repo-policy.json` | Политика репозитория |
| `.github/workflows/repo-guard.yml` | GitHub Actions workflow |
| `.github/PULL_REQUEST_TEMPLATE.md` | Шаблон PR с change contract |
| `.github/ISSUE_TEMPLATE/change-contract.yml` | Issue template для contract |

Пресеты:

| Пресет | Для чего | Базовые ограничения |
| --- | --- | --- |
| `application` | Прикладной проект | 20 новых файлов, 3 новых docs, 1500 net lines |
| `library` | Библиотека | 15 новых файлов, 2 новых docs, `src/**` требует `tests/**` |
| `tooling` | CLI/tooling | 15 новых файлов, 2 новых docs, `src/**` требует `tests/**` |
| `documentation` | Документационный репозиторий | 20 новых файлов, 10 новых docs |

Режим enforcement:

```bash
repo-guard init --mode enforce    # alias для blocking
repo-guard init --mode advisory   # нарушения видны, но exit code остается 0
```

Проверьте конфигурацию:

```bash
repo-guard
repo-guard doctor
```

## Основной процесс

1. В `repo-policy.json` описывается, что разрешено в репозитории.
2. В PR или issue добавляется change contract: что именно должно измениться.
3. `repo-guard check-diff` или `repo-guard check-pr` строит diff и проверяет его
   против policy и contract.
4. В blocking mode CI падает при нарушениях; в advisory mode нарушения
   показываются как предупреждения и не блокируют job.

## Команды

| Команда | Что делает |
| --- | --- |
| `repo-guard` | Валидирует `repo-policy.json` по schema и компилируемые правила |
| `repo-guard path/to/contract.json` | Валидирует policy и JSON change contract |
| `repo-guard check-diff` | Проверяет staged diff, а если staged пуст, `git diff HEAD` |
| `repo-guard check-diff --base main --head feature` | Проверяет `git diff main...feature` |
| `repo-guard check-pr` | Проверяет PR внутри GitHub Actions pull_request workflow |
| `repo-guard init` | Создает стартовую policy, workflow и templates |
| `repo-guard doctor` | Диагностирует окружение, workflow, policy и auth |

Глобальные флаги можно ставить до или после команды:

```bash
repo-guard --repo-root /path/to/repo check-diff --base main --head feature
repo-guard check-diff --repo-root /path/to/repo --base main --head feature
repo-guard --enforcement advisory check-pr
repo-guard --enforcement blocking check-diff --base main --head feature
```

Флаги `--enforcement` и `--enforcement-mode` принимают:

| Значение | Нормализованный режим | Exit semantics |
| --- | --- | --- |
| `blocking`, `enforce` | `blocking` | policy violation дает exit code 1 |
| `advisory`, `warn` | `advisory` | violation печатается как warning, exit code 0 |

## `check-diff`

```bash
# Проверить локальные изменения
repo-guard check-diff

# Проверить две ref
repo-guard check-diff --base main --head feature

# Подключить JSON contract из файла, путь считается от repo-root
repo-guard check-diff --contract contracts/change.json

# Явно объявить change class для surface_matrix/new_file_rules
repo-guard check-diff --change-class docs-cleanup

# Машиночитаемый вывод
repo-guard check-diff --format json --base main --head feature

# Краткий Markdown summary для GitHub job summary
repo-guard check-diff --format summary --base main --head feature
```

Форматы вывода:

| Формат | Назначение |
| --- | --- |
| `text` | Человеческий CLI output по умолчанию |
| `json` | Stable structured result; stdout содержит только JSON |
| `summary` | GitHub-flavored Markdown для `$GITHUB_STEP_SUMMARY` |

В JSON result есть `mode`, `result`, `ok`, `exitCode`, `violations`,
`advisoryWarnings`, `ruleResults`, `hints`, `repositoryRoot` и краткая статистика
diff. Если включены anchors, добавляются `anchors` и `traceRuleResults`.

## `check-pr`

`check-pr` рассчитан на pull request workflow:

1. Читает `GITHUB_EVENT_PATH`.
2. Берет base/head SHA из pull request event.
3. Извлекает contract из тела PR.
4. Если contract в PR нет, ищет ровно один linked issue по `Fixes #N`,
   `Closes #N` или `Resolves owner/repo#N` и пробует взять contract из issue.
5. Валидирует contract по `schemas/change-contract.schema.json`.
6. Проверяет `git diff base...head` тем же policy pipeline, что и `check-diff`.

Если PR ссылается на несколько issues без contract в PR, команда завершается
ошибкой `issue_link_ambiguous`. Для fallback на linked issue нужен `GH_TOKEN` или
`GITHUB_TOKEN`, доступный `gh` CLI и `fetch-depth: 0`.

## GitHub Action

Минимальный workflow:

```yaml
name: repo-guard policy check

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]

jobs:
  policy-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: netkeep80/repo-guard@vX.Y.Z
        with:
          mode: check-pr
          enforcement: blocking
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Используйте release tag вместо `vX.Y.Z` для воспроизводимых запусков. При
локальном self-hosting внутри этого репозитория workflow может использовать
`uses: ./`.

Action inputs:

| Input | Default | Когда нужен |
| --- | --- | --- |
| `mode` | `check-pr` | `check-pr` для PR workflow, `check-diff` для явных ref |
| `enforcement` | `blocking` | `advisory` для мягкого внедрения |
| `repo-root` | `$GITHUB_WORKSPACE` | Когда policy лежит не в текущей директории |
| `base` | empty | Base ref для `mode: check-diff` |
| `head` | empty | Head ref для `mode: check-diff` |
| `contract` | empty | JSON contract path для `mode: check-diff` |
| `change-class` | empty | Change class для `surface_matrix` и `new_file_rules` |
| `node-version` | `20` | Версия Node.js для Action |

Action outputs:

| Output | Значение |
| --- | --- |
| `result` | `passed`, `failed` или `error` |
| `summary` | Однострочное описание результата |

## Policy

Минимальный `repo-policy.json`:

```json
{
  "policy_format_version": "0.3.0",
  "repository_kind": "tooling",
  "enforcement": {
    "mode": "blocking"
  },
  "paths": {
    "forbidden": ["*.bak", "*.log"],
    "canonical_docs": ["README.md"],
    "governance_paths": ["repo-policy.json"],
    "operational_paths": [".claude/**", ".gitkeep"]
  },
  "diff_rules": {
    "max_new_docs": 2,
    "max_new_files": 15,
    "max_net_added_lines": 2000
  },
  "content_rules": [],
  "cochange_rules": []
}
```

Основные поля policy:

| Поле | Runtime behavior |
| --- | --- |
| `paths.forbidden` | Запрещает измененные или новые файлы по glob |
| `paths.canonical_docs` | Не считает перечисленные Markdown файлы "новыми docs" |
| `paths.operational_paths` | Полностью исключает bot-artifacts из diff checks |
| `diff_rules.max_new_docs` | Ограничивает новые `.md` вне `canonical_docs` |
| `diff_rules.max_new_files` | Ограничивает общее число новых файлов |
| `diff_rules.max_net_added_lines` | Ограничивает `added - deleted` |
| `content_rules` | Ищет forbidden regex только в добавленных строках |
| `cochange_rules` | Требует `must_change_any`, если сработал `if_changed` |
| `surfaces` | Именованные области репозитория по glob |
| `surface_matrix` | Разрешенные surfaces для каждого `change_class` |
| `new_file_classes` | Именованные классы новых файлов |
| `new_file_rules` | Разрешенные классы и budgets новых файлов по `change_class` |
| `change_type_rules` | Правила по `change_type`: surfaces, budgets, new file classes |
| `registry_rules` | Сверяет canonical списки из JSON или Markdown |
| `advisory_text_rules` | Предупреждает о похожей Markdown-документации, не блокирует |
| `anchors` | Извлекает trace anchors из regex или JSON field sources |
| `trace_rules` | Проверяет разрешение anchors и наличие evidence files |

Reserved или информационные поля:

| Поле | Поведение сейчас |
| --- | --- |
| `paths.governance_paths` | Документирует governance files, не enforced |
| `paths.public_api` | Reserved; непустое значение дает warning |
| `contract.overrides` | Reserved; непустое значение дает warning |

Если включены `surface_matrix` или `change_type_rules` с surface constraints,
файл без matching surface по умолчанию считается нарушением. Для
`surface_matrix` можно явно разрешить частичное покрытие через
`allow_unclassified_files: true`.

## Change Contract

В PR и issue предпочтителен YAML fence:

````markdown
```repo-guard-yaml
change_type: docs
change_class: docs-cleanup
scope:
  - README.md
budgets:
  max_new_files: 0
  max_new_docs: 0
  max_net_added_lines: 500
must_touch:
  - README.md
must_not_touch:
  - src/**
  - schemas/**
expected_effects:
  - README describes the current CLI and Action behavior
```
````

Старый JSON fence тоже поддерживается:

````markdown
```repo-guard-json
{
  "change_type": "docs",
  "scope": ["README.md"],
  "budgets": {},
  "must_touch": ["README.md"],
  "must_not_touch": ["src/**"],
  "expected_effects": ["README is accurate"]
}
```
````

Обязательные поля contract:

| Поле | Значение |
| --- | --- |
| `change_type` | Тип изменения; может включать `change_type_rules` |
| `scope` | Область заявленного изменения |
| `budgets` | Перекрывает глобальные diff budgets для PR |
| `must_touch` | Any-of glob: хотя бы один pattern должен совпасть |
| `must_not_touch` | Ни один pattern не должен совпасть |
| `expected_effects` | Ожидаемый эффект изменения |

Опциональные поля:

| Поле | Когда нужно |
| --- | --- |
| `change_class` | Для `surface_matrix` и глобальных `new_file_rules` |
| `surface_debt` | Для явного временного роста surface: новые файлы или net lines |
| `anchors.affects` | Какие anchors затрагивает изменение |
| `anchors.implements` | Какие anchors реализуются |
| `anchors.verifies` | Какие anchors проверяются |
| `overrides` | Reserved, принимается schema, но не enforced |

`surface_debt` без `repayment_issue` или с фактическим ростом выше
`expected_delta` считается нарушением. Если рост есть, а `surface_debt` не
заявлен, проверка сообщает статус `undeclared`, но не блокирует сама по себе.

## Проверки diff

`check-diff` и `check-pr` используют общий pipeline. Operational paths сначала
исключаются, затем выполняются проверки:

| Check | Что проверяет |
| --- | --- |
| `forbidden-paths` | Запрещенные пути |
| `canonical-docs-budget` | Budget новых Markdown документов |
| `max-new-files` | Budget новых файлов |
| `max-net-added-lines` | Budget net added lines |
| `surface-debt` | Заявленный temporary growth |
| `registry-rules` | Согласованность canonical registries |
| `advisory-text-rules` | Heuristic Markdown duplication warnings |
| `anchor-extraction` | Ошибки regex/json anchor extractors |
| `trace-rule: <id>` | Trace resolution и evidence requirements |
| `change-type-rules` | Ограничения по `change_type` |
| `new-file-rules` | Классы и budgets новых файлов |
| `surface-matrix` | Разрешенные surfaces по `change_class` |
| `cochange-rules` | Сопутствующие изменения |
| `content-rules` | Forbidden regex в added lines |
| `must-touch` | Contract any-of path requirement |
| `must-not-touch` | Contract forbidden touch requirement |

## Registry rules

`registry_rules` сравнивает два источника:

| Source type | Что читает |
| --- | --- |
| `json_array` | Массив строк из JSON по `json_pointer` |
| `markdown_section_links` | Links из указанного Markdown section |

Поддерживаются `set_equality`, `left_subset_of_right` и
`right_subset_of_left`. Ошибки показывают missing и extra entries.

## Anchors и trace rules

`anchors` задает типы trace facts и источники:

| Source kind | Поведение |
| --- | --- |
| `regex` | Ищет pattern по glob, берет capture group или весь match |
| `json_field` | Читает scalar field из JSON file |

`trace_rules` бывают трех видов:

| Kind | Смысл |
| --- | --- |
| `must_resolve` | Каждый from-anchor должен иметь matching to-anchor |
| `changed_files_require_evidence` | Изменения по `if_changed` требуют evidence file |
| `declared_anchors_require_evidence` | Anchors из contract требуют evidence file |

Structured output включает detected/changed/declared anchors, unresolved
diagnostics и результаты каждого trace rule.

## Doctor

```bash
repo-guard doctor
repo-guard --repo-root /path/to/repo doctor
```

`doctor` проверяет:

| Check | Что означает |
| --- | --- |
| `repository-root` | Путь существует и является директорией |
| `git-available` | Git установлен, root похож на git repo |
| `fetch-depth` | История не shallow |
| `repo-policy.json` | Policy читается, валидируется и компилируется |
| `event-context` | Есть pull_request event context для `check-pr` |
| `auth-token` | Есть token или authenticated `gh` |
| `gh-cli` | `gh` установлен |
| `workflow-config` | Workflow содержит repo-guard, `fetch-depth: 0` и token |

Локально отсутствие `GITHUB_EVENT_PATH` обычно дает warning, потому что
`check-pr` нужен только внутри GitHub Actions.

## Self-hosting

Этот репозиторий проверяет сам себя через локальный reusable Action `uses: ./` в
blocking mode для ready PR. В `repo-policy.json` как governance surface
перечислены файлы, которые определяют поведение самого guard: `repo-policy.json`,
`schemas/`, `.github/workflows/`, `.github/PULL_REQUEST_TEMPLATE.md`,
`.github/ISSUE_TEMPLATE/`, `templates/` и `action.yml`. Они не являются
operational escapes и должны проходить обычный PR policy gate.

CI также запускает advisory fixture для `check-diff`, чтобы проверять, что
нарушения в advisory mode видны в output, но не ломают job.

## Разработка

```bash
npm ci
npm test
node src/repo-guard.mjs
node src/repo-guard.mjs check-diff --format summary
```

Структура проекта:

| Путь | Назначение |
| --- | --- |
| `src/repo-guard.mjs` | CLI entry point |
| `src/diff-checker.mjs` | Diff parsing и низкоуровневые проверки |
| `src/github-pr.mjs` | GitHub PR adapter |
| `src/markdown-contract.mjs` | Извлечение contract из Markdown |
| `src/runtime/` | Validation и общий policy pipeline |
| `src/checks/` | Оркестрация policy checks |
| `src/extractors/` | Anchor extractors |
| `schemas/` | JSON Schemas для policy и contract |
| `templates/` | Примеры policy, workflow и contracts |
| `tests/` | Unit и integration tests |

## Ограничения

- `repo-guard` не оставляет комментарии в PR.
- `check-diff --contract` читает JSON файл; YAML contract поддерживается в
  Markdown blocks PR/issue.
- `paths.governance_paths`, `paths.public_api` и `contract.overrides` не
  изменяют enforcement behavior.
- Проверки работают по git diff и policy metadata; корректность продукта
  остается задачей тестов, review и специализированных анализаторов.
