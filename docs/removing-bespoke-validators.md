# Переход с собственных валидаторов

Этот документ описывает миграцию репозитория, который уже проверяет рабочие процессы, шаблоны PR, документацию или трассировку собственным кодом и хочет передать эти обязанности `repo-guard`.

Не удаляйте работающий валидатор первым шагом. Сначала выразите те же инварианты в `repo-policy.json`, запустите `repo-guard` рядом со старым механизмом в режиме `advisory`, сравните результаты и только после доказанной эквивалентности удалите дублирующий код.

После второй программы архитектурного сжатия интеграционная проверка не является отдельным движком правил: общий извлекатель строит нормализованные факты из рабочих процессов, шаблонов и Markdown, а ожидания исполняются через `Constraint Program`. Поэтому миграция должна добавлять данные политики, а не новый специальный валидатор.

## Последовательность миграции

### 1. Инвентаризация

Для каждой обязанности старого валидатора сформулируйте проверяемое утверждение:

- какой рабочий процесс должен запускаться для PR;
- какой Action или команда выполняется;
- какие разрешения, токены и глубина истории обязательны;
- какой шаблон содержит `ChangeIntent`;
- какие поля контракта обязательны;
- какие документы и пакеты политики должны быть описаны;
- нужны ли управляющие разрешения и кто может их выдавать.

### 2. Мягкое подключение

Добавьте рабочий процесс на основе `examples/replace-custom-validator-workflow.yml` и начните с:

```yaml
with:
  mode: check-pr
  enforcement: advisory
```

Проверьте подключение:

```bash
repo-guard --enforcement advisory validate-integration --format summary
repo-guard doctor --integration --format summary
```

### 3. Рабочий процесс как факты и ограничения

Ожидания задаются в `integration.workflows`:

```json
{
  "id": "repo-guard-pr-gate",
  "kind": "github_actions",
  "path": ".github/workflows/repo-guard.yml",
  "role": "repo_guard_pr_gate",
  "expect": {
    "events": ["pull_request"],
    "event_types": ["opened", "synchronize", "reopened", "ready_for_review"],
    "action": { "uses": "netkeep80/repo-guard", "ref_pinning": "semver" },
    "mode": "check-pr",
    "enforcement": "blocking",
    "permissions": { "contents": "read", "pull-requests": "read", "issues": "read" },
    "token_env": ["GH_TOKEN"],
    "summary": true,
    "disallow": ["continue_on_error", "manual_clone", "direct_temp_cli_execution"]
  }
}
```

`validate-integration` лишь показывает отдельное представление общих диагностик; собственной второй семантики у команды нет.

### 4. Шаблоны и `ChangeIntent`

Шаблон PR описывается в `integration.templates`:

```json
{
  "id": "pull-request-template",
  "kind": "markdown",
  "path": ".github/PULL_REQUEST_TEMPLATE.md",
  "requires_contract_block": true,
  "required_block_kind": "repo-guard-yaml",
  "required_contract_fields": ["change_type", "scope", "anchors.affects"]
}
```

`scope` после второй программы сжатия является исполняемой границей: каждый изменённый путь обязан входить в заявленную область.

Привилегированные поля не входят в `ChangeIntent`. Если изменение затрагивает `paths.governance_paths`, доверенная связанная задача должна содержать отдельный `repo-guard-grant`. Такой блок в PR не даёт разрешений.

### 5. Документация

Документы описываются в `integration.docs`:

```json
{
  "id": "readme",
  "kind": "markdown",
  "path": "README.md",
  "must_mention": ["repo-guard", "contract", "integration"],
  "must_reference_files": ["repo-policy.json", ".github/PULL_REQUEST_TEMPLATE.md"],
  "must_mention_profiles": ["requirements-strict"],
  "must_mention_contract_fields": ["change_type", "scope", "anchors.affects"],
  "profiles": ["requirements-strict"]
}
```

### 6. Пакет политики `requirements-strict`

Если прежний валидатор контролировал трассировку требований, используйте встроенный пакет:

```json
{
  "profile": "requirements-strict",
  "profile_overrides": {
    "strict_heading_docs": ["docs/architecture.md", "docs/requirements.md"],
    "evidence_surfaces": ["src/**", "tests/**", "docs/**"]
  }
}
```

Пакет разворачивается в обычные `anchors` и `trace_rules` и не создаёт отдельного движка исполнения.

### 7. Сравнение результатов

До окончательного переключения прогоните старый и новый механизмы на одинаковых положительных и отрицательных тестовых примерах. Несоответствие исправляется в политике, общем извлекателе или примитиве, но не постоянным временным слоем совместимости.

### 8. Блокирующий режим и удаление старого кода

После эквивалентных прогонов переключите `repo-guard` в `blocking` и в том же PR удалите старый валидатор, его пакетный сценарий и шаг рабочего процесса.

Миграция завершена, когда:

- `repo-policy.json` валиден;
- `validate-integration` и `doctor --integration` проходят;
- проверка PR работает в `blocking`;
- `ChangeIntent` и, при необходимости, `GovernanceGrant` имеют правильные источники доверия;
- старый валидатор и временная совместимость удалены.

## Карта обязанностей

| Прежняя обязанность | Представление в repo-guard |
| --- | --- |
| событие и тип рабочего процесса PR | `integration.workflows[].expect.events` и `event_types` |
| полная история | ожидание `fetch-depth: 0` для проверки PR |
| закреплённое действие | `expect.action` и `ref_pinning` |
| разрешения и токен | `expect.permissions`, `token_env`, `required_env` |
| запрещённые обходы | `expect.disallow` |
| `ChangeIntent` в шаблоне | `integration.templates` |
| документация политики | `integration.docs` |
| трассировка требований | пакет `requirements-strict` |
| управляющее разрешение | отдельный `repo-guard-grant` в доверенной задаче |

Полные примеры находятся в `examples/downstream-integration-policy.json` и `examples/replace-custom-validator-workflow.yml`.

Главный критерий: после доказанной эквивалентности остаётся один источник семантики — политика, скомпилированная в `Constraint Program`.
