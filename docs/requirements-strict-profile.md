# Policy pack requirements-strict

`requirements-strict` — встроенный data-driven policy pack `repo-guard` для репозиториев, где требования в `JSON` являются каноническим источником трассировки.

Публичный интерфейс сохраняется: pack включается через `profile: "requirements-strict"`, а настройки передаются в `profile_overrides`. После schema validation чистый macro-компилятор разворачивает данные pack в обычные `anchors` и `trace_rules`; отдельного runtime family или отдельного движка у профиля нет.

Если политика явно задаёт `anchors` или `trace_rules`, явная секция имеет приоритет над сгенерированной.

## Почему это pack

Предметные знания — шаблон идентификатора требования, globs и набор правил трассировки — хранятся как данные. Общий compiler подставляет overrides и материализует стандартную политику. Pack не получает сетевого доступа, собственного файлового API или отдельной логики сравнения строгости.

Это соответствует core-freeze: новый профиль предпочтительно добавляется как данные и macro поверх существующих primitives, а новый primitive ядра требует отдельного consumer case.

## Генерируемые якоря

| Тип | Источник |
| --- | --- |
| `requirement_id` | поле `id` файлов требований |
| `requirement_json_req_ref` | ссылки на требования внутри JSON требований |
| `code_req_ref` | ссылки `@req` в коде, тестах, скриптах и примерах |
| `doc_req_ref` | ссылки на требования в Markdown |
| `doc_heading_req_ref` | ссылки в заголовках строгих документов |
| `doc_heading_without_req_ref` | строгие заголовки без обязательной ссылки |

## Генерируемые правила

| Правило | Поведение |
| --- | --- |
| `requirement-json-req-refs-must-resolve` | ссылки между требованиями разрешаются |
| `code-req-refs-must-resolve` | ссылки из кода и тестов разрешаются |
| `doc-req-refs-must-resolve` | ссылки из документации разрешаются |
| `doc-heading-req-refs-must-resolve` | ссылки из строгих заголовков разрешаются |
| `doc-headings-must-have-req-ref` | строгий заголовок содержит ссылку на требование |
| `changed-requirements-need-evidence` | изменение требования требует evidence surface |
| `declared-affected-anchors-need-evidence` | `anchors.affects` требует подтверждения |
| `declared-implemented-anchors-need-evidence` | `anchors.implements` требует реализации |
| `declared-verified-anchors-need-evidence` | `anchors.verifies` требует проверки |

Эти правила исполняются общим `Constraint Program` и trace machinery, а не специальным валидатором профиля.

## Переопределения

Все overrides — непустые массивы непустых строк.

| Поле | Значение по умолчанию |
| --- | --- |
| `requirement_json_globs` | `requirements/.../*.json` для канонических требований |
| `code_reference_globs` | код, тесты, скрипты и примеры |
| `doc_reference_globs` | `*.md`, `docs/**/*.md`, `requirements/**/*.md`, `.github/**/*.md` |
| `strict_heading_docs` | `docs/**/*.md` |
| `evidence_surfaces` | `src/**`, `tests/**`, `docs/**`, `README.md`, `requirements/README.md` |
| `changed_requirement_evidence_surfaces` | по умолчанию `evidence_surfaces` |
| `affected_evidence_surfaces` | по умолчанию `evidence_surfaces` |
| `implementation_evidence_surfaces` | `include/**`, `src/**`, `scripts/**`, `.github/workflows/**` |
| `verification_evidence_surfaces` | `tests/**`, `experiments/**`, `scripts/**`, `.github/workflows/**` |

Пример:

```json
{
  "profile": "requirements-strict",
  "profile_overrides": {
    "strict_heading_docs": ["docs/architecture.md", "docs/pmm_requirements.md"],
    "evidence_surfaces": ["include/**", "src/**", "tests/**", "docs/**"],
    "verification_evidence_surfaces": ["tests/**", "scripts/**"]
  }
}
```
