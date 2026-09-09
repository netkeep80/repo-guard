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

## 2. Архитектурные инварианты

C3.6 обязана сохранить:

```text
canonical FactRef models = 1
canonical FactRef sources = 4
runtime constraint kinds = 1
runtime constraint kind = primitive_relation
relation descriptor count = 10
primitive descriptor registries = 1
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
NO C3.7 version/release cutover
NO v3.0.0 release
NO C3.8 CI redesign
NO committed generated HTML tree as authority
NO branch-protection administration token in Pages build
```

## 3. Что именно является authority

### 3.1 Commit-bound facts

Факты этой группы определяются exact accepted commit и воспроизводимы только из Git tree:

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

Для них provenance:

```text
origin = accepted_commit
sha = <exact accepted SHA>
```

### 3.2 Accepted CI evidence

Pages запускается только после успешного post-merge workflow `CI` на `main`.

Из `workflow_run` допускается использовать только наблюдаемую acceptance metadata:

```text
workflow name
run id
run URL
head SHA
conclusion
```

Это не новый semantic source. Это доказательство того, что exact commit уже прошёл существующий acceptance pipeline.

### 3.3 Bounded GitHub observations

Допустимы только публичные/read-only наблюдения, не требующие расширения privileged trust boundary. В C3.6 достаточно:

```text
GitHub release list / matching release state
Pages deployment URL returned by deployment action
workflow_run acceptance metadata
```

Live branch-protection configuration сознательно **не входит** в обязательный machine input C3.6: endpoint чтения branch protection требует отдельного Administration(read) permission. Pages build не должен получать такой privileged token только ради визуализации.

Вместо этого Observatory показывает два различённых понятия:

```text
declared CI wiring
  <- .github/workflows/ci.yml at accepted SHA

accepted CI evidence
  <- successful workflow_run for the same SHA
```

Если в будущем потребуется live branch-protection observation, это отдельное изменение trust/permission surface и не должно быть спрятано внутри C3.6.

## 4. Existing sources, которые C3.6 переиспользует

### 4.1 `scripts/compression-metrics.mjs`

Это основной machine-readable architecture inventory. Он уже выводит, среди прочего:

```text
physical metrics
registered rule-family metrics
canonical FactRef sources
FactRef model count
relation descriptor kinds
public relation descriptor kinds
runtime constraint kinds
semantic edit-site metrics
self-policy metrics
CI structural metrics
```

C3.6 не должна переписывать эту логику в новый collector.

Collector вызывает существующий script для exact accepted SHA и canonical C3.0 baseline:

```text
92432809fcddc290080beb51ba151e13a5761869
```

Концептуально:

```text
node scripts/compression-metrics.mjs \
  --ref <accepted_sha> \
  --compare 92432809fcddc290080beb51ba151e13a5761869
```

Результат включается в snapshot как immutable analysis input.

### 4.2 Production Constraint Program compiler

Self-policy topology и lowered result не реконструируются вручную.

Collector использует принятый production compiler из generated runtime:

```text
repo-policy.json
        ↓
compileConstraintProgram(...)
        ↓
canonical Constraint Program entries
```

Pages может визуализировать:

```text
high-level configuration
runtime primitive_relation entries
strictness-only entries
relation ids / primitive ids
FactRef operands
execution phase
advisory metadata
```

Renderer не интерпретирует эти entries; он только отображает уже скомпилированный результат.

### 4.3 C3.5 executable scenario corpus

Единственный scenario source:

```text
examples/scenarios/*/scenario.json
```

Discovery generic:

```text
directory contains scenario.json
        ↓
read manifest
        ↓
render id/title_ru/summary_ru/command/cases
```

Нельзя создавать отдельный массив:

```text
SCENARIOS = [ ... ]
```

в Pages generator.

PASS/FAIL на Pages означает **описанные executable cases corpus**, а acceptance badge для exact SHA означает, что upstream main CI прошёл. Pages build не обязан повторно исполнять все 10 scenario cases.

