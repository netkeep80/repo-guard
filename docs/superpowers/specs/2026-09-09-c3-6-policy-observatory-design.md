# C3.6 — Русскоязычная обсерватория политики `GitHub Pages`

Дата: 2026-09-09  
Дорожная карта: #370  
Родительская фаза: #377  
Принятая база перед проектированием: `48d1c3c981e1db070961d113fb35560ac7e02179`  
Зависимость #376: закрыта как завершённая

## 1. Решение

C3.6 создаёт русскоязычный статический сайт `GitHub Pages` как **чистую проекцию принятого состояния `repo-guard` только для чтения**.

Канонический поток:

```text
accepted main SHA
        ↓
read-only repository facts
+ accepted generated analysis
+ bounded GitHub observations
        ↓
observatory.snapshot.json
        ↓
deterministic static renderer
        ↓
_site/**
        ↓
GitHub Pages artifact
        ↓
human observability only
```

Сайт не является источником политики, семантическим исполняемым контуром, поверхностью согласования или управляющим контуром.

Главный архитектурный ответ C3.6:

```text
Can Pages be a pure projection of accepted repository facts,
without inventing any new semantic authority?

YES.
```

Если реализация потребует новый источник `FactRef`, новый дескриптор отношения, новый исполняемый вид ограничения, новый язык политики или отдельный вычислитель, работа должна остановиться. Такой разрыв классифицируется отдельно от C3.6.

## 2. Жёсткие инварианты

C3.6 обязана сохранить:

```text
canonical FactRef models = 1
canonical FactRef sources = 4
runtime constraint kinds = 1
runtime constraint kind = primitive_relation
relation descriptor count = 10
primitive descriptor registries = 1
public CLI commands = validate, check-diff, check-pr, init, doctor
```

Строго запрещено:

```text
NO second policy parser
NO second policy evaluator
NO Pages-specific semantic model
NO handwritten rule inventory
NO handwritten scenario inventory
NO scenario-specific runtime
NO Pages-side repository mutation
NO issue / PR / governance approval from Pages
NO workflow dispatch from Pages
NO new public CLI command
NO C3.7 version/release cutover
NO v3.0.0 release
NO C3.8 CI redesign
NO committed generated HTML tree as authority
NO branch-protection Administration token in Pages build
```

## 3. Источники истины и происхождение данных

### 3.1 Факты, связанные с коммитом

Эти факты определяются точным принятым коммитом и воспроизводятся из дерева Git:

```text
package.json
repo-policy.json
action.yml
.github/workflows/ci.yml
examples/scenarios/**
docs/self-hosting-coverage.json
schemas/**
canonical source registries
scripts/compression-metrics.mjs
accepted generated dist/**
```

Происхождение:

```text
origin = accepted_commit
sha = <exact accepted SHA>
```

### 3.2 Доказательство принятия в CI

Сайт запускается только после успешного послемержевого процесса `CI` на ветке `main`.

Из события `workflow_run` используется только метаинформация о принятии:

```text
workflow name
run id
run URL
head SHA
conclusion
```

Это доказательство приёмки точного коммита существующим CI, а не новый семантический источник.

### 3.3 Ограниченные наблюдения GitHub

В C3.6 допускаются только наблюдения для чтения без расширения привилегированной границы доверия:

```text
published GitHub Releases / matching release state
workflow_run acceptance metadata
Pages deployment URL from deploy action
```

Живая конфигурация защиты ветки сознательно **не входит** в обязательные входные данные C3.6. Чтение защиты ветки требует отдельного разрешения `Administration(read)`; обсерватория не получает такой токен только ради визуализации.

Сайт различает:

```text
declared CI wiring
  <- .github/workflows/ci.yml at accepted SHA

accepted CI evidence
  <- successful workflow_run for the same SHA
```

Сайт не утверждает, что живая защита ветки равна отображаемой схеме CI, если такой факт не был получен.

## 4. Существующие машинные источники

### 4.1 Архитектурные метрики

`scripts/compression-metrics.mjs` остаётся единственным существующим инвентарём архитектурных метрик C3. Сборщик не дублирует его анализ.

Он вызывается для:

```text
current = <accepted SHA>
baseline = 92432809fcddc290080beb51ba151e13a5761869
```

и выдаёт:

```text
physical metrics
rule-family metrics
canonical FactRef sources
FactRef model count
relation descriptor kinds
public relation kinds
runtime constraint kinds
semantic edit-site metrics
self-policy metrics
CI structural metrics
```

