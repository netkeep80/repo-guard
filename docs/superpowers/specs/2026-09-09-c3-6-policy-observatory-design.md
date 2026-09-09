# C3.6 — Russian read-only GitHub Pages Policy Observatory

Дата: 2026-09-09  
Roadmap: #370  
Parent phase: #377  
Accepted base before design: `48d1c3c981e1db070961d113fb35560ac7e02179`  
Dependency #376: CLOSED / completed

## 1. Решение

C3.6 создаёт русскоязычный статический GitHub Pages сайт как **чистую read-only проекцию принятого состояния `repo-guard`**.

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

Pages не является policy authority, semantic runtime, approval surface или control plane.

Главный архитектурный ответ C3.6:

```text
Can Pages be a pure projection of accepted repository facts,
without inventing any new semantic authority?

YES.
```

Если реализация потребует новый `FactRef` source, relation descriptor, runtime kind, policy DSL или отдельный evaluator, работа должна остановиться и такой gap должен быть классифицирован отдельно от C3.6.

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

## 3. Authority и provenance

### 3.1 Commit-bound facts

Эти факты определяются exact accepted commit и воспроизводятся из Git tree:

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

Provenance:

```text
origin = accepted_commit
sha = <exact accepted SHA>
```

### 3.2 Accepted CI evidence

Pages запускается только после успешного post-merge workflow `CI` на `main`.

Из `workflow_run` используется только acceptance metadata:

```text
workflow name
run id
run URL
head SHA
conclusion
```

Это доказательство приёмки exact commit существующим CI, а не новый semantic source.

### 3.3 Bounded GitHub observations

В C3.6 допускаются только read-only наблюдения без расширения privileged trust boundary:

```text
published GitHub Releases / matching release state
workflow_run acceptance metadata
Pages deployment URL from deploy action
```

Live branch-protection configuration сознательно **не входит** в machine input C3.6. Чтение branch protection требует отдельного `Administration(read)` permission; Observatory не получает такой token только ради визуализации.

Сайт различает:

```text
declared CI wiring
  <- .github/workflows/ci.yml at accepted SHA

accepted CI evidence
  <- successful workflow_run for the same SHA
```

Он не утверждает, что live branch protection равен отображаемому wiring, если такой факт не был получен.

## 4. Existing machine-readable sources

### 4.1 Architecture metrics

`scripts/compression-metrics.mjs` остаётся единственным существующим inventory для C3 architecture metrics. Collector не дублирует его анализ.

Он вызывается для:

```text
current = <accepted SHA>
baseline = 92432809fcddc290080beb51ba151e13a5761869
```

и даёт:

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

### 4.2 Production Constraint Program compiler

Self-policy topology и lowering строятся production compiler-ом из accepted generated runtime:

```text
repo-policy.json
        ↓
compileConstraintProgram(...)
        ↓
canonical Constraint Program entries
```

Pages отображает уже скомпилированные данные:

```text
runtime primitive_relation entries
strictness-only entries
relation ids
primitive ids
FactRef operands
execution phase
advisory metadata
```

Renderer не интерпретирует эти entries.

### 4.3 C3.5 executable scenarios

Единственный scenario source:

```text
examples/scenarios/*/scenario.json
```

Discovery generic: любой каталог с valid `scenario.json` автоматически входит в catalog.

Нельзя иметь отдельный Pages-массив scenario ids.

PASS/FAIL cards показывают executable cases и expected diagnostics из manifests. Badge принятого состояния означает, что upstream CI для exact SHA GREEN; Pages build **не повторяет** все scenario executions.

### 4.4 Package / release state

Version view различает:

```text
package version
matching published GitHub Release
future release truth
```

До C3.7 `package.json.version = 2.0.0` не представляется как опубликованный v3 release.

Нормализованная модель:

```text
package_version
matching_release_tag = v<package_version>
matching_published_release = present | absent
release_truth_status = published | package_only
```

API error не превращается в `absent`: collector завершается ошибкой, чтобы сайт не публиковал ложный release state.

## 5. Generated snapshot

`observatory.snapshot.json` — internal generated artifact build-а, не authority file и не public v3 API. В Git он не коммитится.

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

Каждый крупный раздел несёт provenance:

