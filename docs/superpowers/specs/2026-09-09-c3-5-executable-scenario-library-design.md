# C3.5 — исполняемая библиотека сценариев

## Статус и цель

Родительская задача: `#376`.

Принятая база:

```text
main = a34e7f6ea4dd8de2efae35cfee04163bac8e7013
C3.4 = completed
open PR = none
```

Цель C3.5 — создать маленький канонический набор реальных способов применения `repo-guard`, который одновременно служит:

```text
исполняемым regression evidence
человеческими примерами
источником данных для будущего read-only Pages
```

Главный критерий:

```text
простота
универсальность
один источник истины
переиспользование рабочего интерфейса продукта
```

C3.5 не расширяет язык политики и не создаёт новый механизм исполнения.

Жёстко запрещено:

```text
NO new runtime kind
NO new FactRef source
NO new relation descriptor
NO scenario semantic engine
NO scenario policy DSL
NO test-only validator
NO workflow/integration DSL revival
NO parallel/control-plane revival
NO scenario-specific production code
```

## Каноническая форма

Корпус хранится как данные в:

```text
examples/scenarios/**
```

Каждый сценарий — минимальный синтетический `Git`-репозиторий, который запускается тем же публичным `repo-guard`, что и обычный потребитель.

Базовая форма:

```text
examples/scenarios/<scenario>/
  scenario.json
  base/
    repo-policy.json
    <минимальные исходные файлы>
  cases/
    <case>/
      head/
        <overlay поверх base>
```

Дополнительные входные файлы допускаются только когда они реально нужны выбранной команде:

```text
change-intent.json
pr-body.md
issue-body.md
provider.json
```

Они являются обычными входными артефактами, а не новым языком сценариев.

## Почему `base + head overlay`

Сценарий должен выглядеть как настоящий переход репозитория.

Исполнитель:

```text
копирует base/**
  ↓
создаёт временный Git repository
  ↓
commit BASE
  ↓
накладывает case/head/**
  ↓
commit HEAD
  ↓
запускает настоящий dist/repo-guard.mjs
```

Не вводятся:

```text
виртуальная файловая система в JSON
patch DSL
ручное описание git diff
второй evaluator
```

Если файл должен исчезнуть в `HEAD`, вариант может иметь один технический список удаляемых путей. Это только операция материализации файлов и не содержит семантики политики.

## `scenario.json`

`scenario.json` содержит только каталоговое описание и ожидаемый результат. Он не выражает правила политики.

Минимальная модель:

```json
{
  "id": "version-transition",
  "title_ru": "Переход версии",
  "summary_ru": "BASE -> HEAD должен увеличивать SemVer.",
  "command": "check-diff",
  "cases": [
    {
      "id": "pass",
      "title_ru": "Версия увеличена",
      "expected_exit_code": 0,
      "expected_diagnostics": []
    },
    {
      "id": "fail-downgrade",
      "title_ru": "Версия уменьшена",
      "expected_exit_code": 1,
      "expected_diagnostics": ["document-relation:release-revision"]
    }
  ]
}
```

Допустимые поля должны оставаться маленькими и инфраструктурными:

```text
id
title_ru
summary_ru
command
cases[].id
cases[].title_ru
cases[].expected_exit_code
cases[].expected_diagnostics
cases[].delete_paths          optional
cases[].change_intent         optional path
cases[].pr_body               optional path
cases[].issue_body            optional path
```

В описание нельзя добавлять условия, селекторы, отношения, выражения или специальные семантические переключатели.

## Один универсальный исполнитель

Исполнение корпуса принадлежит тестовой инфраструктуре, а не рабочему механизму продукта.

Начальная точка:

```text
tests/test-c3-5-scenario-library.mjs
```

Исполнитель обязан:

1. автоматически находить `examples/scenarios/*/scenario.json`;
2. проверять только техническую целостность описания;
3. материализовать временный репозиторий;
4. создавать реальные `BASE` и `HEAD` commits;
5. запускать настоящий `dist/repo-guard.mjs` через процессный интерфейс;
6. сравнивать код завершения и ограниченный набор стабильных идентификаторов диагностик;
7. не интерпретировать семантику политики самостоятельно.

Новый исполнитель не экспортируется как рабочий программный интерфейс и не добавляется в `src/**` или `dist/**`.

`tests/run.mjs` уже автоматически находит `test-*.mjs`, поэтому отдельное подключение не требуется.

## Исполнение `check-diff`

Обычные сценарии используют существующий публичный интерфейс:

```text
repo-guard check-diff
  --base <BASE>
  --head <HEAD>
  --change-intent <path>   optional
  --format json
```

Проверяется фактический `AnalysisReport` и код завершения, а не внутренние функции вычислителя.

## Исполнение `check-pr`

`governance-cutover` обязан проходить настоящий `check-pr`.

Исполнитель создаёт:

```text
synthetic GITHUB_EVENT_PATH
PR body fixture
linked issue body fixture
minimal fake gh provider only when trusted issue lookup is required
```

Подмена `gh` не решает семантику политики. Она только возвращает заранее заданные входные данные тому же рабочему коду, который в реальном CI обращается к GitHub.

Это соответствует уже существующему способу проверки `check-pr` и не требует нового механизма поставщиков данных.

## Начальный корпус

После C3.3 остаются пять архитектурно разных классов, которые действительно стоит показывать.

