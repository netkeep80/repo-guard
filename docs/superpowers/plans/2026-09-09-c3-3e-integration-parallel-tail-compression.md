# C3.3e — `Implementation Plan`

> **Для агентных исполнителей:** обязательный навык: `superpowers:subagent-driven-development` (предпочтительно) или `superpowers:executing-plans`. Выполнять план по задачам; шаги отслеживать флажками `- [ ]`.

```text
For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
```

**Goal:** Удалить недоказанный совместимый, параллельный и провайдерный продуктовый хвост, затем физически удалить последний специальный семантический путь `integration`, сохранив один исполняемый вид `primitive_relation`.

**Architecture:** Реализация идёт четырьмя последовательно принимаемыми срезами от каждого нового принятого `main`. Каждый срез начинается с отдельного красного архитектурного теста; удаляемая публичная возможность исчезает из исходников, сборки, схемы, командной строки, документации, примеров и самоприменения в одной границе приёмки.

**`Tech Stack`:** `Node.js 24`, `TypeScript 7`, исходники `.mts`, `AJV/JSON Schema`, `GitHub Actions`, `npm`, существующий `FactRef` и конечный реестр отношений.

**Spec:** `docs/superpowers/specs/2026-09-09-c3-3e-integration-parallel-tail-compression-design.md`

## Global Constraints

- Принятая исходная точка плана: `main = 27b53c2002ad9604660a5c33e6660b6e69e751fa`.
- Базовая точка измерений C3.0: `92432809fcddc290080beb51ba151e13a5761869`.
- Перед каждым рабочим срезом повторно читать фактический `main`; следующий срез создаётся только после принятия предыдущего.
- Один `FactRef` model; источники строго `change_intent`, `diff`, `document`, `repository`.
- Дескрипторов отношений остаётся `10`, если отдельный красный потребительский тест не докажет общий пробел.
- Нельзя добавлять второй исполнитель, второй `FactStore`, новый язык выражений, провайдерный примитив или `integration`-примитив.
- Нельзя сохранять псевдонимы совместимости, устаревшие команды, скрытый старый исполняемый путь или переходный двойной runtime после слияния.
- `dist/**` не редактируется вручную; он получается только `npm run build` и проверяется `npm run check:dist`.
- Изменение публичной возможности обязано в том же срезе обновить или удалить соответствующие тесты, документацию, примеры, схему, Action и шаблоны, если они её публикуют.
- Для управляющего смешанного среза нужен `change_type: governance`, доверенный `GovernanceGrant` и `allow_atomic_governance_cutover: true`.
- `allow_policy_relaxation` выдаётся только на конкретные доказанные указатели; корневой указатель `/` не разрешать.
- Каждый срез: test-only RED → минимальный GREEN → исторические тесты → полный suite → свежий `dist` → self-policy → метрики → Draft PR → Ready-state `validate` + `smoke-pack` + `Run PR policy check` → race-check → merge exact head → post-merge `validate` + `smoke-pack`.
- #411 остаётся открытой до E3d; #374 не закрывается автоматически при достижении одного runtime kind.

---

## Карта файлов и ответственности

### Каноническое ядро, которое должно остаться

- `src/document-facts.mts` — единственная модель `FactRef`; в C3.3e не расширяется.
- `src/checks/relation-kernel.mts` — единственный конечный реестр десяти отношений; в C3.3e не расширяется.
- `src/checks/constraint-program.mts:1-560` — компиляция высокоуровневой политики; в E3c теряет только структуры, strictness и runtime emission для `integration`.
- `src/checks/rules/constraints.mts:1-120` — канонический runtime evaluator; в E3c схлопывается до `primitive_relation`.
- `src/facts/input.mts:1-90` — приобретение фактов; в E3c перестаёт извлекать специальный `integration` fact.
- `src/repo-guard.mts:24-79` — публичный реестр команд; последовательно сжимается до пяти команд.
- `src/doctor.mts:1-330` — операционная диагностика; в E3c остаётся проверкой предпосылок и перестаёт интерпретировать workflow.

### E3a — слой жизненного цикла и миграции

Удаляются:

```text
src/agent-lifecycle.mts
src/status.mts
src/migrate.mts
src/migration-plan.mts
src/migration-apply.mts
dist/agent-lifecycle.mjs
dist/status.mjs
dist/migrate.mjs
dist/migration-plan.mjs
dist/migration-apply.mjs
docs/v2-migration.md
```

Обновляются:

```text
src/repo-guard.mts
tests/test-cli-runtime.mjs
tests/test-typescript-source-cutover.mjs
README.md
docs/self-hosting-coverage.md
docs/self-hosting-coverage.json
```

Удаляются исторические тесты, если поиск подтверждает, что они проверяют только удаляемую возможность:

```text
tests/test-agent-lifecycle.mjs
tests/test-status.mjs
tests/test-migrate.mjs
tests/test-migration-plan.mjs
tests/test-migrate-apply.mjs
tests/test-migrate-rollback.mjs
```

### E3b — параллельный, провайдерный и управляющий продукт

Удаляются:

```text
src/parallel-readiness.mts
src/parallel-doctor.mts
src/parallel-control-plane.mts
src/github-merge-group.mts
src/portable-integration/coordinator.mts
src/portable-integration/planner.mts
src/portable-integration/github-read.mts
src/portable-integration/github-write.mts
src/portable-integration/public-command.mts
src/portable-integration/trusted-command.mts
.github/workflows/repo-guard-portable-coordinator.yml
docs/parallel-migration.md
examples/github-merge-queue-workflow.yml
```

`src/github-control-plane.mts` удаляется в этом же срезе только после предписанного аудита достижимости: если `git grep` показывает вызовы исключительно из удаляемых параллельных модулей и их тестов. Если обнаружится вызов из сохраняемой команды, срез останавливается до фиксации этого факта в #411; копия или второй адаптер не создаётся.

Обновляются:

```text
src/repo-guard.mts:1-79
src/init.mts:16-76,115-187,218-280
action.yml
repo-policy.json
schemas/repo-policy.schema.json
.github/workflows/ci.yml
README.md
docs/self-hosting-coverage.md
docs/self-hosting-coverage.json
tests/test-cli-runtime.mjs
tests/test-typescript-source-cutover.mjs
tests/test-init.mjs
```

Удаляются тесты, доказавшие только старый продукт:

