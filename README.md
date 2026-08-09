# repo-guard — исполняемая политика репозитория

`repo-guard` — командная утилита и `GitHub Action`, которая делает правила изменения репозитория проверяемыми в CI. Инструмент валидирует `repo-policy.json`, извлекает контракт изменения из PR или связанной задачи и сверяет его с реальным `git diff`.

Основная задача `repo-guard` — удерживать изменение в заявленных границах: контролировать новые файлы и документы, размер изменяемых поверхностей, обязательные сопутствующие тесты, трассировку требований, управляющие файлы и другие структурные инварианты.

Это не линтер, не сканер безопасности и не замена тестам. `repo-guard` проверяет дисциплину изменения репозитория, а не корректность предметной логики.

## Место в общем портфеле

`repo-guard` является общим исполняемым слоем управления для репозиториев `netkeep80`.

Общие приоритеты, межрепозиторные зависимости и порядок выполнения работ хранятся в центральном репозитории [`netkeep80/roadmap`](https://github.com/netkeep80/roadmap). Локальный репозиторий `repo-guard` отвечает за реализацию движка политики, его тесты и локальный список задач.

Подробная локальная связь с центральной дорожной картой описана в [`PORTFOLIO.md`](PORTFOLIO.md).

## Установка

Требуется `Node.js` 20 или новее. Для `check-pr` в `GitHub Actions` также нужны `git`, `gh`, контекст события PR и полная история репозитория.

```bash
npm install -g repo-guard

# либо без глобальной установки
npx repo-guard
```

В рабочей копии самого проекта:

```bash
npm ci
node src/repo-guard.mjs
```

## Быстрый старт

Создайте базовую конфигурацию:

```bash
repo-guard init --preset application --mode advisory
```

Команда `init` не перезаписывает существующие файлы и создаёт:

| Файл | Назначение |
| --- | --- |
| `repo-policy.json` | политика репозитория |
| `.github/workflows/repo-guard.yml` | рабочий процесс `GitHub Actions` |
| `.github/PULL_REQUEST_TEMPLATE.md` | шаблон PR с контрактом изменения |
| `.github/ISSUE_TEMPLATE/change-contract.yml` | шаблон задачи с контрактом изменения |

Сгенерированный рабочий процесс закрепляет `Action` за тегом установленной версии: `netkeep80/repo-guard@v<version>`. Не используйте плавающую ссылку на `main` для воспроизводимой проверки.

Проверьте конфигурацию:

```bash
repo-guard
repo-guard doctor
```

## Основной процесс

1. В `repo-policy.json` задаются разрешённые границы изменений.
2. В PR или связанной задаче фиксируется контракт изменения.
3. `check-diff` или `check-pr` строит факты по `git diff`.
4. Движок применяет правила политики и контракт.
5. В режиме `blocking` нарушение даёт ненулевой код выхода; в режиме `advisory` нарушение остаётся предупреждением.

## Команды

| Команда | Назначение |
| --- | --- |
| `repo-guard` | валидировать `repo-policy.json` и скомпилировать правила |
| `repo-guard path/to/contract.json` | валидировать политику и контракт из файла |
| `repo-guard check-diff` | проверить локальный `git diff` |
| `repo-guard check-diff --base main --head feature` | проверить диапазон ссылок `git` |
| `repo-guard check-pr` | проверить PR в `GitHub Actions` |
| `repo-guard init` | создать стартовую политику, рабочий процесс и шаблоны |
| `repo-guard doctor` | диагностировать окружение и подключение |
| `repo-guard validate-integration` | проверить декларативный слой `integration` |

Глобальные флаги можно указывать до или после команды:

```bash
repo-guard --repo-root /path/to/repo check-diff --base main --head feature
repo-guard check-diff --repo-root /path/to/repo --base main --head feature
repo-guard --enforcement advisory check-pr
repo-guard --enforcement blocking check-diff --base main --head feature
```

Поддерживаемые режимы применения:

| Значение | Режим | Поведение |
| --- | --- | --- |
| `blocking`, `enforce` | `blocking` | нарушение блокирует проверку |
| `advisory`, `warn` | `advisory` | нарушение выводится, но код выхода остаётся нулевым |

## Структурированный результат

`check-diff`, `check-pr` и `validate-integration` используют общий результат анализа. Основные поля: `command`, `mode`, `result`, `ok`, `exitCode`, `ruleResults`, `violations`, `advisoryWarnings`, `hints` и `repositoryRoot`.

Форматы вывода:

| Формат | Назначение |
| --- | --- |
| `text` | обычный человекочитаемый вывод |
| `json` | стабильный машинный результат |
| `summary` | краткая сводка для `$GITHUB_STEP_SUMMARY` |

## Проверка PR

`check-pr` работает по модели доверенной базовой политики:

1. читает базовый и головной SHA из события PR;
2. валидирует предлагаемую версию `repo-policy.json` из PR;
3. читает `repo-policy.json` из текущей базовой ветки;
4. применяет именно базовую политику к текущему `git diff`;
5. извлекает контракт из тела PR;
6. при необходимости получает контракт и привилегированную авторизацию из ровно одной связанной задачи;
7. валидирует контракт;
8. выполняет тот же набор правил, что и `check-diff`.

Связанная задача распознаётся по `Fixes #N`, `Closes #N` или `Resolves owner/repo#N`. Если подходящих задач несколько и контракт нельзя однозначно выбрать, проверка завершается ошибкой.

## Минимальная политика

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

Ключевые семейства правил:

| Поле | Что контролирует |
| --- | --- |
| `paths.forbidden` | запрещённые пути |
| `paths.governance_paths` | файлы управления, требующие доверенной авторизации |
| `diff_rules` | бюджет новых файлов, документов и чистого роста строк |
| `size_rules` | абсолютный размер и допустимый рост поверхностей |
| `content_rules` | содержимое и язык изменяемых файлов |
| `cochange_rules` | обязательные сопутствующие изменения |
| `surfaces` | именованные области репозитория |
| `new_file_classes` | классы новых файлов |
| `change_profiles` | правила по `change_type` |
| `registry_rules` | согласованность канонических реестров |
| `advisory_text_rules` | неблокирующие предупреждения о похожих документах |
| `anchors` | извлечение якорей трассировки |
| `trace_rules` | разрешение якорей и требуемые подтверждения |
| `integration` | проверяемое описание подключения `repo-guard` |

## Контроль языка Markdown

`content_rules` поддерживает режим `markdown_language`. Он предназначен для репозиториев, где обычный объяснительный текст должен быть на русском, а технические обозначения допускаются явно.

```json
{
  "id": "russian-markdown-prose",
  "glob": "**/*.md",
  "mode": "markdown_language",
  "language": "ru",
  "allow_words": [
    "repo-guard"
  ],
  "max_unapproved_latin_words_per_line": 1
}
```

Проверка анализирует целиком каждый изменённый файл `Markdown`. Кодовые блоки, встроенный код, адреса ссылок и URL исключаются. При нарушении результат содержит файл, номер строки и неразрешённые латинские слова.

Сам `repo-guard` применяет это правило к собственной документации через `repo-policy.json`.

## Контроль размера и роста

`size_rules` задаёт ограничения для файла или каталога. Метрики: `lines`, `bytes` и `files`.

```json
{
  "size_rules": [
    {
      "id": "max-source-file-lines",
      "scope": "file",
      "metric": "lines",
      "glob": "src/**/*.mjs",
      "max": 900,
      "count": "all_tracked",
      "level": "advisory"
    },
    {
      "id": "docs-no-growth",
      "scope": "directory",
      "metric": "files",
      "glob": "docs/**",
      "max_growth": 0
    }
  ]
}
```

`max_growth` сравнивает базовое и предлагаемое состояние каталога. Ноль запрещает рост, отрицательное значение требует сжатия, положительное разрешает ограниченный рост.

## Контракт изменения

Предпочтительная форма в PR и задачах — блок `repo-guard-yaml`:

```repo-guard-yaml
change_type: docs
scope:
  - README.md
budgets:
  max_new_files: 0
  max_new_docs: 0
  max_net_added_lines: 500
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - README.md
must_not_touch:
  - src/**
  - schemas/**
expected_effects:
  - документация соответствует текущему поведению инструмента
```

Основные поля:

| Поле | Назначение |
| --- | --- |
| `change_type` | тип изменения и ключ профиля |
| `scope` | заявленная область изменения |
| `budgets` | локальные бюджеты изменения |
| `must_touch` | путь, который обязан быть затронут |
| `must_not_touch` | путь, который нельзя затрагивать |
| `expected_effects` | ожидаемый результат |
| `anchors.affects` | затрагиваемые якоря |
| `anchors.implements` | реализуемые якоря |
| `anchors.verifies` | проверяемые якоря |

Поле `contract` в документации означает логический контракт изменения; машинные поля контракта остаются перечисленными выше.

## Профиль requirements-strict

Встроенный профиль `requirements-strict` предназначен для репозиториев, где файлы требований в `JSON` являются каноническими источниками трассировки.

Профиль разворачивает `anchors` и `trace_rules`, проверяет ссылки на идентификаторы требований в данных, коде и документации и связывает изменения требований с подтверждающими поверхностями.

Подробный контракт профиля: [`docs/requirements-strict-profile.md`](docs/requirements-strict-profile.md).

## Интеграционный слой

Секция `integration` описывает, как репозиторий подключает `repo-guard`: какие рабочие процессы запускают проверку, какие шаблоны содержат контракт, какие документы объясняют правила и какие профили доступны.

Поддерживаемые группы:

- `integration.workflows`;
- `integration.templates`;
- `integration.docs`;
- `integration.profiles`.

Проверка:

```bash
repo-guard validate-integration
repo-guard validate-integration --format json
repo-guard validate-integration --format summary
repo-guard doctor --integration --format summary
```

Для миграции с собственных валидаторов используйте [`docs/removing-bespoke-validators.md`](docs/removing-bespoke-validators.md). Готовые примеры находятся в [`examples/downstream-integration-policy.json`](examples/downstream-integration-policy.json) и [`examples/replace-custom-validator-workflow.yml`](examples/replace-custom-validator-workflow.yml).

## Санкционирование изменений политики

`paths.governance_paths` отделяет намерение изменения от привилегированной авторизации.

Обычный контракт можно держать в PR. Но разрешение менять управляющие файлы должно находиться в теле связанной задачи в поле `authorized_governance_paths`.

```repo-guard-yaml
change_type: feature
scope:
  - repo-policy.json
budgets: {}
authorized_governance_paths:
  - repo-policy.json
must_touch: []
must_not_touch: []
expected_effects:
  - изменить конкретное правило политики
```

В `check-pr` правила для текущего изменения берутся из базовой ветки. Поэтому PR не может сначала ослабить собственную политику, а затем воспользоваться этим ослаблением.

Если базовую политику нельзя прочитать или разобрать, проверка намеренно завершается ошибкой: отсутствие доверенной границы не заменяется политикой из PR.

### Защита от самоослабления

Семейство `policy-delta` сравнивает базовую и предлагаемую политики и обнаруживает ослабления: увеличение бюджетов, удаление ограничений, переход от `blocking` к `advisory` и другие изменения, уменьшающие строгость.

Такое ослабление допускается только как отдельное изменение управления с доверенной авторизацией и явным `allow_policy_relaxation` в связанной задаче.

## Самопроверка репозитория

Этот репозиторий проверяет сам себя. В `repo-policy.json` перечислены управляющие пути, определяющие поведение инструмента:

- `repo-policy.json`;
- `schemas/`;
- `.github/workflows/`;
- `.github/PULL_REQUEST_TEMPLATE.md`;
- `.github/ISSUE_TEMPLATE/`;
- `templates/`;
- `action.yml`.

Они не являются служебными исключениями и проходят обычную проверку PR.

Собственный профиль `integration` называется `self-hosting`. README обязан содержать технические поля `change_type`, `scope` и `anchors.affects`, ссылаться на `repo-policy.json`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/change-contract.yml` и `docs/self-hosting-coverage.md`.

Матрица покрытия возможностей находится в [`docs/self-hosting-coverage.md`](docs/self-hosting-coverage.md) и [`docs/self-hosting-coverage.json`](docs/self-hosting-coverage.json). Тест `tests/test-self-hosting.mjs` подтверждает, что каждая заявленная возможность либо реально используется самим репозиторием, либо имеет явное объяснение, почему самоприменение нецелесообразно.

## Разработка

```bash
npm ci
npm test
node src/repo-guard.mjs
node src/repo-guard.mjs check-diff --format summary
```

Основные каталоги:

| Путь | Назначение |
| --- | --- |
| `src/` | реализация команд, извлечения фактов и правил |
| `schemas/` | схемы политики и контракта |
| `docs/` | подробная документация |
| `examples/` | примеры подключения |
| `tests/` | модульные и интеграционные тесты |
| `templates/` | шаблоны и примеры конфигурации |

Порядок выпуска новой версии описан в [`RELEASING.md`](RELEASING.md).

## Ограничения

- `repo-guard` не оставляет комментарии в PR.
- `check-diff --contract` читает контракт из файла `JSON`; в тексте PR и задач поддерживаются блоки `YAML` и `JSON`.
- Зарезервированные поля не следует считать работающими ограничениями, пока это явно не описано.
- `integration` проверяет подключение инструмента, но не заменяет предметные тесты.
- Исполняемая политика ограничивает структуру изменения; качество архитектуры и корректность продукта требуют отдельных проверок.
