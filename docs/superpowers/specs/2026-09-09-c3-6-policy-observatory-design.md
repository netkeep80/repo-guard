# C3.6 — Русскоязычная обсерватория политики `GitHub Pages`

Дата: 2026-09-09  
Дорожная карта: #370  
Родительская фаза: #377  
Принятая база: `48d1c3c981e1db070961d113fb35560ac7e02179`  
Зависимость #376: закрыта как завершённая

## 1. Решение

C3.6 создаёт статический русскоязычный сайт `GitHub Pages` как чистую проекцию принятого состояния `repo-guard` только для чтения.

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

Сайт не является источником политики, вычислителем семантики, управляющим контуром или поверхностью согласования.

Архитектурный ответ C3.6:

```text
Can Pages be a pure projection of accepted repository facts,
without inventing any new semantic authority?
YES.
```

Если реализация потребует новый источник `FactRef`, дескриптор отношения, исполняемый вид ограничения, язык политики или отдельный вычислитель, работа останавливается и такой разрыв классифицируется отдельно.

## 2. Жёсткие инварианты

C3.6 сохраняет:

```text
canonical FactRef models = 1
canonical FactRef sources = 4
runtime constraint kinds = 1
runtime constraint kind = primitive_relation
relation descriptor count = 10
primitive descriptor registries = 1
public CLI commands = validate, check-diff, check-pr, init, doctor
```

Запрещено:

```text
NO second policy parser
NO second policy evaluator
NO Pages-specific semantic model
NO handwritten rule inventory
NO handwritten scenario inventory
NO scenario-specific runtime
NO Pages-side repository mutation
NO issue or PR approval from Pages
NO governance approval from Pages
NO workflow dispatch from Pages
NO new public CLI command
NO C3.7 version or release cutover
NO v3.0.0 release
NO C3.8 CI redesign
NO committed generated HTML tree as authority
NO branch-protection Administration token in Pages build
```

## 3. Источники и происхождение данных

### 3.1 Факты принятого коммита

Эти данные определяются точным принятым коммитом и воспроизводятся из дерева `Git`:

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

### 3.2 Доказательство принятия

Обсерватория строится только после успешного послемержевого процесса `CI` для ветки `main`.

Из события `workflow_run` используется только метаинформация:

```text
workflow name
run id
run URL
head SHA
conclusion
```

Это доказательство приёмки точного коммита существующим процессом, а не новый семантический источник.

### 3.3 Ограниченные наблюдения `GitHub`

Допустимы только наблюдения для чтения без расширения привилегированной границы:

```text
published GitHub Releases / matching release state
workflow_run acceptance metadata
Pages deployment URL from deploy action
```

Живая защита ветки не входит в обязательные входы C3.6. Её чтение требует отдельного `Administration(read)`, поэтому сайт не получает такой токен ради визуализации.

Обсерватория различает:

```text
declared CI wiring
  <- .github/workflows/ci.yml at accepted SHA

accepted CI evidence
  <- successful workflow_run for the same SHA
```

Она не утверждает, что живая защита ветки совпадает с отображаемой схемой, если этот факт не наблюдался.

## 4. Машинные источники

### 4.1 Архитектурные метрики

`scripts/compression-metrics.mjs` остаётся существующим источником архитектурного инвентаря. Сборщик страниц не дублирует его анализ.

Он сравнивает:

```text
current = <accepted SHA>
baseline = 92432809fcddc290080beb51ba151e13a5761869
```

Нужные данные уже включают:

```text
physical metrics
registered rule families
canonical FactRef sources
FactRef model count
relation descriptor kinds
public relation kinds
runtime constraint kinds
semantic edit-site metrics
self-policy metrics
CI structural metrics
```

### 4.2 Рабочий компилятор ограничений

Понижение собственной политики не реконструируется вручную.

```text
repo-policy.json
        ↓
compileConstraintProgram(...)
        ↓
canonical Constraint Program entries
```

Сборщик использует принятый рабочий компилятор из сгенерированного исполнения. Отрисовщик только показывает результат.

Можно отображать:

```text
runtime primitive_relation entries
strictness-only entries
relation ids
primitive ids
FactRef operands
execution phase
advisory metadata
```

### 4.3 Исполняемые сценарии C3.5

Единственный источник каталога:

```text
examples/scenarios/*/scenario.json
```

Обнаружение общее: любой каталог с корректным `scenario.json` автоматически входит в представление.

Отдельный список идентификаторов сценариев для страниц запрещён.

Карточки `PASS` и `FAIL` выводятся из манифестов. Их исполнение уже входит в вышестоящий CI, поэтому сборка страниц не запускает сценарии повторно.

