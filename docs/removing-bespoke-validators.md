# Переход с собственных валидаторов

Этот документ описывает миграцию репозитория, который уже проверяет workflow, шаблоны PR, документацию или трассировку собственным кодом и хочет передать эти обязанности `repo-guard`.

Не удаляйте работающий валидатор первым шагом. Сначала выразите те же инварианты в `repo-policy.json`, запустите `repo-guard` рядом со старым механизмом в режиме `advisory`, сравните результаты и только после доказанной эквивалентности удалите дублирующий код.

После Architecture Compression 2.0 интеграционная проверка не является отдельным rule engine: extractor строит нормализованные facts из workflow, шаблонов и Markdown, а ожидания исполняются через общий `Constraint Program`. Поэтому миграция должна добавлять данные политики, а не новый специальный validator.

## Последовательность миграции

### 1. Инвентаризация

Для каждой обязанности старого валидатора сформулируйте проверяемое утверждение:

- какой workflow должен запускаться для PR;
- какой Action или команда выполняется;
- какие permissions, токены и глубина истории обязательны;
- какой шаблон содержит ChangeIntent;
- какие поля контракта обязательны;
- какие документы и policy packs должны быть описаны;
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

### 3. Workflow как факты и ограничения

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

`validate-integration` лишь показывает отдельную проекцию этих общих diagnostics; собственной второй семантики у команды нет.

### 4. Шаблоны и ChangeIntent

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

`scope` после Compression 2.0 является blocking boundary: каждый changed path обязан входить в заявленную область.

Привилегированные поля не входят в ChangeIntent. Если изменение затрагивает `paths.governance_paths`, доверенная связанная issue должна содержать отдельный `repo-guard-grant`. Такой блок в PR не даёт разрешений.

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

### 6. Policy pack requirements-strict

Если прежний валидатор контролировал requirement traceability, используйте data-driven pack:

```json
{
  "profile": "requirements-strict",
  "profile_overrides": {
    "strict_heading_docs": ["docs/architecture.md", "docs/requirements.md"],
    "evidence_surfaces": ["src/**", "tests/**", "docs/**"]
  }
}
```

Pack разворачивается в обычные `anchors` и `trace_rules` и не создаёт отдельного runtime engine.

### 7. Сравнение результатов

До cutover прогоните старый и новый механизмы на одинаковых положительных и отрицательных fixtures. Несоответствие исправляется в политике, extractor или общем primitive, но не временным постоянным compatibility layer.

### 8. Blocking и удаление старого кода

После эквивалентных прогонов переключите `repo-guard` в `blocking` и в том же PR удалите старый валидатор, его package script и workflow step.

Миграция завершена, когда:

- `repo-policy.json` валиден;
- `validate-integration` и `doctor --integration` зелёные;
- PR gate работает в `blocking`;
- ChangeIntent и, при необходимости, GovernanceGrant имеют правильные источники доверия;
- старый validator и временная совместимость удалены.

## Карта обязанностей

| Прежняя обязанность | Представление в repo-guard |
| --- | --- |
| событие и тип PR workflow | `integration.workflows[].expect.events` и `event_types` |
| полная история | ожидание `fetch-depth: 0` для PR gate |
| закреплённый Action | `expect.action` и `ref_pinning` |
| permissions и токен | `expect.permissions`, `token_env`, `required_env` |
| запрещённые обходы | `expect.disallow` |
| ChangeIntent в шаблоне | `integration.templates` |
| документация политики | `integration.docs` |
| requirement traceability | policy pack `requirements-strict` |
| управляющее разрешение | отдельный `repo-guard-grant` в доверенной issue |

Полные snippets находятся в `examples/downstream-integration-policy.json` и `examples/replace-custom-validator-workflow.yml`.

Главный критерий: после доказанной эквивалентности остаётся один источник семантики — политика, скомпилированная в общий `Constraint Program`.