```text
tests/test-parallel-readiness.mjs
tests/test-parallel-doctor.mjs
tests/test-parallel-control-plane.mjs
tests/test-github-merge-group.mjs
tests/test-portable-coordinator-loop.mjs
tests/test-portable-github-read-adapter.mjs
tests/test-portable-github-write-adapter.mjs
tests/test-portable-integration-planner.mjs
tests/test-portable-public-command.mjs
tests/test-portable-trusted-command-recovery.mjs
tests/test-self-host-portable-wiring.mjs
tests/test-init-native.mjs
```

`tests/test-github-control-plane.mjs` удаляется вместе с `src/github-control-plane.mts` только при подтверждённой недостижимости из сохраняемого продукта.

### E3c — финальный семантический путь `integration`

Удаляются:

```text
src/integration-validator.mts
src/extractors/integration.mts
src/checks/integration-constraints.mts
dist/integration-validator.mjs
dist/extractors/integration.mjs
dist/checks/integration-constraints.mjs
examples/downstream-integration-policy.json
tests/fixtures/integration/**
```

Обновляются:

```text
src/repo-guard.mts:24-79
src/facts/input.mts:1-90
src/checks/constraint-program.mts:65-90,300-360,440-455,480-540
src/checks/rules/constraints.mts:1-120
src/policy-compiler.mts:1-25,105-155
src/doctor.mts:1-330
schemas/repo-policy.schema.json
repo-policy.json
.github/workflows/ci.yml
README.md
docs/self-hosting-coverage.md
docs/self-hosting-coverage.json
scripts/compression-metrics.mjs
tests/validate-schemas.mjs
tests/test-policy-compiler-boundary.mjs
tests/test-policy-delta-rules.mjs
tests/test-doctor.mjs
tests/test-self-hosting.mjs
tests/test-typescript-source-cutover.mjs
tests/test-compression-rules.mjs
```

Удаляются специализированные тесты:

```text
tests/test-integration-diagnostics.mjs
tests/test-integration-docs-strictness.mjs
tests/test-integration-extractors.mjs
tests/test-integration-fixtures.mjs
tests/test-integration-validator-boundary.mjs
```

### E3d — финальное измерение C3.3

Создаётся:

```text
docs/superpowers/reports/2026-09-09-c3-3e-final-audit.md
```

Обновляются только при доказанной необходимости:

```text
scripts/compression-metrics.mjs
tests/test-compression-rules.mjs
docs/architecture-compression-3-baseline.md
```

E3d не является местом для отложенного удаления старого кода. Если поиск находит живой старый продуктовый путь, E3d красный и возвращает работу в минимальный отдельный срез #411.

---

# I. E3a — удалить lifecycle и migration

### Задача 1: зафиксировать красный контракт удаления совместимости

**Files:**
- Create: `tests/test-c3-3e1-compatibility-surface-deletion.mjs`
- Modify later: `src/repo-guard.mts:24-79`
- Delete later: пять модулей lifecycle/migration и шесть специализированных тестов из карты выше.

**Interfaces:**
- Consumes: `COMMANDS` из `dist/repo-guard.mjs`, `relationDescriptors()` из `dist/checks/relation-kernel.mjs`, тип `FactSource` из `src/document-facts.mts`.
- Produces: принятый публичный CLI из восьми команд после E3a; runtime vocabulary всё ещё ровно `integration,primitive_relation`.

- [ ] **Step 1: открыть дочернюю задачу E3a в #411**

Тело задачи фиксирует только этот cut:

```text
C3.3e / E3a
DELETE agent lifecycle/status
DELETE v2 migration/rollback
KEEP parallel/provider/integration unchanged until later slices
expected runtime kinds = integration,primitive_relation
expected CLI = validate,check-diff,check-pr,check-merge-group,init,doctor,portable-coordinator,validate-integration
```

Управляющие файлы в E3a не меняются, поэтому `GovernanceGrant` не запрашивается.

- [ ] **Step 2: создать ветку от фактически принятого `main`**

```bash
git fetch origin main
git switch -c c3/411-e3a-compatibility-deletion origin/main
```

Перед первым коммитом:

```bash
git rev-parse HEAD
git status --short
```

Ожидание: `HEAD` равен свежему GitHub `main`, рабочее дерево пусто.

- [ ] **Step 3: написать красный архитектурный тест**

`tests/test-c3-3e1-compatibility-surface-deletion.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");

assert.deepEqual(COMMANDS, [
  "validate", "check-diff", "check-pr", "check-merge-group",
  "init", "doctor", "portable-coordinator", "validate-integration",
]);
for (const path of [
  "src/agent-lifecycle.mts", "src/status.mts", "src/migrate.mts",
  "src/migration-plan.mts", "src/migration-apply.mts",
  "docs/v2-migration.md",
]) assert.equal(existsSync(resolve(root, path)), false, `${path} must be deleted`);

const runtime = read("src/checks/rules/constraints.mts");
const kindBlock = runtime.match(/type RuntimeConstraintKind =([\s\S]*?);/);
const kinds = kindBlock ? [...kindBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() : [];
assert.deepEqual(kinds, ["integration", "primitive_relation"]);
assert.equal(relationDescriptors().length, 10);

const factSource = read("src/document-facts.mts").match(/export type FactSource = ([^;]+);/);
const sources = factSource ? [...factSource[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() : [];
assert.deepEqual(sources, ["change_intent", "diff", "document", "repository"]);
console.log("C3.3e E3a compatibility deletion contract passed.");
```

- [ ] **Step 4: доказать красное состояние**

```bash
npm run build
node tests/test-c3-3e1-compatibility-surface-deletion.mjs
```

Ожидание: FAIL на `COMMANDS` и/или существующих lifecycle/migration файлах; `runtime kinds`, дескрипторы и источники фактов уже зелёные.

- [ ] **Step 5: закоммитить только красный тест**

```bash
git add tests/test-c3-3e1-compatibility-surface-deletion.mjs
git commit -m "test(c3.3e1): falsify compatibility surface deletion"
```

В дочерней задаче записать exact SHA и точные красные assertions.

### Задача 2: минимально удалить lifecycle/migration product

**Files:**
- Modify: `src/repo-guard.mts:24-79`
- Delete: `src/agent-lifecycle.mts`, `src/status.mts`, `src/migrate.mts`, `src/migration-plan.mts`, `src/migration-apply.mts`
- Delete: соответствующие `dist/*.mjs` после сборки.