### 4.2 Рабочий компилятор программы ограничений

Топология собственной политики и её понижение строятся рабочим компилятором из принятого сгенерированного исполнения:

```text
repo-policy.json
        ↓
compileConstraintProgram(...)
        ↓
canonical Constraint Program entries
```

Сайт отображает уже скомпилированные данные:

```text
runtime primitive_relation entries
strictness-only entries
relation ids
primitive ids
FactRef operands
execution phase
advisory metadata
```

Отрисовщик не интерпретирует эти записи.

### 4.3 Исполняемые сценарии C3.5

Единственный источник сценариев:

```text
examples/scenarios/*/scenario.json
```

Обнаружение общее: любой каталог с корректным `scenario.json` автоматически входит в каталог.

Нельзя иметь отдельный массив идентификаторов сценариев для страниц.

Карточки PASS/FAIL показывают исполняемые варианты и ожидаемые диагностики из манифестов. Значок принятого состояния означает, что вышестоящий CI для точного SHA зелёный; сборка страниц **не повторяет** все исполнения сценариев.

### 4.4 Состояние версии и выпуска

Представление версии различает:

```text
package version
matching published GitHub Release
future release truth
```

До C3.7 значение `package.json.version = 2.0.0` не представляется как опубликованный выпуск v3.

Нормализованная модель:

```text
package_version
matching_release_tag = v<package_version>
matching_published_release = present | absent
release_truth_status = published | package_only
```

Ошибка API не превращается в `absent`: сборщик завершается ошибкой, чтобы сайт не публиковал ложное состояние выпуска.

## 5. Сгенерированный снимок

`observatory.snapshot.json` — внутренний сгенерированный артефакт сборки, а не файл-источник истины и не публичный API v3. В Git он не коммитится.

Минимальная логическая форма:

```json
{
  "schema_version": 1,
  "accepted": {
    "sha": "<40-char SHA>",
    "ci": {
      "workflow": "CI",
      "run_id": 0,
      "run_url": "...",
      "conclusion": "success"
    }
  },
  "version": {},
  "policy": {
    "source": "repo-policy.json",
    "summary": {},
    "constraint_program": []
  },
  "architecture": {},
  "ci": {
    "declared_workflow": ".github/workflows/ci.yml",
    "jobs": []
  },
  "scenarios": [],
  "sources": []
}
```

Каждый крупный раздел несёт происхождение:

```text
origin = accepted_commit | accepted_ci | github_observation
source path/event
accepted SHA
```

Точный SHA постоянно виден в верхней части сайта.

## 6. Граница детерминизма

Детерминизм определяется не только коммитом Git, потому что состояние выпуска является ограниченным наблюдением GitHub.

Правильный инвариант:

```text
same accepted commit-bound inputs
+ same normalized GitHub observation payload
+ same accepted CI metadata
        ↓
byte-identical snapshot
+ byte-identical rendered site
```

Сборщик обязан нормализовать и стабильно сортировать данные наблюдений GitHub до формирования снимка.

В сгенерированное содержимое не входят текущее время, случайные идентификаторы и абсолютные пути окружения.

## 7. Статическая отрисовка

Отрисовщик принимает только проверенный снимок и создаёт:

```text
_site/index.html
_site/assets/observatory.css
```

Допустим один маленький `_site/assets/observatory.js` только для интерфейсного удобства:

```text
filter
collapse/expand
client-side navigation
```

Клиентский JavaScript не может:

```text
fetch policy from GitHub
call GitHub APIs
recompute semantics
mutate repository
trigger Actions
```

Не используются React, Vue, Vite, SSR, сервер приложений или база данных.

## 8. Обязательные представления

### 8.1 Принятое состояние

```text
exact accepted SHA
upstream CI run URL
CI conclusion
package version
matching GitHub release status
```

### 8.2 Собственная политика

Проекция реального `repo-policy.json` только для чтения:

```text
policy_format_version
repository_kind
enforcement
path classes
diff budgets
size rules
content rules
cochange rules
document relations
```

Не отображать отсутствующие поля собственной политики только ради демонстрации возможностей.

### 8.3 Каноническая архитектура

Из архитектурных метрик и реестров:

```text
FactRef sources
FactRef model count
runtime constraint kinds
relation descriptor kinds
public relation kinds
semantic edit-site metrics
physical src/schema/tests/docs/examples metrics
```

Обсерватория обязана различать:

```text
CANONICAL POLICY SEMANTICS
Constraint Program
  -> primitive_relation
  -> relation kernel

TRANSACTION / TRUST / REPORTING GATES
GovernanceGrant authorization
policy-delta authorization
content / anchor / advisory/reporting families
```