### 4.4 Версия и выпуск

Представление версии различает:

```text
package version
matching published GitHub Release
future release truth
```

До C3.7 значение `package.json.version = 2.0.0` не представляется как опубликованный выпуск v3.

Нормализованное состояние:

```text
package_version
matching_release_tag = v<package_version>
matching_published_release = present | absent
release_truth_status = published | package_only
```

Ошибка `API` не превращается в состояние отсутствия выпуска. Сборка завершается ошибкой, чтобы не публиковать ложное наблюдение.

## 5. Сгенерированный снимок

`observatory.snapshot.json` является внутренним артефактом сборки. Это не файл-источник истины и не публичный `API`. В `Git` он не коммитится.

Минимальная форма:

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
source path or event
accepted SHA
```

Точный `SHA` постоянно виден пользователю в верхней части сайта.

## 6. Детерминизм

Детерминизм зависит от коммита `Git` и от нормализованного наблюдения `GitHub`.

```text
same accepted commit-bound inputs
+ same normalized GitHub observation payload
+ same accepted CI metadata
        ↓
byte-identical snapshot
+ byte-identical rendered site
```

Сборщик стабильно сортирует наблюдаемые данные до записи снимка.

В результат не входят текущее время, случайные идентификаторы и абсолютные пути окружения.

## 7. Статическая отрисовка

Минимальный результат:

```text
_site/index.html
_site/assets/observatory.css
```

Допустим небольшой `_site/assets/observatory.js` только для представления:

```text
filter
collapse/expand
client-side navigation
```

Клиентский код не читает политику из сети, не вызывает `GitHub API`, не вычисляет семантику и не запускает действия.

Фреймворки `React`, `Vue`, `Vite` и серверный рендеринг не используются. Сервер приложений и база данных также не нужны.

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

Показывается только реальная принятая конфигурация `repo-policy.json`:

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

Отсутствующие возможности не изображаются как искусственный демонстрационный набор.

### 8.3 Каноническая архитектура

Из метрик и реестров выводятся:

```text
FactRef sources
FactRef model count
runtime constraint kinds
relation descriptor kinds
public relation kinds
semantic edit-site metrics
physical src/schema/tests/docs/examples metrics
```

Нужно явно различать два слоя:

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

### 8.4 Понижение конфигурации

Основной живой пример:

```text
accepted repo-policy.json
  -> compileConstraintProgram
  -> canonical entries