**Interfaces:**
- Produces: `COMMANDS = [validate,check-diff,check-pr,check-merge-group,init,doctor,portable-coordinator,validate-integration]`.
- Must preserve: `init --parallel`, provider modules и `integration` до E3b/E3c.

- [ ] **Step 1: удалить две команды из registry**

В `COMMAND_SPECS` удалить только:

```text
status
migrate
```

Не менять `check-merge-group`, `portable-coordinator`, `validate-integration`, параметры `doctor` и `init --parallel` в этом срезе.

- [ ] **Step 2: удалить пять source modules**

```bash
git rm src/agent-lifecycle.mts src/status.mts src/migrate.mts src/migration-plan.mts src/migration-apply.mts
```

- [ ] **Step 3: проверить остаточную достижимость**

```bash
git grep -n -I -E 'agent-lifecycle|runStatus|runMigrate|migration-plan|migration-apply|runMigration|legacy scaffold|parallel -> legacy' -- src tests README.md docs examples ':!dist/**'
```

Оставшиеся совпадения допускаются только в тестах/документации, которые удаляются или переписываются в следующей задаче E3a.

- [ ] **Step 4: собрать и проверить архитектурный тест**

```bash
npm run build
npm run check:dist
node tests/test-c3-3e1-compatibility-surface-deletion.mjs
```

Ожидание: архитектурный тест GREEN.

- [ ] **Step 5: закоммитить минимальный production cut**

```bash
git add src/repo-guard.mts src dist tests/test-c3-3e1-compatibility-surface-deletion.mjs
git commit -m "refactor(c3.3e1): delete lifecycle and migration product"
```

### Задача 3: удалить исторические тесты и документацию E3a

**Files:**
- Delete: шесть lifecycle/migration тестов из карты.
- Delete: `docs/v2-migration.md`.
- Modify: `tests/test-typescript-source-cutover.mjs`, `tests/test-cli-runtime.mjs`, `README.md`, `docs/self-hosting-coverage.md`, `docs/self-hosting-coverage.json`.

**Interfaces:**
- Tests no longer import any deleted module.
- Documentation presents no supported `status`, `migrate`, v2 migration or rollback path.

- [ ] **Step 1: удалить специализированные тесты**

```bash
git rm tests/test-agent-lifecycle.mjs tests/test-status.mjs tests/test-migrate.mjs tests/test-migration-plan.mjs tests/test-migrate-apply.mjs tests/test-migrate-rollback.mjs
```

Если один из файлов уже отсутствует на свежем `main`, не создавать замену; зафиксировать фактический список в дочерней задаче.

- [ ] **Step 2: обновить общий CLI inventory**

В `tests/test-typescript-source-cutover.mjs` заменить inventory на:

```js
assert.deepEqual(COMMANDS, [
  "validate", "check-diff", "check-pr", "check-merge-group",
  "init", "doctor", "portable-coordinator", "validate-integration",
]);
```

В `tests/test-cli-runtime.mjs` не удалять portable assertions до E3b; убрать только ссылки на `status`/`migrate`, если они есть на свежем `main`.

- [ ] **Step 3: удалить документацию v2 migration**

```bash
git rm docs/v2-migration.md
```

Из `README.md` и self-host coverage удалить только заявления о поддерживаемых `status`, `migrate`, rollback/v2 migration. Параллельный режим пока описывается как текущий historical surface до E3b.

- [ ] **Step 4: доказать отсутствие публичного migration vocabulary**

```bash
git grep -n -I -E '\bstatus\b|\bmigrate\b|migration-plan|migration-apply|legacy provider|parallel -> legacy|v2 migration|rollback' -- src tests README.md docs examples ':!docs/superpowers/**' ':!dist/**'
```

Разрешены только общеязыковые слова, не обозначающие удалённую команду/протокол. Любая product-ссылка на удалённую возможность должна быть устранена в этом срезе.

- [ ] **Step 5: полный локальный gate E3a**

