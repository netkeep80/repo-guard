# План C3.4b — канонический живой пример собственной политики

**Задача:** #423  
**Родитель:** #375  
**Дорожная карта:** #370  
**Принятый дизайн:** `docs/superpowers/specs/2026-09-09-c3-4-canonical-self-policy-exemplar-design.md`  
**Принятая база:** `25560cf62e3336cdd089a779a9032db01b0c71f1`

## Цель

Сжать собственную политику `repo-guard` до обычной потребительской политики, которая содержит только реальные инварианты этого репозитория и одновременно является проверяемым примером принятой архитектуры.

Этот срез не меняет движок. Если для выполнения плана потребуется изменение `src/**`, `dist/**` или schema, выполнение останавливается: это означает, что обнаружен новый архитектурный разрыв, которого нет в принятом дизайне.

## Неподвижные границы

```text
NO src/**
NO dist/**
NO schemas/**
NO action.yml
NO .github/workflows/**
NO new runtime kind
NO new FactRef source
NO new relation descriptor
NO repo-guard-specific profile
NO workflow/integration DSL
NO compatibility layer
NO broad allow_policy_relaxation: /
```

Разрешённые файлы реализации:

```text
tests/test-c3-4b-self-host-exemplar.mjs
repo-policy.json
README.md
docs/self-hosting-coverage.md
docs/self-hosting-coverage.json
templates/repo-policy.min.json
templates/example-workflow.yml
```

## Шаг 1. Зафиксировать тестовый RED

Создать только:

```text
tests/test-c3-4b-self-host-exemplar.mjs
```

Другие файлы в первом коммите не менять.

Тест должен читать живые артефакты репозитория и импортировать уже существующие реестры из `dist`:

```js
COMMANDS

defaultRuleFamilies

listBuiltInProfiles
```

Для YAML использовать уже установленный пакет `yaml`.

Тест должен получить принятую стартовую политику без ручного копирования её содержимого:

```bash
git show 25560cf62e3336cdd089a779a9032db01b0c71f1:repo-policy.json
```

### 1.1. Сжатие собственной политики

RED-проверки:

```text
surfaces отсутствует
new_file_classes отсутствует
change_profiles отсутствует
текущая repo-policy меньше принятой стартовой repo-policy
```

Сравнивать как минимум:

```text
bytes
top-level key count
```

Не фиксировать ожидаемый конечный размер в байтах: тест требует только доказанного уменьшения относительно принятой базы.

### 1.2. Управляющая граница

Проверить наличие в `paths.governance_paths` ровно необходимых новых управляющих путей:

```text
package.json
package-lock.json
tsconfig.json
scripts/build.mjs
scripts/check-dist.mjs
scripts/verify-release-ref.mjs
```

Не требовать `scripts/compression-metrics.mjs`.

### 1.3. Реальные документные отношения

Проверить наличие двух документов:

```json
{
  "package": { "path": "package.json", "format": "json" },
  "action": { "path": "action.yml", "format": "yaml" }
}
```

Проверить четыре правила по `id` и полной семантической форме:

```json
{
  "id": "package-main-matches-bin",
  "kind": "scalar_equal",
  "left": { "document": "package", "pointer": "/main", "type": "string" },
  "right": { "document": "package", "pointer": "/bin/repo-guard", "type": "string" }
}
```

```json
{
  "id": "package-main-entrypoint",
  "kind": "scalar_equals_literal",
  "source": { "document": "package", "pointer": "/main", "type": "string" },
  "value": "dist/repo-guard.mjs"
}
```

```json
{
  "id": "action-default-mode",
  "kind": "scalar_equals_literal",
  "source": { "document": "action", "pointer": "/inputs/mode/default", "type": "string" },
  "value": "check-pr"
}
```

```json
{
  "id": "action-default-enforcement",
  "kind": "scalar_equals_literal",
  "source": { "document": "action", "pointer": "/inputs/enforcement/default", "type": "string" },
  "value": "blocking"
}
```

Не добавлять другие отношения ради демонстрации возможностей.