### 4.4 `package.json` + GitHub Releases

Version view обязана различать:

```text
package version
published GitHub Release
future v3 release truth
```

До C3.7 текущий `package.json.version = 2.0.0` не должен визуально представляться как опубликованный v3 release.

Минимальная модель:

```text
package_version
matching_release_tag = v<package_version>
matching_github_release = present | absent
release_truth_status = published | package_only
```

C3.6 ничего не публикует и не меняет version state.

## 5. Observatory snapshot

`observatory.snapshot.json` является **generated intermediate artifact**, а не новой authority file.

Он генерируется в workflow workspace и не обязан коммититься в Git.

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
  "version": {
    "package_version": "2.0.0",
    "matching_release_tag": "v2.0.0",
    "matching_github_release": false,
    "release_truth_status": "package_only"
  },
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

Это не публичный стабильный API v3. В C3.6 schema существует только для deterministic build/testing и должна быть маленькой.

### Provenance

Каждый крупный раздел snapshot должен быть трассируем к source path или workflow event.

Минимум:

```text
accepted.sha
source path
source blob/commit identity where practical
origin kind: accepted_commit | accepted_ci | github_observation
```

Renderer должен показывать exact SHA постоянно в верхней части сайта.

## 6. Static renderer

Renderer принимает **только validated snapshot** и создаёт обычные статические файлы:

```text
_site/index.html
_site/assets/observatory.css
_site/assets/observatory.js   # optional, presentation only
```

Предпочтение:

```text
HTML + CSS
```

Небольшой JS допустим только для presentation UX:

```text
filter
collapse/expand
client-side navigation
```

JS не должен:

```text
fetch policy from GitHub
recompute semantics
call GitHub APIs
mutate repository
trigger Actions
```

Никаких React/Vue/Vite/SSR/backend/database.

## 7. Required views

### 7.1 Accepted state

Показывает:

```text
exact accepted SHA
upstream CI run
CI conclusion
package version
GitHub release status
```

### 7.2 Self-policy

Показывает read-only projection `repo-policy.json`:

```text
policy_format_version
repository_kind
enforcement
forbidden/canonical/governance/operational paths
diff budgets
size rules
content rules
cochange rules
document relations
```

Не надо отображать каждое schema field, отсутствующее в self-policy.

### 7.3 Canonical architecture

Из compression metrics / registries:

```text
FactRef source names
FactRef model count
runtime constraint kind names
relation descriptor kinds
public relation kinds
semantic edit-site metrics
physical source/schema/test/docs/examples metrics
```

Observatory должна различать:

```text
canonical constraint runtime
vs
transaction/trust/reporting rule families
```

Фраза «в repo-guard вообще только один evaluator» запрещена как неточная.

Правильная модель:

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

### 7.4 Lowering view

Основной пример — accepted self-policy:

```text
repo-policy.json
  -> compileConstraintProgram
  -> canonical entries
```

Если self-policy не использует конкретный high-level pack, Pages прямо сообщает:

```text
active high-level pack in self-policy: none
```

C3.6 не обязана придумывать искусственный pack demo только ради заполнения раздела.

### 7.5 ChangeIntent / governance / evidence topology

Статическая схема объясняет существующую accepted boundary:

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

Текст и topology могут быть hand-written explanatory prose, но **конкретные активные rule/constraint inventories** должны быть machine-derived.

### 7.6 CI wiring

Из `.github/workflows/ci.yml` generic YAML parse:

```text
workflow name
trigger classes
job ids
step names where useful
```

Из accepted `workflow_run`:

```text
exact SHA
run URL
success
```

Pages не заявляет, что branch protection live equals это wiring, если такой live fact не был получен.

### 7.7 Compression metrics

Показывает:

```text
C3.0 baseline
current accepted state
delta
```

Источник — существующий compression metrics output.

### 7.8 Executable scenarios

Ровно auto-discovered C3.5 corpus.