```bash
npm run build
npm run check:dist
node tests/test-c3-3e1-compatibility-surface-deletion.mjs
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
node dist/repo-guard.mjs doctor --parallel portable
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

Ожидания:

```text
runtime kinds = 2
runtime kinds names = integration,primitive_relation
FactRef sources = 4
relation descriptors = 10
public CLI commands = 8
```

- [ ] **Step 6: закоммитить тестовую и документационную конвергенцию**

```bash
git add tests README.md docs dist
git commit -m "test(c3.3e1): converge after compatibility deletion"
```

### Задача 4: принять E3a через защищённый PR

- [ ] **Step 1: создать Draft PR с `change_type: refactor`**

`ChangeIntent.scope` перечисляет только реально изменённые `src/**`, `dist/**`, `tests/**`, `README.md`, `docs/**`. `must_touch` включает `src/repo-guard.mts` и новый архитектурный тест. Управляющие пути не затрагиваются.

- [ ] **Step 2: получить Draft GREEN**

Требуется `validate = SUCCESS`, `smoke-pack = SUCCESS`, полный discovered suite GREEN.

- [ ] **Step 3: перевести PR в Ready без изменения head**

Получить на одном exact head:

```text
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

- [ ] **Step 4: race-check и exact-head merge**

Проверить GitHub `main`, PR base, PR head и `mergeable=true`; слить только ожидаемый head SHA.

- [ ] **Step 5: подтвердить post-merge**

На новом exact `main` требуется:

```text
validate = SUCCESS
smoke-pack = SUCCESS
```

Только после этого начинать E3b.

---

# II. E3b — удалить parallel/provider/control-plane product

### Задача 5: доказать границы провайдерного cut и получить trusted grant

**Files:**
- Create: `tests/test-c3-3e2-provider-surface-deletion.mjs`
- Modify later: `repo-policy.json`, `schemas/repo-policy.schema.json`, `action.yml`, `.github/workflows/ci.yml`, `src/repo-guard.mts`, `src/init.mts`.
- Delete later: provider/control-plane modules, self portable workflow, provider docs/examples/tests.

**Interfaces:**
- Produces after E3b: CLI ровно `validate,check-diff,check-pr,init,doctor,validate-integration`.
- Produces: `repo-guard init` имеет один scaffold, без `--parallel`.
- Produces: Action имеет только режимы `check-pr` и `check-diff`.
- Preserves: `integration` DSL/runtime/validator до E3c.

- [ ] **Step 1: открыть дочернюю задачу E3b**

В issue зафиксировать exact cut и поместить доверенный grant:

```repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
  - schemas/repo-policy.schema.json
  - action.yml
  - .github/workflows/ci.yml
  - .github/workflows/repo-guard-portable-coordinator.yml
allow_policy_relaxation:
  - /integration/workflows/repo-guard-portable-coordinator
allow_atomic_governance_cutover: true
```

Этот единственный relaxation pointer соответствует удалению self-policy workflow `repo-guard-portable-coordinator`. Более широкий указатель не разрешать.

- [ ] **Step 2: создать ветку от принятого E3a `main`**

```bash
git fetch origin main
git switch -c c3/411-e3b-provider-deletion origin/main
```

- [ ] **Step 3: провести source reachability audit до красного теста**

```bash
git grep -n -I -E 'parallel-readiness|parallel-doctor|parallel-control-plane|github-control-plane|github-merge-group|portable-integration|portable-coordinator|github_merge_queue|repo_guard_merge_group_gate|repo_guard_portable_coordinator' -- src tests action.yml repo-policy.json schemas README.md docs examples .github ':!dist/**'
```

Отдельно:

```bash
git grep -n -I 'github-control-plane' -- src ':!src/github-control-plane.mts'
```

Если второй поиск показывает только удаляемые E3b modules, `src/github-control-plane.mts` включается в удаление. Если есть сохраняемый caller, не копировать helper и не продолжать production delete: записать caller в #411 как falsifier принятого предположения.

- [ ] **Step 4: написать красный архитектурный тест**

`tests/test-c3-3e2-provider-surface-deletion.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { computePolicyDelta } from "../dist/checks/rules/policy-delta-rules.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
const json = (path) => JSON.parse(read(path));

assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "init", "doctor", "validate-integration"]);
for (const path of [
  "src/parallel-readiness.mts", "src/parallel-doctor.mts", "src/parallel-control-plane.mts",
  "src/github-merge-group.mts", "src/portable-integration/public-command.mts",
  ".github/workflows/repo-guard-portable-coordinator.yml",
]) assert.equal(existsSync(resolve(root, path)), false, `${path} must be deleted`);

const action = read("action.yml");
for (const token of ["portable-coordinator", "ready-label", "merge-method", "transaction-checks", "state-checks"]) {
  assert.equal(action.includes(token), false, `Action must not expose ${token}`);
}
const init = read("src/init.mts");
for (const token of ["ParallelProvider", "--parallel", "parallelIntegration", "portableCoordinatorWorkflow", "nativeMergeGroupWorkflow"]) {
  assert.equal(init.includes(token), false, `init must not expose ${token}`);
}

const policy = json("repo-policy.json");
assert.equal(policy.integration.workflows.some((item) => item.id === "repo-guard-portable-coordinator"), false);
const baseLike = structuredClone(policy);
baseLike.integration.workflows.push({
  id: "repo-guard-portable-coordinator", kind: "github_actions",
  path: ".github/workflows/repo-guard-portable-coordinator.yml",
  role: "repo_guard_portable_coordinator",
  expect: { enforcement: "blocking" },
});
const delta = computePolicyDelta(baseLike, policy).relaxations.map((item) => item.pointer);
assert.deepEqual(delta, ["/integration/workflows/repo-guard-portable-coordinator"]);

const schema = json("schemas/repo-policy.schema.json");
const validate = new Ajv({ allErrors: true }).compile(schema);
const invalid = structuredClone(policy);
invalid.integration.workflows.push({ id: "old-provider", kind: "github_actions", path: "x.yml", role: "repo_guard_portable_coordinator", expect: {} });
assert.equal(validate(invalid), false);
console.log("C3.3e E3b provider deletion contract passed.");
```

- [ ] **Step 5: доказать RED**

```bash
npm run build
node tests/test-c3-3e2-provider-surface-deletion.mjs
```

Ожидание: FAIL на CLI/files/Action/init/provider role; тест exact relaxation pointer должен быть зелёным или быть скорректирован только по фактическому указателю accepted runtime. Корневой `/` не разрешается.

- [ ] **Step 6: закоммитить только красный тест**

```bash
git add tests/test-c3-3e2-provider-surface-deletion.mjs
git commit -m "test(c3.3e2): falsify provider surface deletion"
```

### Задача 6: удалить CLI, init и source provider surface

**Files:**
- Modify: `src/repo-guard.mts:1-79`, `src/init.mts:16-76,115-187,218-280`.
- Delete: provider modules из карты E3b.

- [ ] **Step 1: сжать `COMMAND_SPECS`**

Удалить:

```text
check-merge-group
portable-coordinator
doctor --parallel
doctor --persistent-branch
```

Удалить верхние импорты `runParallelDoctor` и `runPortableCoordinatorCommand`.

После изменения до E3c registry выглядит так:

```text
validate
check-diff
check-pr
init
doctor
validate-integration
```

`doctor --integration` пока остаётся до E3c.

- [ ] **Step 2: сделать `init` однопутным**

Удалить из `src/init.mts`:

```text
ParallelProvider
parallelIntegration
parallelTransactionWorkflow
portableCoordinatorWorkflow
nativeMergeGroupWorkflow
parallel argument from RenderInitScaffoldInput
--parallel parsing/help/output
parallel branch in buildPolicy/renderInitScaffold
```

`renderInitScaffold()` всегда создаёт ровно:

```text
repo-policy.json
.github/workflows/repo-guard.yml
.github/PULL_REQUEST_TEMPLATE.md
.github/ISSUE_TEMPLATE/change-intent.yml
```

Сгенерированный `repo-policy.json` не содержит `integration`.

- [ ] **Step 3: удалить provider source modules**

```bash
git rm src/parallel-readiness.mts src/parallel-doctor.mts src/parallel-control-plane.mts src/github-merge-group.mts
git rm -r src/portable-integration
```

Если аудит достижимости подтвердил отсутствие сохраняемого caller:

```bash
git rm src/github-control-plane.mts
```

- [ ] **Step 4: собрать и проверить focused RED→GREEN**

```bash
npm run build
npm run check:dist
node tests/test-c3-3e2-provider-surface-deletion.mjs
node tests/test-init.mjs
```

Ожидание: source/CLI/init assertions GREEN; governance assertions могут оставаться красными до следующей задачи.

- [ ] **Step 5: закоммитить source cut**

```bash
git add src dist tests/test-c3-3e2-provider-surface-deletion.mjs tests/test-init.mjs
git commit -m "refactor(c3.3e2): delete provider and parallel runtime"
```

### Задача 7: атомарно удалить provider governance/public wiring

**Files:**
- Modify: `action.yml`, `repo-policy.json`, `schemas/repo-policy.schema.json`, `.github/workflows/ci.yml`.
- Delete: `.github/workflows/repo-guard-portable-coordinator.yml`.

- [ ] **Step 1: удалить portable branch из Action**

В `action.yml` удалить inputs:

```text
repository
ready-label
merge-method
transaction-checks
state-checks
format
```

Удалить соответствующие `INPUT_*` env и весь shell branch `if [ "$INPUT_MODE" = "portable-coordinator" ]`. Оставить единый execution path для `check-pr`/`check-diff` и существующие inputs `mode`, `enforcement`, `repo-root`, `base`, `head`, `change-intent`, `node-version`.

- [ ] **Step 2: удалить self portable workflow и policy declaration**

```bash
git rm .github/workflows/repo-guard-portable-coordinator.yml
```

Из `repo-policy.json` удалить только workflow с id:

```text
repo-guard-portable-coordinator
```

Оставшийся `integration` раздел пока сохраняет PR-gate, templates, docs и profile до E3c.

- [ ] **Step 3: убрать provider-only schema vocabulary**

В `schemas/repo-policy.schema.json` удалить роли:

```text
repo_guard_merge_group_gate
repo_guard_portable_coordinator
```

Также удалить только те варианты `mode`/expectation, которые существуют исключительно для `check-merge-group`/`portable-coordinator`. Общий `integration` schema остаётся до E3c.

- [ ] **Step 4: удалить parallel readiness из self CI**

Из `.github/workflows/ci.yml` удалить step:

```text
Run portable readiness diagnostics on self
```

Оставить `validate-integration` до E3c.

- [ ] **Step 5: проверить точность policy relaxation**

```bash
npm run build
node tests/test-c3-3e2-provider-surface-deletion.mjs
```

Ожидание: единственный разрешаемый self-policy relaxation pointer:

```text
/integration/workflows/repo-guard-portable-coordinator
```

Если диагностика требует `/`, остановиться; не расширять grant.

- [ ] **Step 6: закоммитить governance cut**

```bash
git add action.yml repo-policy.json schemas/repo-policy.schema.json .github/workflows tests/test-c3-3e2-provider-surface-deletion.mjs
git commit -m "refactor(c3.3e2): cut provider governance surface"
```

### Задача 8: удалить provider tests/docs/examples и принять E3b

- [ ] **Step 1: удалить специализированные provider tests**

Удалить все существующие файлы из списка E3b в карте файлов; `tests/test-github-control-plane.mjs` удалять только вместе с подтверждённо недостижимым source module.

- [ ] **Step 2: обновить shared tests**

`tests/test-typescript-source-cutover.mjs`:

```js
assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "init", "doctor", "validate-integration"]);
```

Удалить assertions про privileged portable coordinator и заменить их assertions, что `action.yml` не содержит provider inputs и `portable-coordinator`.

`tests/test-cli-runtime.mjs` удалить import `runPortableCoordinatorCommand` и весь exact merge transport fixture; оставить grammar tests общих команд.

`tests/test-init.mjs` оставить только один scaffold path и immutable Action ref contract.

- [ ] **Step 3: удалить документацию и пример**

```bash
git rm docs/parallel-migration.md examples/github-merge-queue-workflow.yml
```

Из `README.md` и self-host coverage удалить текущие инструкции/claims для provider, parallel readiness, merge-group и portable coordinator.

- [ ] **Step 4: broad provider grep**

```bash
git grep -n -I -E 'portable-coordinator|portable coordinator|parallel-readiness|parallel-doctor|parallel-control-plane|github_merge_queue|repo_guard_merge_group_gate|repo_guard_portable_coordinator|check-merge-group|--parallel|--persistent-branch' -- src tests schemas action.yml repo-policy.json .github README.md docs examples templates ':!docs/superpowers/**' ':!dist/**'
```

Ожидание: ноль product matches. Исторические design/plan документы исключены намеренно.

- [ ] **Step 5: полный локальный gate E3b**

```bash
npm run build
npm run check:dist
node tests/test-c3-3e1-compatibility-surface-deletion.mjs
node tests/test-c3-3e2-provider-surface-deletion.mjs
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

Ожидания:

```text
runtime kinds = 2
runtime kinds names = integration,primitive_relation
FactRef sources = 4
relation descriptors = 10
public CLI commands = 6
portable/provider/migration/lifecycle product concepts = 0 outside historical docs
```

- [ ] **Step 6: commit convergence**

```bash
git add tests README.md docs examples dist
git commit -m "test(c3.3e2): converge after provider deletion"
```

- [ ] **Step 7: создать Draft PR с `change_type: governance`**

PR `ChangeIntent` включает только реальные changed paths. В linked issue уже находится trusted grant из Задачи 5. Поскольку diff смешивает governance и source/tests, `allow_atomic_governance_cutover: true` обязателен.

- [ ] **Step 8: ready-state и merge**

Получить exact-head:

```text
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

Проверить base/main/head/mergeable, слить exact head и подтвердить post-merge `validate + smoke-pack` на новом `main`.

---

# III. E3c — удалить `integration` DSL/extractor/evaluator

### Задача 9: зафиксировать финальный runtime RED и governance boundary

**Files:**
- Create: `tests/test-c3-3e3-integration-runtime-deletion.mjs`
- Modify later: canonical files E3c из карты.
- Delete later: integration source/dist/tests/fixtures/example.

**Interfaces:**
- Produces: `RuntimeConstraintKind = "primitive_relation"` only.
- Produces: `COMMANDS = [validate,check-diff,check-pr,init,doctor]`.
- Produces: policy schema rejects top-level `integration` by `additionalProperties: false`.
- Produces: `buildPolicyFacts()` has no `integration` property/extractor.
- Produces: `doctor` has no workflow text semantics.

- [ ] **Step 1: открыть дочернюю задачу E3c и доверить только реально изменяемые governance paths**

```repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
  - schemas/repo-policy.schema.json
  - .github/workflows/ci.yml
allow_atomic_governance_cutover: true
```

На старте не добавлять `allow_policy_relaxation`. Причина: E3c физически удаляет сам `integration` strictness/runtime из канонического компилятора; grant не должен превращаться в общий обход policy-delta.

Если до production-изменений accepted-base comparator используется для исследовательского отчёта, он может показать historical pointers или корневой incomparable `/`; это evidence старого механизма, а не основание разрешить `/`.

- [ ] **Step 2: создать ветку от принятого E3b `main`**

```bash
git fetch origin main
git switch -c c3/411-e3c-integration-deletion origin/main
```

- [ ] **Step 3: написать красный архитектурный тест**

`tests/test-c3-3e3-integration-runtime-deletion.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { COMMANDS } from "../dist/repo-guard.mjs";
import { compileConstraintProgram, runtimeConstraints } from "../dist/checks/constraint-program.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
const json = (path) => JSON.parse(read(path));

assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "init", "doctor"]);
for (const path of [
  "src/integration-validator.mts", "src/extractors/integration.mts",
  "src/checks/integration-constraints.mts",
]) assert.equal(existsSync(resolve(root, path)), false, `${path} must be deleted`);

const schema = json("schemas/repo-policy.schema.json");
assert.equal(schema.properties?.integration, undefined);
const validate = new Ajv({ allErrors: true }).compile(schema);
const oldPolicy = json("repo-policy.json");
assert.equal(Object.hasOwn(oldPolicy, "integration"), false);
const invalid = { ...oldPolicy, integration: {} };
assert.equal(validate(invalid), false);

const runtimeSource = read("src/checks/rules/constraints.mts");
const kindBlock = runtimeSource.match(/type RuntimeConstraintKind =([\s\S]*?);/);
const kinds = kindBlock ? [...kindBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() : [];
assert.deepEqual(kinds, ["primitive_relation"]);
assert.equal(runtimeSource.includes("integrationConstraintEntries"), false);
assert.equal(read("src/facts/input.mts").includes("extractIntegration"), false);
assert.equal(read("src/policy-compiler.mts").includes("compileIntegrationPolicy"), false);
assert.equal(read("src/doctor.mts").includes("checkWorkflowConfig"), false);
assert.equal(read("src/doctor.mts").includes("compileIntegrationPolicy"), false);

const kindsFromProgram = [...new Set(runtimeConstraints(compileConstraintProgram(oldPolicy, null)).map((item) => item.kind))].sort();
assert.deepEqual(kindsFromProgram, ["primitive_relation"]);
assert.equal(relationDescriptors().length, 10);
console.log("C3.3e E3c integration deletion contract passed.");
```

- [ ] **Step 4: доказать RED**

```bash
npm run build
node tests/test-c3-3e3-integration-runtime-deletion.mjs
```

Ожидание: FAIL на `validate-integration`, schema/self-policy `integration`, source modules и runtime kind.

- [ ] **Step 5: закоммитить только RED**

```bash
git add tests/test-c3-3e3-integration-runtime-deletion.mjs
git commit -m "test(c3.3e3): falsify integration runtime deletion"
```

### Задача 10: удалить acquisition/compiler/evaluator path

**Files:**
- Modify: `src/facts/input.mts`, `src/checks/constraint-program.mts`, `src/checks/rules/constraints.mts`, `src/policy-compiler.mts`, `src/repo-guard.mts`, `src/doctor.mts`.
- Delete: три integration modules.

- [ ] **Step 1: убрать специальное приобретение фактов**

В `src/facts/input.mts` удалить:

```text
extractIntegration import
RepositoryFactsPolicyProjection.integration
integration: extractIntegration(...)
```

Остальные facts, `documents`, anchors и derived facts не менять.

- [ ] **Step 2: убрать `integration` из Constraint Program**

В `src/checks/constraint-program.mts` удалить:

```text
IntegrationWorkflowProjection
IntegrationDocProjection
IntegrationProjection
ConstraintPolicyProjection.integration
workflow strictness loop
integration docs strictness loop
runtime:integration emission
integration handling in unknownProjection
integration-specific metadata fields if no other caller remains
```

Не заменять это `document_relations` rules автоматически.

- [ ] **Step 3: схлопнуть runtime evaluator**

В `src/checks/rules/constraints.mts` удалить:

```text
integrationConstraintEntries import
"integration" from RuntimeConstraintKind
FixedPhaseConstraintKind/CONSTRAINT_PHASES if they become empty
ConstraintFacts.integration
integration branch in evaluateConstraintIR
```

`evaluateConstraintIR()` должен вычислять каждый runtime item только через `evaluatePrimitiveRelation()`; неизвестный kind продолжает fail-closed.

- [ ] **Step 4: удалить integration policy compiler**

В `src/policy-compiler.mts` удалить типы и функции:

```text
IntegrationSection
IntegrationProjection
IntegrationReference
semanticIntegrationEntries
compileIntegrationPolicy
```

Не добавлять заменяющий compiler.

- [ ] **Step 5: удалить special validator/extractor/evaluator modules**

```bash
git rm src/integration-validator.mts src/extractors/integration.mts src/checks/integration-constraints.mts
```

- [ ] **Step 6: сжать CLI и doctor**

Из `src/repo-guard.mts` удалить:

```text
validate-integration command
doctor --integration dispatch
```

Финальный command registry:

```text
validate
check-diff
check-pr
init
doctor
```

Из `src/doctor.mts` удалить `compileIntegrationPolicy` и все его вызовы, затем полностью удалить `checkWorkflowConfig()` и `readdirSync`, если он после этого не используется. `doctor` сохраняет только repository root, git/history, policy schema/compiler, event context, auth и `gh` availability.

- [ ] **Step 7: focused build/test**

```bash
npm run build
npm run check:dist
node tests/test-c3-3e3-integration-runtime-deletion.mjs
```

Ожидание: source/runtime/CLI assertions GREEN; schema/self-policy могут оставаться красными до governance task.

- [ ] **Step 8: commit semantic core deletion**

```bash
git add src dist tests/test-c3-3e3-integration-runtime-deletion.mjs
git commit -m "refactor(c3.3e3): delete integration semantic runtime"
```

### Задача 11: удалить public DSL и self integration governance

**Files:**
- Modify: `schemas/repo-policy.schema.json`, `repo-policy.json`, `.github/workflows/ci.yml`.

- [ ] **Step 1: удалить schema DSL**

Удалить top-level property `integration` и все definitions, достижимые только из неё:

```text
integration_workflow
integration_workflow_expectation
integration_template
integration_doc
integration_profile
```

Перед удалением definitions:

```bash
git grep -n -I -E 'integration_workflow|integration_template|integration_doc|integration_profile' -- schemas src tests ':!dist/**'
```

Оставлять definition разрешено только при реальной ссылке из сохраняемой schema feature; имя ради истории не сохранять.

- [ ] **Step 2: удалить self-policy `integration` целиком**

Из `repo-policy.json` удалить весь top-level объект `integration`. Никаких replacement `document_relations` в этом срезе без отдельного красного safety invariant.

- [ ] **Step 3: удалить self CI special validation**

Из `.github/workflows/ci.yml` удалить step:

```text
Run validate-integration on self
```

Обычный `npx repo-guard` и `npx repo-guard doctor` сохраняются.

- [ ] **Step 4: проверить, что final head не требует broad policy bypass**

```bash
npm run build
node tests/test-c3-3e3-integration-runtime-deletion.mjs
node dist/repo-guard.mjs
```

PR policy должен авторизоваться trusted governance paths из E3c issue. Если final runtime всё ещё требует `allow_policy_relaxation: ["/"]`, это архитектурная ошибка удаления: остановить срез и найти оставшийся unknown integration semantic path вместо выдачи корневого bypass.

- [ ] **Step 5: commit public DSL cut**

```bash
git add schemas/repo-policy.schema.json repo-policy.json .github/workflows/ci.yml tests/test-c3-3e3-integration-runtime-deletion.mjs
git commit -m "refactor(c3.3e3): delete integration policy DSL"
```

### Задача 12: удалить integration tests/fixtures/docs и завершить runtime=1

- [ ] **Step 1: удалить specialized integration tests/fixtures**

```bash
git rm tests/test-integration-diagnostics.mjs tests/test-integration-docs-strictness.mjs tests/test-integration-extractors.mjs tests/test-integration-fixtures.mjs tests/test-integration-validator-boundary.mjs
git rm -r tests/fixtures/integration
git rm examples/downstream-integration-policy.json
```

- [ ] **Step 2: обновить общие schema/compiler/delta tests**

`tests/validate-schemas.mjs` должен проверять, что old top-level `integration` rejected.

`tests/test-policy-compiler-boundary.mjs` больше не импортирует `compileIntegrationPolicy`.

`tests/test-policy-delta-rules.mjs` удаляет integration-specific strictness expectations; общая policy-delta защита других canonical constraints остаётся неизменной.

- [ ] **Step 3: обновить doctor/self-host tests**

`tests/test-doctor.mjs` удалить fixtures для workflow regex semantics и integration compiler. Добавить assertion, что ordinary doctor result names не содержат `workflow-config`.

`tests/test-self-hosting.mjs` должен утверждать:

```js
assert.equal(Object.hasOwn(policy, "integration"), false);
```

и проверять самоприменение через фактический workflow/required checks, а не через старый DSL.

- [ ] **Step 4: обновить CLI/source-cutover tests**

`tests/test-typescript-source-cutover.mjs`:

```js
assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "init", "doctor"]);
```

Удалить все assertions про integration/provider sources.

- [ ] **Step 5: обновить documentation**

Из `README.md`, `docs/self-hosting-coverage.md`, `docs/self-hosting-coverage.json` удалить current-product утверждения про `integration` DSL, `validate-integration`, workflow semantic introspection, provider readiness и migration. Исторические принятые design/plan документы не переписывать.

Документация final self-host boundary:

```text
repo-policy + ChangeIntent
        ↓
canonical primitive relations
        ↓
validate / check-pr
        ↓
GitHub required checks: validate + smoke-pack
        ↓
accepted main
```

- [ ] **Step 6: broad deletion grep**

```bash
git grep -n -I -E 'compileIntegrationPolicy|extractIntegration|integrationConstraintEntries|validate-integration|integration-validator|repo-policy\.integration|"integration"\s*:' -- src tests schemas repo-policy.json action.yml .github README.md docs examples templates ':!docs/superpowers/**' ':!dist/**'
```

Ожидание: ноль живых product matches. Слово `integration` допустимо только как общеязыковое описание внешней интеграции, а не идентификатор удалённой DSL/runtime capability.

- [ ] **Step 7: обновить compression metric ratchet**

В `scripts/compression-metrics.mjs` удалить метрики, существование которых само зависит от special `integration` product, когда они больше не отражают реальную архитектуру. Сохранить общие физические/CI/policy метрики и добавить machine-visible финальные значения через существующие поля:

```text
runtime_constraint_kinds = 1
runtime_constraint_kind_names = primitive_relation
canonical_factref_model_count = 1
primitive_descriptor_registry_count = 1
primitive_descriptor_kinds count = 10
canonical_fact_sources count = 4
bespoke_integration_validator = 0
```

Не создавать второй metrics script.

- [ ] **Step 8: полный локальный E3c gate**

```bash
npm run build
npm run check:dist
node tests/test-c3-3e1-compatibility-surface-deletion.mjs
node tests/test-c3-3e2-provider-surface-deletion.mjs
node tests/test-c3-3e3-integration-runtime-deletion.mjs
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs doctor
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

Ожидания:

```text
runtime_constraint_kinds = 1
runtime_constraint_kind_names = primitive_relation
canonical_factref_model_count = 1
canonical_fact_sources = change_intent,diff,document,repository
primitive_descriptor_registry_count = 1
primitive descriptor count = 10
bespoke_integration_validator = 0
public CLI commands = 5
compatibility/provider/migration/integration public product = 0
```

- [ ] **Step 9: commit convergence**

```bash
git add tests README.md docs examples scripts dist
git commit -m "test(c3.3e3): converge on one semantic runtime"
```

- [ ] **Step 10: Draft PR с governance ChangeIntent**

Использовать grant из Задачи 9. `allow_policy_relaxation` не расширять молча. Ready-state обязан доказать сам себя уже новым runtime без `validate-integration`/parallel doctor.

- [ ] **Step 11: ready-state, race-check, exact merge, post-merge**

На exact head:

```text
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

После exact-head merge на новом `main`:

```text
validate = SUCCESS
smoke-pack = SUCCESS
```

Отдельно перечитать branch protection и подтвердить, что required checks всё ещё `validate`, `smoke-pack`.

---

# IV. E3d — финальный broad C3.3 audit

### Задача 13: измерить физическую и семантическую архитектуру после E3c

**Files:**
- Create: `docs/superpowers/reports/2026-09-09-c3-3e-final-audit.md`
- Modify only if metric gap proven: `scripts/compression-metrics.mjs`, `tests/test-compression-rules.mjs`.

**Interfaces:**
- Consumes: exact accepted E3c `main` and C3.0 baseline.
- Produces: machine-backed acceptance report for #411 and input for separate #374 closure review.

- [ ] **Step 1: создать audit branch от accepted E3c main**

```bash
git fetch origin main
git switch -c c3/411-e3d-final-audit origin/main
```

- [ ] **Step 2: снять канонические метрики**

```bash
npm run compression:metrics -- --ref HEAD --compare 92432809fcddc290080beb51ba151e13a5761869 > /tmp/c3-3e-metrics.json
node -e 'const x=require("/tmp/c3-3e-metrics.json"); console.log(JSON.stringify(x.current,null,2))'
```

Записать в отчёт exact значения:

```text
src files/lines/bytes
schemas files/lines/bytes
tests files/lines/bytes
docs files/lines/bytes
examples files/lines/bytes
rule_families
semantic_edit_sites
runtime_constraint_kinds + names
canonical_factref_model_count
canonical_fact_sources
primitive_descriptor_registry_count + kinds
schema surface
policy bytes/top-level concepts
CLI command inventory
Action inputs/modes
CI jobs/npm-ci/check-dist/test counts
```

- [ ] **Step 3: отдельный source/public vocabulary audit**

```bash
git grep -n -I -E 'portable-coordinator|parallel-readiness|parallel-doctor|parallel-control-plane|github_merge_queue|legacy provider|validate-integration|compileIntegrationPolicy|extractIntegration|integrationConstraintEntries|migration-plan|migration-apply|runMigrate|runStatus' -- src tests schemas repo-policy.json action.yml .github README.md docs examples templates ':!docs/superpowers/**' ':!dist/**'
```

Ожидание: ноль поддерживаемых product matches.

- [ ] **Step 4: проверить hard invariants напрямую**

```bash
node tests/test-c3-3e1-compatibility-surface-deletion.mjs
node tests/test-c3-3e2-provider-surface-deletion.mjs
node tests/test-c3-3e3-integration-runtime-deletion.mjs
npm test
npm run check:dist
node dist/repo-guard.mjs
node dist/repo-guard.mjs doctor
```

- [ ] **Step 5: написать final audit report**

`docs/superpowers/reports/2026-09-09-c3-3e-final-audit.md` содержит:

```text
accepted E3c main SHA
C3.0 baseline SHA
before -> after physical metrics
before -> after semantic metrics
final CLI inventory
final Action input/mode inventory
FactRef models/sources
relation descriptor count/list
runtime kind count/list
provider/migration/compatibility concepts = none
branch protection required checks
open issues #411/#374 status
```

Отчёт не объявляет #374 завершённой автоматически.

- [ ] **Step 6: если metrics script не показывает требуемый показатель, сначала написать красный metric test**

Добавлять поле в `scripts/compression-metrics.mjs` разрешено только если оно нужно для одного из перечисленных acceptance metrics и выводимо из канонического source/schema. Не добавлять отдельный scanner.

- [ ] **Step 7: полный gate отчёта**

```bash
npm run build
npm run check:dist
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs doctor
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

- [ ] **Step 8: commit audit**

```bash
git add docs/superpowers/reports scripts tests
git commit -m "docs(c3.3e): record final compression audit"
```

- [ ] **Step 9: принять audit PR обычным exact-head протоколом**

Если E3d не меняет governance paths, `change_type: docs` либо `test` выбирается по фактическому diff. Если пришлось менять `scripts/**`/tests, использовать `change_type: test`; новый `GovernanceGrant` не требуется, пока governance paths не затронуты.

- [ ] **Step 10: обновить #411 и провести отдельный #374 acceptance review**

В #411 записать exact accepted main и final metrics, затем закрыть #411 `completed` только если все C3.3e инварианты доказаны.

В #374 отдельно проверить:

```text
rule_families
semantic_edit_sites
remaining historical public DSL
remaining specialized runtime/compilers
src/schema physical compression
self-host exemplar quality
```

Только отдельное положительное решение #374 разрешает переход к #375 / C3.4.

---

## Самопроверка плана

### Покрытие спецификации

- Удаление lifecycle/migration: E3a.
- Удаление portable/parallel/merge-group/control-plane и `init --parallel`: E3b.
- Удаление Action provider inputs и self portable workflow: E3b.
- Удаление `integration` schema/compiler/extractor/evaluator/CLI: E3c.
- Удаление `doctor.workflow-config` regex semantics: E3c.
- Финальный CLI из пяти команд: E3c.
- Runtime kinds `2 -> 1`: E3c.
- `FactRef = 1`, sources `4`, descriptors `10`, registry `1`: asserts каждого архитектурного теста и E3d.
- Никакого механического переноса старых integration conventions: E3c прямо удаляет self DSL без replacement relations.
- Branch protection и реальные CI gates остаются authority: каждый slice exact-head + post-merge; E3c повторно читает branch protection.
- GovernanceGrant: точный provider relaxation в E3b; E3c не разрешает корневой policy bypass.
- #374 не закрывается автоматически: E3d заканчивается отдельным parent acceptance review.

### Проверка отсутствия заглушек

План не использует незаполненные имена функций, файлов или будущих SHA. Динамические SHA получаются командами `git rev-parse`/GitHub race-check и сразу фиксируются как evidence; это runtime evidence, а не текстовая заглушка.

### Согласованность интерфейсов

Последовательный CLI inventory:

```text
accepted before E3a = 10 commands
E3a = 8 commands
E3b = 6 commands
E3c = 5 commands
```

Последовательный runtime inventory:

```text
accepted before E3a = integration,primitive_relation
E3a = integration,primitive_relation
E3b = integration,primitive_relation
E3c = primitive_relation
```

На всём пути:

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
```
