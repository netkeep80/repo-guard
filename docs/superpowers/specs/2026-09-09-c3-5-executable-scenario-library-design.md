# C3.5 — исполняемая библиотека сценариев

## Статус и границы

Родительская задача: `#376`.

Принятая база дизайна:

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

Приоритет дизайна:

```text
простота
универсальность
один источник истины
переиспользование production boundary
```

C3.5 не расширяет язык политики и не создаёт новый runtime.

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

## Архитектурное решение

Канонический корпус хранится как данные в:

```text
examples/scenarios/**
```

Каждый сценарий — минимальный синтетический Git-репозиторий, который запускается тем же публичным `repo-guard`, что и обычный потребитель.

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

Дополнительные файлы допускаются только когда они нужны выбранной production-команде:

```text
change-intent.json
pr-body.md
issue-body.md
provider.json
```

Они являются обычными входными артефактами, а не новым языком сценариев.

## Почему `base + head overlay`

Сценарий должен выглядеть как настоящий repository transition.

Runner:

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

Если файл должен исчезнуть в `HEAD`, runner может поддержать один технический список удаляемых путей в metadata case. Это только операция materialization и не имеет policy semantics.

## `scenario.json`

`scenario.json` — каталоговое и ожидаемое описание. Он не выражает правила политики.

Минимальная логическая модель:

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

Нельзя добавлять в manifest условия, селекторы, отношения, выражения или специальные semantic switches.

## Один generic runner

Исполнение корпуса принадлежит тестовой инфраструктуре, а не product runtime.

Начальная точка:

```text
tests/test-c3-5-scenario-library.mjs
```

Runner обязан:

1. автоматически обнаруживать `examples/scenarios/*/scenario.json`;
2. валидировать только техническую целостность manifest;
3. материализовать временный repository;
4. создавать реальные `BASE` и `HEAD` commits;
5. запускать настоящий `dist/repo-guard.mjs` через процессный boundary;
6. сравнивать exit code и ограниченный набор стабильных diagnostic ids;
7. не интерпретировать семантику policy самостоятельно.

Новый runner не экспортируется как product API и не добавляется в `src/**` или `dist/**`.

`tests/run.mjs` уже автоматически обнаруживает `test-*.mjs`, поэтому отдельное wiring не требуется.

## Production boundary для `check-diff`

Обычные сценарии запускаются через существующий интерфейс:

```text
repo-guard check-diff
  --base <BASE>
  --head <HEAD>
  --change-intent <path>   optional
  --format json
```

Runner проверяет фактический `AnalysisReport`/exit code, а не внутренние функции evaluator.

## Production boundary для `check-pr`

`governance-cutover` обязан проходить настоящий `check-pr` boundary.

Runner создаёт:

```text
synthetic GITHUB_EVENT_PATH
PR body fixture
linked issue body fixture
minimal fake gh provider only when trusted issue lookup is required
```

Fake `gh` не решает policy semantics. Он только возвращает заранее заданный issue/authorizer input тому же production коду, который в реальном CI обращается к GitHub.

Это уже соответствует существующему способу проверки `check-pr` в тестах и не требует нового provider runtime.

## Начальный корпус

После C3.3 в продукте реально остаются пять архитектурно разных классов, которые стоит показывать.

### 1. `minimal-diff-policy`

Показывает минимальную обычную policy:

```text
allowed/forbidden repository paths
global diff budget
blocking PASS/FAIL
```

Один положительный и один минимальный отрицательный case.

### 2. `surgical-change`

Показывает `ChangeIntent` как точное ограничение изменения:

```text
scope
must_touch
must_not_touch
budgets
```

Не дублирует `minimal-diff-policy`: здесь ключевая идея — заявленная транзакция, а не глобальная policy.

### 3. `version-transition`

Показывает snapshot-aware generic relation:

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

Показывает, что contract/conformance topology является только frontend data/macro и исполняется через обычные canonical relations.

Сценарий должен доказать минимум:

```text
contract id cross-link
accepted state
required executable path exists
```

Отрицательный case ломает одну связь или удаляет требуемое evidence.

Не создаётся предметного знания `anum_docs` в runner или engine.

### 5. `governance-cutover`

Показывает доверенную границу изменения управляющей policy:

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

## Что сознательно не входит в corpus

Не создаются:

```text
workflow-evidence
parallel-readiness
```

C3.3 удалил integration/workflow-path semantic runtime и parallel/control-plane runtime. Сценарии не должны превращаться в музей удалённой архитектуры или причиной её возвращения.

Факт реального GitHub Actions wiring самого `repo-guard` уже доказывается self-hosting C3.4, а не отдельным policy DSL.

## Single-source invariant

`examples/scenarios/**` — единственный источник содержимого сценариев.

Он используется тремя потребителями:

```text
CI/tests
README/human navigation
будущий C3.6 Pages catalog
```

README не копирует большие policy/fixture примеры. Он объясняет назначение библиотеки и ссылается на канонические каталоги.

C3.6 обязан читать тот же corpus, а не создавать отдельный pages-manifest.

## Русский human metadata

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

### C3.5a — convention + runner + minimal scenario

Добавить:

```text
generic runner
minimal-diff-policy
manifest convention tests
короткую документацию convention
```

Цель: доказать саму форму корпуса на одном простейшем production scenario.

### C3.5b — surgical + version

Добавить только:

```text
surgical-change
version-transition
```

Никаких изменений runner, кроме исправления доказанного generic defect.

### C3.5c — contract evidence

Добавить:

```text
contract-evidence
```

Если для него требуется новый semantic engine concept — STOP. Такой результат означает architecture gap, а не разрешение расширить C3.5 автоматически.

### C3.5d — governance + convergence

Добавить:

```text
governance-cutover
README link/catalog convergence
final corpus audit
```

После этого закрыть #376 только при выполнении полной acceptance.

## RED-first для каждого среза

Каждый implementation slice начинается falsifier-ом.

C3.5a RED должен доказать отсутствие канонической библиотеки/runner на accepted base.

C3.5b–d RED должен доказывать отсутствие нового архитектурного scenario в corpus, не ломая уже принятые сценарии.

Запрещено создавать тест, который повторяет policy semantics вместо запуска production CLI.

## Инварианты простоты

На всём C3.5 сохраняются:

```text
runtime kinds = 1
FactRef sources = 4
relation descriptors = 10
canonical evaluator = 1
scenario production concepts = 0
```

Нормальная C3.5 реализация должна преимущественно добавлять данные и один generic test harness.

Если появляется необходимость менять:

```text
src/**
dist/**
schemas/repo-policy.schema.json
action.yml
.github/workflows/**
```

работа останавливается и gap сначала классифицируется отдельно.

## Acceptance C3.5

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

После acceptance C3.5 следующий нормативный этап — C3.6. C3.6 не начинается внутри C3.5 PR.