Для каждого:

```text
id
title_ru
summary_ru
production command
PASS/FAIL cases
expected diagnostic ids
```

Никакого отдельно поддерживаемого Pages catalog.

### 7.9 Canonical links

Ссылки формируются из repository identity + accepted SHA:

```text
README
docs
schemas
repo-policy.json
action.yml
source registries
scenario source
#370
#377
```

Source links должны по возможности быть immutable SHA links, а не `main`.

## 8. Deployment topology

C3.6 не должна создавать третий полный validation cycle.

Предпочтительный trigger:

```text
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]
```

Build разрешён только при:

```text
workflow_run.conclusion == success
```

Checkout:

```text
ref = workflow_run.head_sha
```

То есть сайт строится из того же commit, который прошёл post-merge CI.

### 8.1 Freshness gate

До generation:

```text
git rev-parse HEAD
== workflow_run.head_sha
```

Перед upload/deploy необходимо дополнительно проверить, что remote `refs/heads/main` всё ещё указывает на тот же SHA.

Если `main` уже ушёл вперёд:

```text
FAIL / SKIP DEPLOY OF STALE CANDIDATE
```

Старый site остаётся доступен с явно показанным exact SHA; более старый workflow не имеет права перезаписать его после появления нового main.

### 8.2 Concurrency

Pages workflow должен иметь один deployment concurrency group.

Цель:

```text
не допустить out-of-order publication
```

Конкретная cancellation policy выбирается так, чтобы older queued builds не могли опубликоваться после newer accepted main. Freshness gate остаётся обязательным независимо от concurrency behavior.

### 8.3 GitHub Pages publishing source

Перед первым deploy repository Pages source должен быть настроен на **GitHub Actions**.

Это одноразовая repository setting, а не capability самого Observatory.

C3.6 implementation не должна добавлять permanent privileged token только для автоматизации этой настройки. Если доступный automation surface не позволяет безопасно включить Pages, source включается отдельным явно recorded repository administration step.

## 9. Permissions

### Build / collect / render

Минимально:

```text
contents: read
pages: read    # только если требуется official Pages setup action
```

Если GitHub release observation использует GitHub API, он должен работать через read-only repository token.

Не выдавать build job:

```text
contents: write
issues: write
pull-requests: write
actions: write
administration: read/write
```

### Deploy

Только dedicated deployment job:

```text
pages: write
id-token: write
```

с environment:

```text
github-pages
```

Build artifact является единственным входом deploy job.

## 10. CI cost boundary

C3.6 переиспользует upstream CI acceptance и не запускает повторно:

```text
npm test
full repo validate
smoke-pack
repo-guard check-pr
all 10 scenario executions
```

Pages-specific build выполняет только то, что нужно для projection:

```text
checkout exact SHA
minimal dependency setup if needed
compression metrics projection
production compiler projection
manifest discovery
snapshot validation
static render
freshness gate
artifact upload
```

Полная optimization program остаётся C3.8.

## 11. Testing strategy

C3.6 требует RED-first falsifier до implementation.

Тесты должны доказать минимум:

### Source authority

```text
snapshot accepted SHA is explicit
wrong/missing accepted SHA fails
scenario list is discovered, not handwritten
architecture inventory comes from existing metrics/registries
self-policy lowering comes from production compiler
```

### Determinism

Для одинаковых inputs:

```text
snapshot bytes identical
rendered site bytes identical
```

Исключение: никакого wall-clock timestamp в generated content.

Если нужен generated time для workflow logs, он не входит в deterministic site artifact.

### Staleness

```text
accepted_sha != checked_out_sha -> fail
accepted_sha != current remote main -> no deploy
CI conclusion != success -> no build/deploy
```

### Read-only boundary

Focused test/static audit подтверждает отсутствие в Pages runtime:

```text
repository write API
issue write API
PR write API
workflow dispatch
merge mutation
policy mutation endpoint
```

### Corpus