Фраза «в `repo-guard` вообще только один вычислитель» запрещена как неточная.

### 8.4 Понижение высокоуровневой конфигурации

Основной живой пример:

```text
accepted repo-policy.json
  -> compileConstraintProgram
  -> canonical entries
```

Если собственная политика не использует высокоуровневый пакет, сайт честно показывает:

```text
active high-level pack in self-policy: none
```

C3.6 не создаёт искусственный пример пакета только ради заполнения раздела.

### 8.5 Топология намерения, управления и доказательств

Человеческое объяснение:

```text
ChangeIntent
  = declared transaction shape

linked trusted issue
  -> GovernanceGrant
  -> trusted authorizer

BASE trusted policy
  + HEAD candidate policy
  -> canonical strictness comparison

result
  -> AnalysisReport / blocking decision
```

Пояснительная схема может быть написана вручную, но конкретные активные перечни правил и ограничений должны выводиться машинно.

### 8.6 Схема CI

`.github/workflows/ci.yml` читается общим разборщиком YAML; отображаются:

```text
workflow name
trigger classes
job ids
step names where useful
```

Принятое событие `workflow_run` отдельно даёт точный SHA, ссылку запуска и успешный результат.

### 8.7 Метрики сжатия

```text
C3.0 baseline
current accepted state
delta
```

Источник — существующий вывод архитектурных метрик.

### 8.8 Исполняемые сценарии

Для каждого автоматически найденного сценария:

```text
id
title_ru
summary_ru
production command
PASS/FAIL case titles
expected diagnostic ids
```

### 8.9 Канонические ссылки

Ссылки строятся из идентичности репозитория и принятого SHA. Ссылки на исходники по возможности указывают на неизменяемый SHA, а не на `main`.

## 9. Схема публикации

C3.6 не создаёт третий полный цикл проверки.

Триггер рабочего процесса:

```text
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]
```

Сборка и публикация разрешены только если:

```text
workflow_run.conclusion == success
```

Получение исходников выполняется по:

```text
ref = workflow_run.head_sha
```

### 9.1 Проверки свежести

До сбора данных:

```text
git rev-parse HEAD == workflow_run.head_sha
```

Перед загрузкой артефакта и повторно непосредственно перед публикацией:

```text
remote refs/heads/main == workflow_run.head_sha
```

Если `main` ушёл вперёд:

```text
NO DEPLOY OF STALE CANDIDATE
```

Ошибка должна быть видна в рабочем процессе; старый опубликованный сайт остаётся с собственным явно указанным точным SHA.

### 9.2 Конкурентные публикации

Используется одна группа конкурентности:

```text
group = pages
cancel-in-progress = true
```

Это сознательный выбор в пользу свежести: более новая принятая сборка страниц отменяет старую ещё исполняющуюся сборку или публикацию. Проверки свежести остаются обязательными и не заменяются конкурентностью.

### 9.3 Предусловие источника публикации

Перед первой публикацией источник `GitHub Pages` в настройках репозитория должен быть установлен в `GitHub Actions`.

Это одноразовая административная настройка репозитория, а не возможность самой обсерватории.

C3.6 не вводит постоянный привилегированный токен для автоматизации этой настройки. Если доступный контур автоматизации не умеет безопасно изменить настройку, включение выполняется как отдельное явно зафиксированное административное действие.

## 10. Разрешения

### Сборка, сбор данных и отрисовка

Точный набор разрешений:

```text
contents: read
pages: read
```

Остальные разрешения задания сборки равны `none`.

Задание сборки не получает:

```text
contents: write
issues: write
pull-requests: write
actions: write
administration: read/write
id-token: write
```

### Публикация

Отдельное задание публикации получает:

```text
pages: write
id-token: write
```

Окружение:

```text
github-pages
```

Задание публикации не получает разрешений на изменение репозитория.

## 11. Граница стоимости CI

Вышестоящий CI уже доказал точный принятый SHA, поэтому сборка страниц не запускает повторно:

```text
npm test
repo-guard validate
repo-guard check-pr
smoke-pack
all 10 scenario executions
npm run check:dist
```

Для сборщика нужен только принятый сгенерированный исполняемый код и рабочие зависимости:

```text
npm ci --omit=dev
```

Работа, специфичная для страниц:

```text
checkout exact SHA
npm ci --omit=dev
compression metrics projection
production compiler projection
scenario manifest discovery
release observation
snapshot validation
static render
freshness gates
Pages artifact upload/deploy
```