```text
origin = accepted_commit | accepted_ci | github_observation
source path/event
accepted SHA
```

Exact SHA постоянно виден в верхней части сайта.

## 6. Determinism boundary

Determinism определяется не только Git commit, потому что release state является bounded GitHub observation.

Правильный invariant:

```text
same accepted commit-bound inputs
+ same normalized GitHub observation payload
+ same accepted CI metadata
        ↓
byte-identical snapshot
+ byte-identical rendered site
```

Collector обязан нормализовать и стабильно сортировать GitHub observation data до snapshot.

Wall-clock timestamps, random ids и environment-specific absolute paths не входят в generated content.

## 7. Static renderer

Renderer принимает только validated snapshot и создаёт:

```text
_site/index.html
_site/assets/observatory.css
```

Допустим один маленький `_site/assets/observatory.js` только для presentation UX:

```text
filter
collapse/expand
client-side navigation
```

Client JS не может:

```text
fetch policy from GitHub
call GitHub APIs
recompute semantics
mutate repository
trigger Actions
```

Никаких React, Vue, Vite, SSR, backend или database.

## 8. Required views

### 8.1 Accepted state

```text
exact accepted SHA
upstream CI run URL
CI conclusion
package version
matching GitHub release status
```

### 8.2 Self-policy

Read-only projection реального `repo-policy.json`:

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

Не отображать отсутствующие self-policy fields только ради showcase.

### 8.3 Canonical architecture

Из compression metrics / registries:

```text
FactRef sources
FactRef model count
runtime constraint kinds
relation descriptor kinds
public relation kinds
semantic edit-site metrics
physical src/schema/tests/docs/examples metrics
```

Observatory обязана различать:

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

Фраза «в repo-guard вообще только один evaluator» запрещена как неточная.

### 8.4 Lowering

Основной live пример:

```text
accepted repo-policy.json
  -> compileConstraintProgram
  -> canonical entries
```

Если self-policy не использует high-level pack, сайт честно показывает:

```text
active high-level pack in self-policy: none
```

C3.6 не создаёт искусственный pack demo.

### 8.5 ChangeIntent / governance / evidence topology

Human explanation:

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

Пояснительная topology может быть hand-written prose/HTML, но конкретные inventories должны быть machine-derived.

### 8.6 CI wiring

`.github/workflows/ci.yml` читается generic YAML parser-ом; отображаются:

```text
workflow name
trigger classes
job ids
step names where useful
```

Accepted `workflow_run` отдельно даёт exact SHA + run URL + success.

### 8.7 Compression metrics

```text
C3.0 baseline
current accepted state
delta
```

Источник — existing compression metrics output.

### 8.8 Executable scenarios

Для каждого auto-discovered scenario:

```text
id
title_ru
summary_ru
production command
PASS/FAIL case titles
expected diagnostic ids
```

### 8.9 Canonical links

Links строятся из repository identity + accepted SHA. Source links по возможности immutable SHA links, не `main`.

## 9. Deployment topology

C3.6 не создаёт третий full validation cycle.

Workflow trigger:

```text
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]
```

Build/deploy разрешены только если:

```text
workflow_run.conclusion == success
```

Checkout выполняется по:

```text
ref = workflow_run.head_sha
```

### 9.1 Freshness gates

До collection:

```text
git rev-parse HEAD == workflow_run.head_sha
```

Перед upload и повторно непосредственно перед deploy:

```text
remote refs/heads/main == workflow_run.head_sha
```

Если `main` ушёл вперёд:

```text
NO DEPLOY OF STALE CANDIDATE
```

Ошибка должна быть видна в workflow; старый опубликованный сайт остаётся с собственным явно указанным exact SHA.

### 9.2 Concurrency

Один concurrency group:

```text
group = pages
cancel-in-progress = true
```

Это сознательно выбирается в пользу freshness: более новый accepted Pages build отменяет старый ещё исполняющийся build/deploy. Freshness gates остаются обязательными и не заменяются concurrency.

### 9.3 Pages source precondition

Перед первым deployment repository Pages publishing source должен быть настроен на **GitHub Actions**.

Это одноразовая repository administration setting, не Observatory capability.

C3.6 не вводит permanent privileged token для её автоматизации. Если доступный automation surface не умеет безопасно изменить эту setting, enablement выполняется как отдельный явно recorded administration step.

