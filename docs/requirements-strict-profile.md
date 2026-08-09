# Профиль requirements-strict

`requirements-strict` — встроенный профиль политики `repo-guard` для репозиториев, где файлы требований в `JSON` являются каноническим источником трассировки.

Профиль включается полем верхнего уровня `profile: "requirements-strict"`. Сначала `repo-guard` валидирует исходную политику по схеме, затем разворачивает профиль в `anchors` и `trace_rules`, после чего компилирует итоговую политику.

Если репозиторий уже хранит явные `anchors` или `trace_rules`, они имеют приоритет над сгенерированными секциями.

## Генерируемые якоря

| Тип якоря | Источник |
| --- | --- |
| `requirement_id` | поля `id` в файлах требований |
| `requirement_json_req_ref` | ссылки на требования внутри файлов требований |
| `code_req_ref` | ссылки `@req` в коде, тестах, сценариях и примерах |
| `doc_req_ref` | ссылки на требования в документации `Markdown` |
| `doc_heading_req_ref` | ссылки на требования в заголовках строгих документов |
| `doc_heading_without_req_ref` | заголовки строгих документов без требуемой ссылки |

## Генерируемые правила трассировки

| Правило | Поведение |
| --- | --- |
| `requirement-json-req-refs-must-resolve` | ссылки между требованиями должны разрешаться |
| `code-req-refs-must-resolve` | ссылки из кода и тестов должны разрешаться |
| `doc-req-refs-must-resolve` | ссылки из документации должны разрешаться |
| `doc-heading-req-refs-must-resolve` | ссылки из строгих заголовков должны разрешаться |
| `doc-headings-must-have-req-ref` | строгие заголовки обязаны содержать ссылку на требование |
| `changed-requirements-need-evidence` | изменение требования требует подтверждающей поверхности |
| `declared-affected-anchors-need-evidence` | `anchors.affects` требует подтверждения |
| `declared-implemented-anchors-need-evidence` | `anchors.implements` требует реализации |
| `declared-verified-anchors-need-evidence` | `anchors.verifies` требует проверки |

## Переопределения

Все переопределения задаются непустыми массивами непустых строк.

| Поле | Значение по умолчанию |
| --- | --- |
| `requirement_json_globs` | набор `requirements/.../*.json` для канонических требований |
| `code_reference_globs` | код, тесты, сценарии и примеры |
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
    "strict_heading_docs": [
      "docs/architecture.md",
      "docs/pmm_requirements.md"
    ],
    "evidence_surfaces": [
      "include/**",
      "src/**",
      "tests/**",
      "examples/**",
      "docs/**",
      "README.md",
      "requirements/README.md",
      "scripts/**",
      ".github/workflows/**"
    ],
    "verification_evidence_surfaces": [
      "tests/**",
      "experiments/**",
      "scripts/**",
      ".github/workflows/**"
    ]
  }
}
```