### 1.4. Живая топология самоприменения

Разобрать `.github/workflows/ci.yml` как YAML и доказать по существующим шагам:

```text
validate запускает npm run check:dist
validate запускает npm run compression:metrics
validate запускает npx repo-guard
validate запускает npx repo-guard doctor
validate запускает npm test
Ready PR запускает uses: ./
Ready PR передаёт mode: check-pr
Ready PR передаёт enforcement: blocking
CI содержит реальное advisory-выполнение check-diff
smoke-pack содержит npm pack
smoke-pack устанавливает полученный пакет
smoke-pack запускает установленный repo-guard
```

Не создавать отдельный файл-манифест топологии.

Проверить существование `repo-guard-yaml` в:

```text
.github/PULL_REQUEST_TEMPLATE.md
.github/ISSUE_TEMPLATE/change-intent.yml
```

### 1.5. Выводимые реестры и исключения

Получить команды из `COMMANDS`.

Из текста живого CI вывести команды, которые реально используются самим репозиторием:

```text
validate — bare npx repo-guard
check-diff — advisory fixture
check-pr — uses: ./ with mode
 doctor — direct CI invocation
```

Нормализовать пробел перед `doctor`; имя команды в реестре остаётся `doctor`.

Каждая команда должна быть либо наблюдаема в CI, либо иметь исключение `command:<name>` в `docs/self-hosting-coverage.json`.

После GREEN единственным таким командным исключением должен быть:

```text
command:init
```

Проверить, что каждое исключение вида:

```text
rule:<id>
```

ссылается на `id`, реально присутствующий в `defaultRuleFamilies`.

Проверить, что каждое исключение вида:

```text
profile:<id>
```

ссылается на значение из `listBuiltInProfiles()`.

Каждое исключение должно иметь непустое объяснение.

Не превращать тест в ручную матрицу всех возможностей.

### 1.6. Шаблоны

RED-проверки:

```text
templates/repo-policy.min.json policy_format_version == 0.3.0
templates/example-workflow.yml uses actions/checkout@v6
```

### 1.7. Доказать RED

Открыть Draft PR с test-only head.

Ожидаемое состояние:

```text
smoke-pack = GREEN
check:dist = GREEN
schema/self-policy/doctor до suite = GREEN
discovered suite = RED только в новом C3.4b test
```

Зафиксировать exact причины RED в PR/issue контексте.

Коммит:

```text
test(c3.4b): define canonical self-host exemplar ratchet
```

## Шаг 2. Выполнить атомарное сжатие repo-policy

Изменить только `repo-policy.json`.

Удалить целиком:

```text
surfaces
new_file_classes
change_profiles
```

Не менять:

```text
enforcement
forbidden paths
canonical docs
operational paths
diff_rules
size_rules
content_rules
cochange_rules
```

В `paths.governance_paths` добавить:

```text
package.json
package-lock.json
tsconfig.json
scripts/build.mjs
scripts/check-dist.mjs
scripts/verify-release-ref.mjs
```

Добавить `document_relations` ровно с двумя документами и четырьмя правилами из шага 1.3.

После изменения проверить, что schema принимает политику и обычный запуск `repo-guard` исполняет документные отношения на реальных `package.json` и `action.yml`.

Этот переход является ослаблением только по трём точным указателям:

```text
/surfaces
/new_file_classes
/change_profiles
```

Их покрывает доверенный `GovernanceGrant` из #423.

Никакой `/` не разрешён.

## Шаг 3. Сделать утверждения о самоприменении истинными

Изменить:

```text
docs/self-hosting-coverage.json
docs/self-hosting-coverage.md
```

В JSON:

- оставить файл только списком честных исключений;
- исправить комментарий: общий инвентарь проверяет новый C3.4b falsifier, а `tests/test-self-hosting.mjs` остаётся doctor-тестом;
- добавить `command:init` с объяснением, что изменение принятого репозитория через `init` было бы искусственным, а команда покрыта отдельными тестами;
- сохранить реальные исключения для эвристического Markdown, anchor extraction, `requirements-strict` и JSON-формы ChangeIntent, если новый выводимый тест подтверждает их актуальность.