## 10. Permissions

### Build / collect / render

Точный permission set:

```text
contents: read
pages: read
```

Другие permissions у build job = none.

Build job не получает:

```text
contents: write
issues: write
pull-requests: write
actions: write
administration: read/write
id-token: write
```

### Deploy

Dedicated deploy job:

```text
pages: write
id-token: write
```

Environment:

```text
github-pages
```

Deploy job не получает repository mutation permissions.

## 11. CI cost boundary

Upstream CI уже доказал exact accepted SHA, поэтому Pages build не запускает повторно:

```text
npm test
repo-guard validate
repo-guard check-pr
smoke-pack
all 10 scenario executions
npm run check:dist
```

Для collector нужен только accepted generated runtime и production dependencies:

```text
npm ci --omit=dev
```

Pages-specific работа:

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

Общая optimization program остаётся C3.8.

## 12. Testing strategy

Первый implementation commit C3.6 — test-only RED falsifier.

Минимальные доказательства:

### Authority

```text
accepted SHA обязателен и валиден
wrong checked-out SHA fails
scenario catalog discovered generically
architecture inventory reuses existing metrics
self-policy lowering comes from production compiler
```

### Determinism

Для одинакового нормализованного input bundle:

```text
snapshot bytes identical
rendered site bytes identical
```

### Staleness

```text
accepted_sha != checked_out_sha -> fail
accepted_sha != current remote main -> no deploy
CI conclusion != success -> no build/deploy
```

### Read-only boundary

Static/focused test подтверждает отсутствие:

```text
repository write API
issue write API
PR write API
workflow dispatch
merge mutation
policy mutation endpoint
```

### Corpus

Все пять accepted C3.5 scenarios появляются автоматически. Добавление будущего valid scenario manifest не требует изменения renderer semantic dispatch.

## 13. Minimal implementation surface

Предпочтительно:

```text
scripts/observatory/collect.mjs
scripts/observatory/render.mjs
tests/test-c3-6-observatory.mjs
.github/workflows/pages.yml
```

Допустим маленький `scripts/observatory/assets/**` только для presentation assets.

Generated `_site/**` и `observatory.snapshot.json` не коммитятся.

README получает короткую ссылку на Observatory только после фактического появления Pages.

## 14. Rejected alternatives

### Committed Pages tree

```text
accepted data -> generator -> committed pages/**
```

Отклонён из-за generated-tree churn, новой cochange surface и смешения authority/projection.

### Client-side GitHub reader

```text
browser -> GitHub API/raw main -> reconstruct state
```

Отклонён из-за runtime network dependency, race между GitHub reads и невозможности получить один reproducible exact-SHA artifact.

### New public CLI command

Не добавлять `repo-guard observatory/pages/inspect-for-pages`: Observatory — development/documentation projection, не consumer execution capability.

## 15. Failure model

Не публиковать candidate site, если:

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

Никакой fallback не имеет права подменять неизвестное состояние ложным PASS/absence.

## 16. Definition of Done C3.6

C3.6 закрывается только когда:

- Russian-first static Pages site опубликован;
- site явно связан с exact accepted main SHA;
- deploy возможен только после successful `CI` на том же SHA;
- stale candidate не может молча опубликоваться;
- self-policy view derived from accepted repository data;
- lowered constraint view derived from production compiler;
- architecture view derived from existing compression metrics/registries;
- scenario catalog derived только из `examples/scenarios/**`;
- package version и published GitHub Release различаются честно;
- declared CI wiring и accepted CI evidence показаны раздельно;
- branch-protection admin permission не добавлен;
- Pages не имеет repository/control-plane mutation surface;
- deterministic tests GREEN;
- README ↔ Pages ↔ immutable source links сходятся;
- runtime kinds / FactRef sources / relation descriptors не выросли;
- full self gates GREEN;
- Ready exact-head `Run PR policy check` GREEN;
- merge выполнен по exact accepted head;
- post-merge `validate` + `smoke-pack` GREEN.

## 17. Out of scope

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

## 18. Следующий шаг после принятия design spec

После review и явного принятия этой спецификации:

```text
write implementation plan
        ↓
RED-first implementation in bounded slices
```

До отдельного одобрения design spec implementation не начинается.