### 1. `minimal-diff-policy`

Показывает минимальную обычную политику:

```text
allowed/forbidden repository paths
global diff budget
blocking PASS/FAIL
```

Один положительный и один минимальный отрицательный вариант.

### 2. `surgical-change`

Показывает `ChangeIntent` как точное ограничение транзакции:

```text
scope
must_touch
must_not_touch
budgets
```

Он не дублирует `minimal-diff-policy`: ключевая идея здесь — заявленная транзакция, а не глобальная политика.

### 3. `version-transition`

Показывает обычное отношение между снимками:

```text
BASE plain text
HEAD plain text
scalar_strictly_greater
comparator = semver
```

Минимум:

```text
PASS: 1.2.3 -> 1.2.4
FAIL: 1.2.3 -> 1.2.2
```

### 4. `contract-evidence`

Показывает, что топология договора и соответствия является только входными данными и чистым макроразворачиванием в обычные канонические отношения.

Сценарий должен доказать минимум:

```text
contract id cross-link
accepted state
required executable path exists
```

Отрицательный вариант ломает одну связь или удаляет требуемое свидетельство.

Предметного знания `anum_docs` в исполнителе или ядре не появляется.

### 5. `governance-cutover`

Показывает доверенную границу изменения управляющей политики:

```text
trusted BASE policy
ChangeIntent
linked issue GovernanceGrant
policy delta authorization
proposed HEAD as additional veto
```

Минимум:

```text
PASS: разрешённое точное governance изменение
FAIL: то же изменение без нужного grant
```

## Что не входит в корпус

Не создаются:

```text
workflow-evidence
parallel-readiness
```

C3.3 удалил семантический механизм `integration/workflow-path` и параллельный управляющий механизм. Сценарии не должны превращаться в музей удалённой архитектуры или становиться причиной её возврата.

Реальное подключение `GitHub Actions` самого `repo-guard` уже доказывается самоприменением C3.4, а не отдельным языком политики.

## Один источник данных

`examples/scenarios/**` — единственный источник содержимого сценариев.

Его используют три потребителя:

```text
CI/tests
README/human navigation
будущий C3.6 Pages catalog
```

`README` не копирует большие политики и наборы файлов. Он объясняет назначение библиотеки и ссылается на канонические каталоги.

C3.6 обязан читать тот же корпус, а не создавать отдельный файл описания сайта.

## Русские пояснения

Поля:

```text
title_ru
summary_ru
cases[].title_ru
```

обязательны и являются каноническим человеческим объяснением сценария.

Они должны быть короткими. Подробное руководство не переносится в `scenario.json`.

## Деление на срезы

C3.5 реализуется последовательно, чтобы каждый PR оставался маленьким и самодостаточным.

### C3.5a — форма, исполнитель и минимальный сценарий

Добавить:

```text
generic runner
minimal-diff-policy
manifest convention tests
короткую документацию convention
```

Цель — доказать форму корпуса на одном простейшем рабочем сценарии.

### C3.5b — точная транзакция и версия

Добавить только:

```text
surgical-change
version-transition
```

Исполнитель не меняется, кроме исправления доказанного общего дефекта.

### C3.5c — договор и свидетельства

Добавить:

```text
contract-evidence
```

Если для него требуется новый семантический механизм ядра — STOP. Это означает отдельный архитектурный разрыв, а не разрешение автоматически расширить C3.5.

### C3.5d — управление и сведение

Добавить:

```text
governance-cutover
README link/catalog convergence
final corpus audit
```

После этого #376 закрывается только при выполнении полной приёмки.

## RED-first

Каждый срез начинается с опровергающей проверки.

C3.5a сначала доказывает отсутствие канонической библиотеки и исполнителя на принятой базе.

C3.5b–d сначала доказывают отсутствие нового архитектурного сценария в корпусе, не ломая уже принятые сценарии.

Запрещено создавать тест, который повторяет семантику политики вместо запуска рабочего CLI.

## Инварианты простоты

На всём C3.5 сохраняются:

```text
runtime kinds = 1
FactRef sources = 4
relation descriptors = 10
canonical evaluator = 1
scenario production concepts = 0
```

Нормальная реализация C3.5 преимущественно добавляет данные и один универсальный тестовый исполнитель.

Если появляется необходимость менять:

```text
src/**
dist/**
schemas/repo-policy.schema.json
action.yml
.github/workflows/**
```

работа останавливается, а обнаруженный разрыв сначала классифицируется отдельно.

## Приёмка C3.5

C3.5 считается завершённой, когда:

```text
5 архитектурных сценариев присутствуют
каждый сценарий запускается production CLI
каждый имеет минимум один PASS case
каждый имеет bounded FAIL case, если он действительно учит инварианту
нет test-only semantic engine
нет второго DSL
manifest metadata достаточно для будущего Pages
README ссылается на corpus без ручного дублирования
старые ad-hoc examples либо остаются самостоятельными полезными артефактами, либо удаляются отдельным доказанным решением
все scenario tests GREEN
полный discovered suite GREEN
check:dist GREEN
self-policy GREEN
compression metrics GREEN
smoke-pack GREEN
Ready PR policy gate GREEN для каждого среза
post-merge gates GREEN
```

После приёмки C3.5 следующий нормативный этап — C3.6. C3.6 не начинается внутри C3.5 PR.