В Markdown:

- больше не утверждать, что doctor-тест строит матрицу возможностей;
- описать два независимых слоя доказательства:
  1. реальное самоприменение через CI/Action/policy;
  2. выводимый инвентарь реестров и ссылочная целостность исключений через C3.4b falsifier;
- явно указать, что неиспользуемая самим репозиторием возможность должна иметь специализированный тест и честное исключение только там, где dogfooding был бы искусственным.

## Шаг 4. Синхронизировать потребительские примеры

Изменить:

```text
templates/repo-policy.min.json
templates/example-workflow.yml
README.md
```

`templates/repo-policy.min.json`:

```text
0.1.0 -> 0.3.0
```

Не превращать минимальный шаблон в копию self-policy.

`templates/example-workflow.yml`:

```text
actions/checkout@v4 -> actions/checkout@v6
```

Другие версии менять только при отдельном фактическом рассогласовании.

`README.md`:

- удалить `registry_rules` из списка текущих возможностей;
- не называть `surfaces`, `new_file_classes`, `change_profiles` обязательной архитектурой собственного repo-guard;
- сохранить их как доступные потребительские возможности, если они описываются как опциональные возможности публичного языка;
- в разделе самоприменения сослаться на реальную компактную self-policy и четыре реальные document relations;
- не добавлять workflow DSL и не дублировать CI как ручной манифест.

## Шаг 5. GREEN и архитектурная проверка

После единого implementation-коммита запустить полный CI в Draft.

Нужны:

```text
check:dist = GREEN
compression metrics = GREEN
repo-policy validation = GREEN
doctor = GREEN
all discovered tests = GREEN
smoke-pack = GREEN
```

Проверить метрики:

```text
repo-policy bytes < accepted C3.4b starting policy
repo-policy top-level concepts < accepted C3.4b starting policy
surfaces = 0
new_file_classes = 0
change_profiles = 0
document relation rules = 4
runtime constraint kinds = 1
runtime kind = primitive_relation
FactRef sources = 4
relation descriptors = 10
new engine concepts = 0
```

Проверить diff относительно `25560cf62e3336cdd089a779a9032db01b0c71f1`:

```text
нет src/**
нет dist/**
нет schemas/**
нет action.yml
нет .github/workflows/**
```

Implementation-коммит:

```text
refactor(c3.4b): compress self-policy exemplar
```

Если удобнее для доказуемости, документацию и шаблоны можно вынести в следующий отдельный commit, но все изменения остаются в одном PR и каждый промежуточный head должен иметь понятную причину состояния.

## Шаг 6. Ready acceptance

До Ready сделать review полного diff по #423 и принятому дизайну.

Перевести PR в Ready только после Draft GREEN.

На неизменном exact head обязательны:

```text
validate = GREEN
smoke-pack = GREEN
Run PR policy check = GREEN
```

Ready PR должен сам доказать атомарную управляющую миграцию через доверенный grant #423.

Нельзя обходить падение policy check расширением grant за пределы трёх разрешённых policy pointers без отдельного доказанного изменения дизайна.

## Шаг 7. Merge и post-merge

Перед merge повторно проверить:

```text
main не ушёл вперёд неожиданно
PR mergeable
exact head совпадает с GREEN Ready head
```

Слить exact head обычным merge.

На новом `main` дождаться свежего post-merge CI и потребовать:

```text
validate = GREEN
smoke-pack = GREEN
```

Только после этого считать #423 выполненной и закрыть её как `completed`, если GitHub не сделал это автоматически.

## Шаг 8. Вернуться к #375

После принятия C3.4b выполнить отдельный финальный аудит родителя #375:

```text
self-policy действительно является компактным обычным примером
machine-visible policy -> evidence -> CI topology доказана
policy complexity уменьшена
README/templates/examples не расходятся с текущим продуктом
protected Ready PR path был реально пройден
```

Не начинать C3.5 или C3.6 автоматически.