Все пять текущих scenarios должны автоматически появляться без отдельного Pages list.

Добавление будущего valid `scenario.json` автоматически меняет catalog projection без изменения renderer semantic dispatch.

## 12. Implementation shape

Предпочтительный минимальный новый surface:

```text
scripts/observatory/collect.mjs
scripts/observatory/render.mjs
tests/test-c3-6-observatory.mjs
.github/workflows/pages.yml
```

Допустим один маленький presentation asset directory только если renderer не может удобно встроить CSS/JS:

```text
scripts/observatory/assets/**
```

Generated `_site/**` и `observatory.snapshot.json` не являются committed authority artifacts.

README получает только короткую ссылку на Observatory после фактического появления Pages.

## 13. Почему не выбран committed Pages tree

Вариант:

```text
accepted data -> generator -> committed pages/**
```

отклонён.

Причины:

- generated-tree churn;
- ещё одна cochange surface;
- риск смешения authority и projection;
- ненужный рост Git history;
- отдельный freshness mechanism для committed HTML.

## 14. Почему не выбран client-side GitHub reader

Вариант:

```text
browser -> GitHub API/raw main -> reconstruct state
```

отклонён.

Причины:

- runtime network становится частью страницы;
- `main` может измениться между запросами;
- труднее доказать exact-SHA consistency;
- browser начинает собирать semantic inventory;
- невозможно получить стабильный reproducible artifact.

## 15. Почему не нужен новый repo-guard CLI command

Observatory является development/documentation projection, а не consumer execution capability.

Не добавлять:

```text
repo-guard observatory
repo-guard pages
repo-guard inspect-policy-for-pages
```

Публичный registry остаётся:

```text
validate
check-diff
check-pr
init
doctor
```

Collector может импортировать production modules как implementation detail build tooling без расширения public CLI.

## 16. Failure model

C3.6 fail-closed относительно публикации.

Не публиковать сайт, если:

```text
accepted SHA missing or malformed
checkout SHA differs
upstream CI not success
compression analysis failed
production policy compilation failed
scenario manifest invalid
snapshot validation failed
renderer failed
remote main advanced before deploy
Pages artifact upload failed
```

GitHub release API failure не должен превращаться в ложное `no release`; он является build failure, потому что иначе version view вводит человека в заблуждение.

## 17. Definition of Done C3.6

C3.6 можно закрыть только когда доказано:

- static Russian-first Pages site опубликован;
- site связан с exact accepted main SHA;
- deploy происходит только после successful main CI exact SHA;
- stale candidate не может молча опубликоваться;
- self-policy view derived from canonical repository data;
- canonical constraint view derived from production compiler;
- architecture metrics derived from existing compression metrics/registries;
- scenario catalog auto-derived from `examples/scenarios/**`;
- package version и GitHub release state различаются честно;
- CI wiring и CI acceptance evidence показаны раздельно;
- никакого live branch-protection privilege не добавлено;
- никакого Pages write/control API нет;
- generated site deterministic для одинаковых inputs;
- Pages build tested;
- README ↔ Pages ↔ immutable canonical source links сходятся;
- runtime kinds / FactRef sources / relation descriptor counts не выросли;
- full self gates GREEN;
- Ready exact-head `Run PR policy check` GREEN;
- merge выполнен по exact accepted head;
- post-merge `validate` + `smoke-pack` GREEN.

## 18. Out of scope

```text
C3.7 versioning/release truth cutover
v3.0.0 tag/release
npm publication redesign
C3.8 CI minute optimization
new external consumer scenarios
branch-protection administration API
interactive policy editor
interactive GovernanceGrant UI
workflow dispatch UI
repository mutation from site
analytics backend
search backend
```

## 19. Следующий шаг после принятия design spec

После review и принятия этой спецификации:

```text
write implementation plan
        ↓
create bounded child implementation issues/slices if plan proves useful
        ↓
RED-first implementation
```

До отдельного одобрения design spec implementation не начинается.
