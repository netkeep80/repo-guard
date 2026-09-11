# repo-guard — исполняемая политика репозитория

`repo-guard` делает форму изменения репозитория проверяемой в CI: контролирует затронутые пути, границы изменения, бюджеты роста, обязательные совместные изменения и попытки ослабить собственные правила.

Инструмент рассчитан на длительную разработку с участием людей и ИИ, где локально удобные изменения со временем создают архитектурный дрейф. Текущее принятое состояние собственной политики и архитектуры публикуется в [Обсерватории политики](https://netkeep80.github.io/repo-guard/).

## Архитектура

Исполняемая семантика проходит один канонический путь:

```text
Git / GitHub / filesystem
          ↓
finite typed facts
          ↓
FactRef
          ↓
Constraint Program
          ↓
primitive_relation
          ↓
relation kernel
          ↓
AnalysisReport
```

`FactRef` имеет четыре источника: `change_intent`, `diff`, `document`, `repository`. Высокоуровневые возможности компилируются в конечный набор обычных отношений и не получают собственной исполняемой семантики в ядре.

Доверие отделено от намерения изменения. `ChangeIntent` сообщает, что PR намерен изменить. `GovernanceGrant` сообщает, что доверенный внешний субъект разрешил изменить. Проверка PR исполняется политикой доверенной базовой ветки; PR не может сам выдать себе управляющую санкцию.

## Установка

Требуется `Node.js` 20 или новее.

```bash
npm install -g repo-guard
# либо
npx repo-guard
```

## Быстрый старт

```bash
repo-guard init --action-ref "$REPO_GUARD_SHA" --preset application --mode advisory
repo-guard doctor
```

`REPO_GUARD_SHA` должен содержать полный 40-символьный SHA коммита. После официального выпуска можно явно передать тег вида `vX.Y.Z`, если он соответствует версии пакета. `init` не подставляет `main` или `latest` и без `--action-ref` завершается ошибкой до создания файлов.

`init` создаёт, не перезаписывая существующие файлы:

- `repo-policy.json`;
- `.github/workflows/repo-guard.yml`;
- `.github/PULL_REQUEST_TEMPLATE.md`;
- `.github/ISSUE_TEMPLATE/change-intent.yml`.

Сгенерированный рабочий процесс закрепляет действие за явно переданным коммитом или тегом. Проверка соответствия официальной ссылки выпуска версии пакета доступна через `npm run verify:release-ref`.

## Команды

| Команда | Назначение |
| --- | --- |
| `repo-guard` | проверить и скомпилировать политику |
| `repo-guard validate [change-intent.json]` | проверить состояние, при необходимости с `ChangeIntent` из файла |
| `repo-guard check-diff` | проверить локальное изменение |
| `repo-guard check-diff --base main --head feature` | проверить диапазон ссылок |
| `repo-guard check-pr` | проверить PR в CI |
| `repo-guard init --action-ref <ref>` | создать начальную конфигурацию |
| `repo-guard doctor` | проверить операционные предпосылки окружения |

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
  "cochange_groups": [],
  "cochange_rules": []
}
```

Машинная схема — источник истины для структуры, типов и перечислений языка политики: [`schemas/repo-policy.schema.json`](schemas/repo-policy.schema.json). Исполняемые примеры находятся в [`examples/scenarios/`](examples/scenarios/), поэтому этот файл не дублирует полный справочник правил.

## Намерение изменения `ChangeIntent`

`ChangeIntent` — непривилегированное описание формы изменения. Предпочтительная форма в PR или связанной задаче:

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

`scope` — исполняемая граница: каждый изменённый путь должен ей соответствовать. `must_touch` требует заявленное изменение, `must_not_touch` запрещает совпавшие пути.

`check-pr` сначала ищет `ChangeIntent` в теле PR. Если его нет и PR однозначно связывает одну задачу через `Fixes #N`, `Closes #N` или `Resolves #N`, намерение может быть прочитано из этой задачи. Схема: [`schemas/change-intent.schema.json`](schemas/change-intent.schema.json).

## Управляющая санкция `GovernanceGrant` и доверенная база

Изменение путей из `paths.governance_paths` требует отдельной доверенной санкции в связанной задаче:

```repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
  - .github/workflows/**
allow_policy_relaxation: []
```

`repo-guard-grant` читается только из связанной задачи; такой блок в PR не считается источником доверия. Схема: [`schemas/governance-grant.schema.json`](schemas/governance-grant.schema.json).

`authorized_governance_paths` разрешает перечисленные управляющие пути. `allow_policy_relaxation` разрешает только явно указанные ослабления. Если доверенную базовую ветку, базовую политику или доверенный источник санкции получить нельзя, проверка завершается ошибкой.

## Источники истины

- [Обсерватория политики](https://netkeep80.github.io/repo-guard/) — текущее принятое состояние политики и архитектуры.
- [`schemas/`](schemas/) — публичные машинные контракты.
- [`examples/scenarios/`](examples/scenarios/) — канонические исполняемые положительные и отрицательные сценарии.
- [`templates/`](templates/) — актуальные consumer-примеры интеграции.
- [`RELEASING.md`](RELEASING.md) — процедура выпуска и правила ссылки выпуска.
- [`docs/self-hosting-coverage.md`](docs/self-hosting-coverage.md) — границы самоприменения.

Неизвестная семантика при сравнении политик обрабатывается fail-closed. `repo-guard` не заменяет предметные тесты, проверку безопасности или инженерное ревью: его задача — сделать структурные ограничения изменения репозитория воспроизводимыми и исполняемыми.

## Разработка

```bash
npm ci
npm run check:dist
npm test
npm run compression:metrics
```

Репозиторий применяет собственную политику к себе. Для внешнего репозитория достаточно обычного Action-вызова `check-pr`; пример находится в [`templates/example-workflow.yml`](templates/example-workflow.yml).

Роль проекта в портфеле описана в [`PORTFOLIO.md`](PORTFOLIO.md).
