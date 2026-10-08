# Пакет политики requirements-strict

Это факультативный технический пакет для проектов с соответствующей моделью данных. [Методика](contract-development.md) не требует его от каждого репозитория; цели задают [требования продукта](product-requirements.md).

`requirements-strict` — встроенный пакет данных `repo-guard` для репозиториев, где настроенный набор канонических требований является источником трассировки. Исторический default использует `JSON`; consumer может явно добавить канонические `YAML`-источники.

Публичный интерфейс v3 использует только поле `packs`. После проверки по схеме пакет разворачивается в обычные `anchors` и `trace_rules`, а поле `packs` исчезает до исполнения. Отдельного семейства исполнения, отдельного валидатора правил или отдельного движка у пакета нет.

`requirements-strict` нельзя совмещать с явно заданными `anchors` или `trace_rules`: такая политика отклоняется. Это сохраняет один источник авторитетной конфигурации вместо неявного смешивания сгенерированных и ручных правил.

## Почему это пакет

Предметные знания — шаблон идентификатора требования, маски путей и набор правил трассировки — хранятся как данные. Общий компилятор подставляет настройки и материализует стандартную политику поверх существующих примитивов.

Пакет не получает сетевого доступа, собственного файлового интерфейса или отдельной логики сравнения строгости. Добавление пакета не расширяет конечную алгебру отношений ядра.

## Генерируемые якоря

| Тип | Источник |
| --- | --- |
| `requirement_id` | поле `id` файлов требований |
| `requirement_json_req_ref` | ссылки на требования внутри `JSON` требований |
| `code_req_ref` | ссылки `@req` в коде, тестах, сценариях и примерах |
| `doc_req_ref` | ссылки на требования в `Markdown` |
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
| `changed-requirements-need-evidence` | изменение требования требует подтверждающей поверхности |
| `declared-affected-anchors-need-evidence` | `anchors.affects` требует подтверждения |
| `declared-implemented-anchors-need-evidence` | `anchors.implements` требует реализации |
| `declared-verified-anchors-need-evidence` | `anchors.verifies` требует проверки |

Все эти правила исполняются общим `Constraint Program` и общими отношениями.

## Настройки

Поля-маски ниже задаются непустыми массивами непустых строк. `requirement_id_pattern` — непустое регулярное выражение, не совпадающее с пустой строкой. `closed_repository` — boolean opt-in.

| Поле | Значение по умолчанию |
| --- | --- |
| `requirement_json_globs` | `requirements/.../*.json` для канонических требований |
| `requirement_yaml_globs` | отсутствует; YAML authority подключается явно |
| `requirement_id_pattern` | `(?:BR|SR|FR|NFR|CR|IR)-[0-9]{3}` |
| `closed_repository` | `false`; repository closure не включается неявно |
| `code_reference_globs` | код, тесты, сценарии и примеры |
| `doc_reference_globs` | `*.md`, `docs/**/*.md`, `requirements/**/*.md`, `.github/**/*.md` |
| `strict_heading_docs` | `docs/**/*.md` |
| `evidence_surfaces` | `src/**`, `tests/**`, `docs/**`, `README.md`, `requirements/README.md` |
| `changed_requirement_evidence_surfaces` | по умолчанию `evidence_surfaces` |
| `affected_evidence_surfaces` | по умолчанию `evidence_surfaces` |
| `implementation_evidence_surfaces` | `include/**`, `src/**`, `scripts/**`, `.github/workflows/**` |
| `verification_evidence_surfaces` | `tests/**`, `experiments/**`, `scripts/**`, `.github/workflows/**` |

## Пример

```json
{
  "packs": {
    "requirements-strict": {
      "strict_heading_docs": [
        "docs/architecture.md",
        "docs/pmm_requirements.md"
      ],
      "evidence_surfaces": [
        "include/**",
        "src/**",
        "tests/**",
        "docs/**"
      ],
      "verification_evidence_surfaces": [
        "tests/**",
        "scripts/**"
      ]
    }
  }
}
```


## YAML authority

Для YAML используется тот же parsed-document boundary, что и для остальных структурных facts. Authority parsing работает fail-closed:

- duplicate keys запрещены;
- aliases запрещены;
- merge keys запрещены;
- explicit/custom tags запрещены;
- parse warning/error считается ошибкой authority;
- `id` и `artifacts[].path` извлекаются структурно, а не регулярным выражением.

`requirement_id_pattern` меняет vocabulary ссылок, но не создаёт нового evaluator. Default остаётся прежним для совместимости.

## Traceability и closed repository

Обычная traceability отвечает на более слабые вопросы: существует ли referenced requirement и есть ли требуемое evidence. Она **не** доказывает, что весь Git tree выведен из требований.

При явном `closed_repository: true` пакет дополнительно материализует обычное отношение `set_equal`:

```text
justified artifact paths == exact Git-tracked paths
```

Левая сторона собирается из `artifacts[].path` канонических requirement authority files. Правая сторона — exact tracked-path fact наблюдаемого Git revision. Отдельного closure evaluator нет.

Диагностика имеет прямой смысл:

- `missing_values` — artifact объявлен requirement authority, но отсутствует в tracked tree;
- `extra_values` — tracked artifact не имеет requirement justification и является orphan.

Closure не имеет implicit exclusions. `README.md`, `.github/**`, schemas, generators, tests и любые другие tracked infrastructure files должны быть явно перечислены хотя бы в одном каноническом требовании. Wildcard, автоматически объявляющий весь repository оправданным, пакет не генерирует.

Набор файлов, выбранный `requirement_json_globs` / `requirement_yaml_globs`, является настроенным canonical authority set. Пакет не выполняет предметную процедуру «принятия» требований и не вводит поле вроде `accepted: true`: acceptance остаётся обязанностью consumer authority model. При этом repository нельзя объявить closed частично: равенство проверяется против полного exact Git-tracked set.

### Пример YAML closure

```yaml
# requirement authority
id: V15-FOUNDATION
kind: publication
artifacts:
  - path: requirements/V15-FOUNDATION.yaml
    role: requirement
  - path: docs/foundation.md
    role: publication
  - path: src/compiler.ts
    role: implementation
  - path: tests/compiler.test.ts
    role: verification
```

```json
{
  "packs": {
    "requirements-strict": {
      "requirement_yaml_globs": ["requirements/*.yaml"],
      "requirement_id_pattern": "V15-[A-Z0-9-]+",
      "closed_repository": true
    }
  }
}
```

При таком opt-in любой tracked path, отсутствующий в `artifacts[].path`, является blocking orphan, а любой объявленный artifact, отсутствующий в Git tree, — blocking missing artifact.
