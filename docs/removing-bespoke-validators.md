# Переход с собственных валидаторов

Этот документ описывает миграцию репозитория, который уже использует собственные проверки рабочих процессов, шаблонов PR или документации и хочет передать эти обязанности `repo-guard`.

Не удаляйте работающий валидатор первым шагом. Сначала запустите `repo-guard` рядом с ним в режиме `advisory`, выразите те же инварианты в `repo-policy.json`, получите зелёное подтверждение `validate-integration`, и только затем удаляйте дублирующий код.

## Последовательность миграции

### 1. Провести инвентаризацию

Зафиксируйте каждую обязанность существующего валидатора как проверяемое утверждение:

- какой рабочий процесс должен запускаться для PR;
- какой `Action` или команда выполняет проверку;
- какие разрешения, переменные токена и глубина истории обязательны;
- какой шаблон PR или задачи содержит контракт изменения;
- какие поля контракта обязательны;
- какие документы должны упоминать политику, профиль или трассировку.

### 2. Подключить repo-guard в мягком режиме

Оставьте старый валидатор включённым и добавьте рабочий процесс на основе `examples/replace-custom-validator-workflow.yml`.

Начальный режим:

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

### 3. Перенести проверки рабочего процесса

Ожидания рабочего процесса выражаются в `integration.workflows`.

Пример:

```json
{
  "id": "repo-guard-pr-gate",
  "kind": "github_actions",
  "path": ".github/workflows/repo-guard.yml",
  "role": "repo_guard_pr_gate",
  "expect": {
    "events": ["pull_request"],
    "event_types": ["opened", "synchronize", "reopened", "ready_for_review"],
    "action": {
      "uses": "netkeep80/repo-guard",
      "ref_pinning": "semver"
    },
    "mode": "check-pr",
    "enforcement": "blocking",
    "permissions": {
      "contents": "read",
      "pull-requests": "read",
      "issues": "read"
    },
    "token_env": ["GH_TOKEN"],
    "summary": true,
    "disallow": ["continue_on_error", "manual_clone", "direct_temp_cli_execution"]
  }
}
```

### 4. Перенести проверки шаблонов

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

Если контракт может находиться в связанной задаче, форму задачи можно объявить необязательной:

```json
{
  "id": "change-contract-issue-form",
  "kind": "github_issue_form",
  "path": ".github/ISSUE_TEMPLATE/change-contract.yml",
  "requires_contract_block": true,
  "optional": true,
  "required_block_kind": "repo-guard-yaml",
  "required_contract_fields": ["change_type", "scope", "anchors.affects"]
}
```

### 5. Перенести проверки документации

Документы описываются в `integration.docs`.

```json
{
  "id": "readme",
  "kind": "markdown",
  "path": "README.md",
  "must_mention": ["repo-guard", "contract", "integration"],
  "must_reference_files": [
    "repo-policy.json",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/workflows/repo-guard.yml"
  ],
  "must_mention_profiles": ["requirements-strict"],
  "must_mention_contract_fields": ["change_type", "scope", "anchors.affects"],
  "profiles": ["requirements-strict"]
}
```

### 6. Подключить профиль requirements-strict при необходимости

Если прежний валидатор контролировал трассировку требований, используйте встроенный профиль `requirements-strict` и сузьте его пути под конкретный репозиторий.

```json
{
  "profile": "requirements-strict",
  "profile_overrides": {
    "strict_heading_docs": ["docs/architecture.md", "docs/requirements.md"],
    "evidence_surfaces": ["src/**", "tests/**", "docs/**", ".github/workflows/**"]
  }
}
```

Контракт PR должен указывать относящиеся к изменению якоря:

```yaml
anchors:
  affects:
    - FR-014
  implements:
    - FR-014
  verifies:
    - FR-014
```

### 7. Перевести repo-guard в блокирующий режим

После чистых прогонов в мягком режиме измените рабочий процесс и политику:

```yaml
with:
  mode: check-pr
  enforcement: blocking
```

```json
{
  "enforcement": {
    "mode": "blocking"
  }
}
```

### 8. Удалить собственный валидатор

Удалите старый сценарий, его запись в пакетном менеджере и соответствующий шаг рабочего процесса в том же PR, в котором `repo-guard validate-integration --format summary` остаётся зелёным.

Замена считается завершённой, когда:

- `repo-guard` валидирует `repo-policy.json`;
- `repo-guard validate-integration --format summary` проходит;
- `repo-guard doctor --integration --format summary` проходит;
- рабочий процесс PR запускает `repo-guard` в режиме `blocking`;
- старый валидатор и его временный слой совместимости удалены.

## Карта обязанностей

| Обязанность старого валидатора | Замена в repo-guard |
| --- | --- |
| проверять запуск рабочего процесса для PR | `integration.workflows[].expect.events` и `event_types` |
| требовать полную историю | диагностика роли `repo_guard_pr_gate` для `fetch-depth: 0` |
| требовать закреплённый Action | `integration.workflows[].expect.action` и `ref_pinning` |
| требовать минимальные разрешения | `integration.workflows[].expect.permissions` |
| требовать токен для связанной задачи | `integration.workflows[].expect.token_env` |
| запрещать необязательный проход политики | `integration.workflows[].expect.disallow` |
| запрещать загрузку валидатора во время запуска | `manual_clone` и `direct_temp_cli_execution` |
| требовать контракт в шаблоне PR | `integration.templates[].requires_contract_block` |
| требовать конкретные поля контракта | `integration.templates[].required_contract_fields` |
| требовать документацию политики | `integration.docs[].must_mention` и `must_mention_profiles` |
| требовать ссылки на файлы политики | `integration.docs[].must_reference_files` |
| проверять трассировку требований | `profile: "requirements-strict"` и `profile_overrides` |

## Полные примеры

- `examples/downstream-integration-policy.json` показывает политику потребителя с `integration` и `requirements-strict`;
- `examples/replace-custom-validator-workflow.yml` показывает рабочий процесс, который заменяет собственный валидатор.

Главный критерий миграции: после доказанной эквивалентности старый валидатор удаляется, а не остаётся вторым источником правил.