Общая программа оптимизации остаётся C3.8.

## 12. Стратегия тестирования

Первый реализационный коммит C3.6 — только тестовый красный фальсификатор.

Минимальные доказательства:

### Источник истины

```text
accepted SHA is required and valid
wrong checked-out SHA fails
scenario catalog is discovered generically
architecture inventory reuses existing metrics
self-policy lowering comes from production compiler
```

### Детерминизм

Для одинакового нормализованного набора входов:

```text
snapshot bytes identical
rendered site bytes identical
```

### Устаревание

```text
accepted_sha != checked_out_sha -> fail
accepted_sha != current remote main -> no deploy
CI conclusion != success -> no build/deploy
```

### Граница только для чтения

Статический или узкий тест подтверждает отсутствие:

```text
repository write API
issue write API
PR write API
workflow dispatch
merge mutation
policy mutation endpoint
```

### Каталог сценариев

Все пять принятых сценариев C3.5 появляются автоматически. Добавление будущего корректного манифеста сценария не требует изменения семантической диспетчеризации отрисовщика.

## 13. Минимальная поверхность реализации

Предпочтительно:

```text
scripts/observatory/collect.mjs
scripts/observatory/render.mjs
tests/test-c3-6-observatory.mjs
.github/workflows/pages.yml
```

Допустим маленький каталог `scripts/observatory/assets/**` только для визуальных ресурсов.

Сгенерированные `_site/**` и `observatory.snapshot.json` не коммитятся.

README получает короткую ссылку на обсерваторию только после фактического появления страниц.

## 14. Отклонённые варианты

### Коммитить дерево страниц

```text
accepted data -> generator -> committed pages/**
```

Вариант отклонён из-за шума сгенерированного дерева, новой поверхности совместных изменений и смешения источника истины с проекцией.

### Читать GitHub из браузера

```text
browser -> GitHub API/raw main -> reconstruct state
```

Вариант отклонён из-за сетевой зависимости во время просмотра, гонок между чтениями GitHub и невозможности получить единый воспроизводимый артефакт точного SHA.

### Добавить новую публичную команду

Не добавлять `repo-guard observatory`, `repo-guard pages` или аналог. Обсерватория — проекция разработки и документации, а не потребительская исполняемая возможность.

## 15. Модель отказа

Не публиковать кандидат сайта, если:

```text
accepted SHA missing/malformed
checkout SHA differs
upstream CI is not success
compression analysis fails
production policy compilation fails
scenario manifest invalid
GitHub release observation fails
snapshot validation fails
renderer fails
remote main advanced
Pages upload/deploy fails
```

Никакой запасной путь не имеет права подменять неизвестное состояние ложным успехом или ложным отсутствием.

## 16. Определение готовности C3.6

C3.6 закрывается только когда:

- русскоязычный статический сайт опубликован;
- сайт явно связан с точным принятым SHA ветки `main`;
- публикация возможна только после успешного `CI` на том же SHA;
- устаревший кандидат не может молча опубликоваться;
- представление собственной политики выведено из принятых данных репозитория;
- представление пониженных ограничений выведено рабочим компилятором;
- архитектурное представление выведено существующими метриками и реестрами;
- каталог сценариев выведен только из `examples/scenarios/**`;
- версия пакета и опубликованный выпуск GitHub различаются честно;
- объявленная схема CI и доказательство принятия CI показаны раздельно;
- административное разрешение защиты ветки не добавлено;
- страницы не имеют поверхности изменения репозитория или управляющего контура;
- тесты детерминизма зелёные;
- ссылки README, страниц и неизменяемых исходников сходятся;
- число исполняемых видов, источников `FactRef` и дескрипторов отношений не выросло;
- все собственные проверки зелёные;
- проверка политики на точной готовой голове PR зелёная;
- слияние выполнено по точной принятой голове;
- после слияния `validate` и `smoke-pack` зелёные.

## 17. Вне области C3.6

```text
C3.7 versioning/release truth cutover
v3.0.0 tag/release
npm publication redesign
C3.8 CI minute optimization
branch-protection Administration API
interactive policy editor
GovernanceGrant UI
workflow dispatch UI
repository mutation from site
analytics/search backend
```

## 18. Следующий шаг после принятия спецификации

После проверки и явного принятия этой спецификации:

```text
write implementation plan
        ↓
RED-first implementation in bounded slices
```

До отдельного одобрения спецификации реализация не начинается.