```

Если собственная политика не использует высокоуровневый пакет, сайт прямо сообщает об отсутствии активного пакета. Искусственный пример создавать не нужно.

### 8.5 Намерение, управление и доказательства

Человеческое представление объясняет:

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

Пояснительная схема может быть написана вручную. Активные перечни правил и ограничений должны выводиться машинно.

### 8.6 Схема CI

`.github/workflows/ci.yml` читается общим разборщиком `YAML`.

Показываются:

```text
workflow name
trigger classes
job ids
step names where useful
```

Отдельно показывается принятое событие `workflow_run` с точным `SHA`, ссылкой запуска и успешным результатом.

### 8.7 Сжатие архитектуры

Показываются базовое состояние C3.0, текущее принятое состояние и разница между ними. Источник — существующий вывод метрик сжатия.

### 8.8 Сценарии

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

Ссылки формируются из идентичности репозитория и принятого `SHA`. Ссылки на исходники по возможности указывают на неизменяемый коммит, а не на `main`.

## 9. Публикация

Новый процесс страниц не создаёт третий полный цикл проверки.

Триггер:

```text
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]
```

Сборка разрешена только при:

```text
workflow_run.conclusion == success
```

Исходники берутся по:

```text
ref = workflow_run.head_sha
```

### 9.1 Проверки свежести

До сбора:

```text
git rev-parse HEAD == workflow_run.head_sha
```

Перед загрузкой и повторно непосредственно перед публикацией:

```text
remote refs/heads/main == workflow_run.head_sha
```

Если ветка `main` уже ушла вперёд, кандидат не публикуется. Ошибка должна быть видна в процессе.

Старый сайт остаётся доступен и продолжает честно показывать свой точный `SHA` до публикации нового принятого состояния.

### 9.2 Конкурентность

```text
group = pages
cancel-in-progress = true
```

Более новая принятая сборка отменяет старую незавершённую. Проверки свежести всё равно обязательны.

### 9.3 Предусловие `GitHub Pages`

Перед первой публикацией источник страниц в настройках репозитория должен быть установлен в `GitHub Actions`.

Это одноразовая административная настройка, а не возможность обсерватории.

C3.6 не вводит постоянный привилегированный токен ради её автоматизации. Если доступный контур не умеет безопасно изменить настройку, она выполняется отдельным явно зафиксированным административным действием.

## 10. Разрешения

Задание сборки:

```text
contents: read
pages: read
```

Остальные разрешения задания сборки равны `none`. В частности, оно не получает изменение содержимого, задач, запросов на слияние или действий, а также административное чтение.

Отдельное задание публикации:

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

Вышестоящий CI уже доказал точный принятый коммит. Поэтому сборка страниц не запускает повторно:

```text
npm test
repo-guard validate
repo-guard check-pr
smoke-pack
all scenario executions
npm run check:dist
```

Для сборщика достаточно принятого сгенерированного исполнения и рабочих зависимостей:

```text
npm ci --omit=dev
```

Специфичная работа:

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

Первый реализационный коммит C3.6 должен быть только тестовым красным фальсификатором.

### 12.1 Источник истины

Проверяется:

```text
accepted SHA is required and valid
wrong checked-out SHA fails
scenario catalog is discovered generically
architecture inventory reuses existing metrics
self-policy lowering comes from production compiler
```

### 12.2 Детерминизм

Для одинакового нормализованного набора входов:

```text
snapshot bytes identical
rendered site bytes identical
```

### 12.3 Устаревание

```text
accepted_sha != checked_out_sha -> fail
accepted_sha != current remote main -> no deploy
CI conclusion != success -> no build/deploy
```

### 12.4 Граница только для чтения

Проверяется отсутствие:

```text
repository write API
issue write API
PR write API
workflow dispatch
merge mutation
policy mutation endpoint
```

### 12.5 Каталог сценариев

Все пять принятых сценариев C3.5 появляются автоматически. Будущий корректный манифест добавляется в представление без новой семантической диспетчеризации.

## 13. Минимальная поверхность реализации

Предпочтительно:

```text
scripts/observatory/collect.mjs
scripts/observatory/render.mjs
tests/test-c3-6-observatory.mjs
.github/workflows/pages.yml
```

Допустим небольшой каталог `scripts/observatory/assets/**` только для ресурсов представления.

Сгенерированные `_site/**` и `observatory.snapshot.json` не коммитятся.

README получает короткую ссылку на сайт только после фактического появления страниц.

## 14. Отклонённые варианты

### 14.1 Коммитить дерево страниц

```text
accepted data -> generator -> committed pages/**
```

Отклонено из-за шума сгенерированного дерева, новой поверхности совместных изменений и смешения источника истины с проекцией.

### 14.2 Читать `GitHub` из браузера

```text
browser -> GitHub API/raw main -> reconstruct state
```

Отклонено из-за сетевой зависимости во время просмотра, гонок между чтениями и невозможности получить единый воспроизводимый артефакт точного `SHA`.

### 14.3 Новая публичная команда

Не добавлять новую команду для страниц. Обсерватория является проекцией разработки и документации, а не потребительской исполняемой возможностью.

## 15. Модель отказа

Кандидат не публикуется, если:

```text
accepted SHA missing or malformed
checkout SHA differs
upstream CI is not success
compression analysis fails
production policy compilation fails
scenario manifest invalid
GitHub release observation fails
snapshot validation fails
renderer fails
remote main advanced
Pages upload or deploy fails
```

Неизвестное состояние нельзя заменять ложным успехом или ложным отсутствием.

## 16. Определение готовности C3.6

C3.6 закрывается только когда:

- русскоязычный статический сайт опубликован;
- сайт явно связан с точным принятым `SHA` ветки `main`;
- публикация возможна только после успешного CI на том же коммите;
- устаревший кандидат не может молча опубликоваться;
- собственная политика выводится из принятых данных репозитория;
- пониженные ограничения выводятся рабочим компилятором;
- архитектурное представление выводится существующими метриками и реестрами;
- каталог сценариев выводится только из `examples/scenarios/**`;
- версия пакета и опубликованный выпуск различаются честно;
- объявленная схема CI и доказательство принятия показаны раздельно;
- административное разрешение защиты ветки не добавлено;
- сайт не имеет поверхности изменения репозитория или управляющего контура;
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
v3.0.0 tag or release
npm publication redesign
C3.8 CI minute optimization
branch-protection Administration API
interactive policy editor
GovernanceGrant UI
workflow dispatch UI
repository mutation from site
analytics or search backend
```

## 18. Следующий шаг после принятия спецификации

После проверки и явного принятия этой спецификации:

```text
write implementation plan
        ↓
RED-first implementation in bounded slices
```

До отдельного одобрения спецификации реализация не начинается.
