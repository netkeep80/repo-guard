# C3.3d — план реализации сжатия оставшегося исполняемого хвоста

> **Для исполнителя:** обязательны навыки `test-driven-development`, а перед утверждением завершения каждого среза — `verification-before-completion`. Каждый срез выполняется отдельным `PR` от фактически принятого `main`.

**Цель:** убрать самостоятельные исполняемые виды `surface_debt`, `registry_rules`, `change_profile`, `size_rules`, сохранив полезные возможности только как чистое разворачивание в канонические факты и существующую алгебру отношений.

**Архитектура:** пользовательский высокоуровневый синтаксис может оставаться только там, где он полезен; после `compileConstraintProgram` семантика должна течь через один `FactRef`, десять канонических дескрипторов отношений и один исполнитель `primitive_relation`. C3.3d не меняет `integration`.

**Стек:** Node.js 24, TypeScript `.mts`, сгенерированный `dist/*.mjs`, JSON Schema draft-07, встроенный `node:test`, собственный `repo-guard`, GitHub Actions.

Связанные задачи:

```text
#370 — Architecture Compression 3.0
#374 — C3.3 historical-family lowering
#398 — C3.3d runtime-tail convergence
#400 — C3.3d1 delete surface_debt + registry_rules
```

Утверждённый архитектурный документ:

```text
docs/superpowers/specs/2026-09-08-c3-3d-runtime-tail-convergence-design.md
```

Исходное принятое состояние на момент планирования:

```text
main = 712ebec3d8040b42b0cf7ff4f0eaf9ed78fa0f35
canonical C3.0 measurement baseline = 92432809fcddc290080beb51ba151e13a5761869
runtime kinds = 6
```

Целевой храповик:

```text
C3.3d1: 6 -> 4
C3.3d2: 4 -> 3
C3.3d3: 3 -> 2

final runtime kinds:
integration
primitive_relation
```

На всём пути должны оставаться:

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
new relation descriptors = 0
```

---

## Общий порядок работы

- [ ] Перед каждым срезом заново прочитать `main`, родительскую issue, дочернюю issue и состояние открытых `PR`.
- [ ] Ветвить следующий срез только от фактически принятого `main` после предыдущего среза.
- [ ] Первый коммит каждого исполняемого среза — только тесты, намеренно красные.
- [ ] Зафиксировать точную причину красного `CI`; красный должен доказывать отсутствие целевой архитектуры, а не случайную поломку окружения.
- [ ] Затем делать минимальное изменение production/schema.
- [ ] Сгенерировать `dist` обычной сборкой; не редактировать его смысл вручную.
- [ ] Мигрировать старые тесты только после зелёного целевого теста.
- [ ] Выполнить полный набор тестов, self-hosting, метрики сжатия от точной базовой точки.
- [ ] Держать `PR` черновиком до полного зелёного состояния на точной голове.
- [ ] Перевести в готовое состояние без изменения головы и получить успешный `Run PR policy check`.
- [ ] Слить только точную проверенную голову.
- [ ] Проверить полный `CI` уже на новом `main`.
- [ ] Только после этого создавать следующую дочернюю issue и ветку.

Базовые команды проверки для каждого среза:

```bash
npm run build
npm run check:dist
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

Перед каждой записью в GitHub дополнительно проверять:

```bash
git status --short
git rev-parse HEAD
git diff --name-only main...HEAD
```

В среде без локального `git` эквивалентные факты брать из GitHub: exact `main`, exact head, compare и changed files.

---

# Часть I — C3.3d1: удалить `surface_debt` и `registry_rules`

## Задача 1.1 — создать независимый красный архитектурный тест

**Файлы:**

- создать `tests/test-c3-3d1-runtime-tail-deletion.mjs`;
- пока не менять production, schema, `dist` и старые тесты.

- [ ] Сначала зафиксировать реальный остаток:

```bash
git grep -n -I -E 'surface_debt|surface-debt|registry_rules|registry-rules|checkSurfaceDebt|checkRegistryRules|RegistryRule' -- ':!dist/**'
```

- [ ] Новый тест должен читать публичные схемы и исходники, импортировать `compileConstraintProgram`, `runtimeConstraints`, `relationDescriptors` и проверять конечное состояние.

Минимальные утверждения:

```text
1. ChangeIntent schema rejects surface_debt.
2. repo-policy schema rejects registry_rules.
3. compiled program emits neither surface_debt nor registry_rules.
4. runtime kind union contains neither kind.
5. runtime evaluator contains neither dedicated dispatch/helper.
6. src/checks/rules/registry-rules.mts is absent.
7. dist/checks/rules/registry-rules.mjs is absent after build.
8. self repo-policy.json consumes neither concept.
9. relation descriptor count remains 10.
10. FactRef source vocabulary remains change_intent,diff,document,repository.
11. runtime kind target after d1 is exactly change_profile,size_rules,integration,primitive_relation.
```

- [ ] Для схемы использовать реальные валидные базовые объекты и добавить только удаляемое поле; не считать текстовый поиск заменой schema validation.

Пример проверки `surface_debt`:

```js
const removedDebtIntent = {
  change_type: "feature",
  scope: ["src/**"],
  budgets: {},
  must_touch: [],
  must_not_touch: [],
  expected_effects: ["test"],
  surface_debt: {
    kind: "temporary_growth",
    reason: "temporary",
    expected_delta: { max_new_files: 1 },
    repayment_issue: 1,
  },
};
```

Пример удалённого registry:

```js
const removedRegistryPolicy = {
  ...validPolicy,
  registry_rules: [{
    id: "legacy-registry",
    kind: "set_equality",
    left: { type: "json_array", file: "a.json", json_pointer: "/items" },
    right: { type: "json_array", file: "b.json", json_pointer: "/items" },
  }],
};
```

- [ ] Запустить только новый тест:

```bash
node tests/test-c3-3d1-runtime-tail-deletion.mjs
```

Ожидаемое состояние до production-удаления: проверки 1–7 и 11 красные; инварианты 8–10 зелёные.

- [ ] Запустить полный набор, чтобы убедиться, что новый тест — единственный намеренный источник красного:

```bash
npm test
```

- [ ] Коммит только теста:

```bash
git add tests/test-c3-3d1-runtime-tail-deletion.mjs
git commit -m "test(c3.3d1): falsify runtime-tail deletion"
```

- [ ] Зафиксировать намеренно красный `CI` в #400.

## Задача 1.2 — удалить публичный `surface_debt`

**Файлы:**

- изменить `schemas/change-intent.schema.json`;
- изменить `src/checks/constraint-program.mts`;
- изменить `src/checks/rules/constraints.mts`;
- соответствующие сгенерированные файлы в `dist/` получить сборкой.

- [ ] Из `schemas/change-intent.schema.json` физически удалить свойство `surface_debt` целиком.

Поскольку `additionalProperties: false`, старая форма после этого отвергается автоматически. Не добавлять `deprecated`, alias или отдельную диагностическую ветвь совместимости.

- [ ] Из `ChangeIntentProjection` в `src/checks/constraint-program.mts` удалить `surface_debt?: unknown`.
- [ ] Удалить безусловную запись:

```ts
add("surface-debt", { kind: "surface_debt", name: "surface-debt", debt: changeIntent?.surface_debt });
```

- [ ] В `src/checks/rules/constraints.mts` удалить:

```text
SurfaceDebt interface
calculateDiffGrowth import, если больше не нужен
surface_debt from RuntimeConstraintKind
surface_debt from CONSTRAINT_PHASES
debt field from RuntimeConstraint
checkSurfaceDebt
surface_debt dispatch branch
```

- [ ] Не менять `GovernanceGrant`, `diff_rules` и обычные бюджеты. Удаление debt не должно давать новый способ обхода бюджетов.

## Задача 1.3 — удалить публичный и исполняемый `registry_rules`

**Файлы:**

- изменить `schemas/repo-policy.schema.json`;
- изменить `src/checks/constraint-program.mts`;
- изменить `src/checks/rules/constraints.mts`;
- удалить `src/checks/rules/registry-rules.mts`;
- после сборки удалить соответствующий `dist/checks/rules/registry-rules.mjs` автоматически через генерацию;
- позже мигрировать тесты, которые импортируют старый модуль.

- [ ] Из `schemas/repo-policy.schema.json` удалить верхнеуровневое свойство `registry_rules`.
- [ ] Из `definitions` удалить `registry_source` и другие определения, используемые только `registry_rules`. Перед удалением подтвердить `git grep`, что ссылок вне этого раздела нет.
- [ ] Не переносить `markdown_section_links` в новый selector.
- [ ] Из `ConstraintPolicyProjection` удалить `registry_rules?: unknown[]`.
- [ ] Удалить runtime emission:

```ts
if (array(policy.registry_rules).length) {
  add("runtime:registry-rules", { kind: "registry_rules", name: "registry-rules", rules: policy.registry_rules });
}
```

- [ ] В `constraints.mts` удалить import `checkRegistryRules`, runtime kind, phase и dispatch.
- [ ] Физически удалить `src/checks/rules/registry-rules.mts`.
- [ ] Не добавлять replacement wrapper вокруг `compareSets`.

## Задача 1.4 — собрать и получить первый зелёный d1

- [ ] Собрать:

```bash
npm run build
npm run check:dist
```

- [ ] Проверить новый целевой тест:

```bash
node tests/test-c3-3d1-runtime-tail-deletion.mjs
```

- [ ] Проверить предыдущие C3 ratchets:

```bash
node tests/test-c3-3-historical-lowering.mjs
node tests/test-c3-3b-trace-anchor-lowering.mjs
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
node tests/test-canonical-relation-kernel.mjs
```

- [ ] Коммит production/schema/dist удаления:

```bash
git add schemas/change-intent.schema.json schemas/repo-policy.schema.json src/checks/constraint-program.mts src/checks/rules/constraints.mts dist/checks/constraint-program.mjs dist/checks/rules/constraints.mjs
git add -u src/checks/rules/registry-rules.mts dist/checks/rules/registry-rules.mjs
git commit -m "refactor(c3.3d1): delete debt and registry runtimes"
```

## Задача 1.5 — мигрировать исторические тесты и документацию d1

**Проверить и при необходимости изменить:**

- `tests/validate-schemas.mjs`;
- `tests/test-change-intent.mjs`;
- `tests/test-policy-compiler-boundary.mjs`;
- `tests/test-policy-delta-rules.mjs`;
- `tests/test-compression-rules.mjs`;
- `tests/test-execution-phases.mjs`;
- `tests/test-structured-output.mjs`;
- `README.md`;
- `RELEASING.md`;
- `PORTFOLIO.md`;
- `examples/**`.

- [ ] Использовать точный поиск:

```bash
git grep -n -I -E 'surface_debt|surface-debt|registry_rules|registry-rules|checkSurfaceDebt|checkRegistryRules|markdown_section_links|set_equality' -- \
  tests README.md RELEASING.md PORTFOLIO.md examples schemas src
```

- [ ] Удалить тесты поведения удалённых evaluator-ов.
- [ ] Вместо них оставить явные отрицательные schema tests:

```text
surface_debt rejected
registry_rules rejected
```

- [ ] Не добавлять разделы «устарело» в пользовательские документы. История уже находится в Git и issues.
- [ ] Если старая issue #35 относится только к `surface_debt`, после принятия d1 закрыть её как поглощённую удалением концепта, а не переносить старое требование.

- [ ] Полный тест:

```bash
npm test
```

- [ ] Коммит миграции тестов/документации:

```bash
git add tests README.md RELEASING.md PORTFOLIO.md examples

git commit -m "test(c3.3d1): enforce deleted public concepts"
```

Добавлять в индекс только реально изменённые файлы; если верхние документы не содержат удалённых терминов, не трогать их.

## Задача 1.6 — приёмка d1

- [ ] Метрики:

```bash
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

Требуемые факты:

```text
runtime_constraint_kinds = 4
runtime_constraint_kind_names = change_profile,integration,primitive_relation,size_rules
primitive_descriptor_kinds = existing 10
canonical_fact_sources = change_intent,diff,document,repository
```

- [ ] Полный self-hosting:

```bash
npm run check:dist
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
```

- [ ] Проверить diff: `repo-policy.json`, `.github/**`, `action.yml`, `integration` не должны меняться.
- [ ] Дождаться зелёного draft `CI`.
- [ ] Перевести `PR` в готовое состояние без изменения exact head.
- [ ] Убедиться, что `validate`, `smoke-pack`, `Run PR policy check` зелёные на одной голове.
- [ ] Слить только эту голову.
- [ ] Проверить post-merge `CI` на новом `main`.
- [ ] Закрыть #400 как выполненную, если это не сделал `Fixes #400`.
- [ ] Записать в #398 accepted checkpoint: `6 -> 4`, descriptors 10, FactRef sources 4.

---

# Часть II — C3.3d2: чистое разворачивание `change_profiles`

## Задача 2.0 — открыть работу только от принятого d1

- [ ] Заново прочитать новый `main` после d1 и записать SHA в новую дочернюю issue.
- [ ] Создать child issue с названием:

```text
[C3.3d2] Pure-lower change profiles into canonical diff relations
```

- [ ] В issue зафиксировать target:

```text
runtime kinds 4 -> 3
remaining = size_rules,integration,primitive_relation
relation descriptors = 10
FactRef sources = 4
new selector = NONE
```

- [ ] Создать ветку только от нового accepted `main`. Не переиспользовать design/d1 branch.
- [ ] Открыть draft `PR` с `Fixes #<d2 issue>` и узким `ChangeIntent`.

## Задача 2.1 — написать красный тест эквивалентности и архитектуры

**Файл:** создать `tests/test-c3-3d2-change-profile-lowering.mjs`.

- [ ] Новый тест не импортирует `checkChangeProfile` как целевой механизм. Он строит policy + ChangeIntent, вызывает canonical compilation/evaluation и утверждает итоговое решение.

Обязательная матрица:

```text
allowed surface passes
forbidden surface fails
required surface present passes
required surface missing fails
overlapping allowed+disallowed surface fails
unclassified path checked only when surface constraints exist
allow_unclassified_surfaces=true permits unclassified
new allowed class passes
new disallowed class fails
empty allow_classes forbids every touched declared class
unclassified new file fails when new_files block exists
max_per_class enforced
new_files.max_new_files enforced
profile max_new_docs enforced with canonical_docs exclusion
profile max_new_files enforced
profile max_net_added_lines enforced
governance change_type emits no profile constraints
missing change_type fails closed when profiles exist
unknown non-governance change_type fails closed
unknown surface/class reference fails in semantic compilation
runtime program contains no change_profile kind
src/dist change-profiles evaluator absent after implementation
relation descriptors stay 10
FactRef sources stay 4
```

- [ ] До production-изменения этот тест должен быть красным прежде всего на отсутствии pure lowering и наличии dedicated runtime kind.
- [ ] Сохранить отдельные небольшие fixtures внутри теста; не создавать новый fixture framework.
- [ ] Коммит только теста:

```bash
git add tests/test-c3-3d2-change-profile-lowering.mjs
git commit -m "test(c3.3d2): falsify change-profile lowering"
```

- [ ] Зафиксировать красный `CI` в d2 issue.

## Задача 2.2 — сделать typed projection профилей в `constraint-program`

**Файлы:**

- изменить `src/checks/constraint-program.mts`;
- при необходимости изменить только compile-time reference validation в `src/policy-compiler.mts`;
- не менять relation kernel.

- [ ] Заменить `change_profiles?: unknown` на минимальные типизированные projections:

```ts
interface ChangeProfileNewFilesProjection {
  allow_classes?: unknown;
  max_per_class?: Record<string, number>;
  max_new_files?: number;
}

interface ChangeProfileProjection {
  require_surfaces?: unknown;
  allow_surfaces?: unknown;
  forbid_surfaces?: unknown;
  allow_unclassified_surfaces?: boolean;
  new_files?: ChangeProfileNewFilesProjection;
  budgets?: DiffRulesProjection;
}
```

и соответствующие maps `surfaces`, `new_file_classes`, `change_profiles` в `ConstraintPolicyProjection`.

- [ ] Добавить `change_type?: string` в `ChangeIntentProjection`, если его там ещё нет на accepted d1.

- [ ] Не добавлять новый `FactRef` source/selector. Использовать существующие:

```text
diff.changed_paths(patterns, mode, exclude_statuses)
diff.metric(new_docs|new_files|net_added_lines)
numeric_bound(min|max)
```

## Задача 2.3 — реализовать pure lowering поверхностей

В `compileConstraintProgram`:

- [ ] Если `policy.change_profiles` отсутствует — не добавлять ничего.
- [ ] Если `change_type === "governance"` — не создавать profile runtime relations.
- [ ] Если профили есть, а `change_type` отсутствует — добавить compile-time blocking diagnostic через существующую semantic compilation boundary; не создавать runtime kind.
- [ ] Если non-governance `change_type` неизвестен — аналогично fail closed до runtime.

Для выбранного профиля:

- [ ] `forbid_surfaces`: для каждой названной поверхности скомпилировать:

```text
diff.changed_paths(patterns = surface patterns, exclude deleted)
  -> numeric_bound(max = 0)
```

- [ ] `require_surfaces`: для каждой обязательной поверхности:

```text
diff.changed_paths(patterns = surface patterns, exclude deleted)
  -> numeric_bound(min = 1)
```

- [ ] `allow_surfaces`: вычислить множество всех объявленных поверхностей, которых нет в allow list; для каждой такой поверхности создать отдельный `numeric_bound(max=0)`. Это сохраняет overlap semantics.

- [ ] `allow_unclassified_surfaces=false`: создавать запрет только если реально задан хотя бы один из `require_surfaces`, `allow_surfaces`, `forbid_surfaces`.

Факт для unclassified:

```text
diff.changed_paths(
  patterns = union(all declared surface patterns),
  mode = outside,
  exclude deleted
)
  -> numeric_bound(max = 0)
```

## Задача 2.4 — реализовать pure lowering новых файлов

- [ ] Если `new_files` отсутствует — не создавать class constraints.
- [ ] Если блок есть, added paths должны проверяться относительно всех `new_file_classes`.

Для каждого класса, не входящего в `allow_classes`:

```text
diff.changed_paths(patterns = class patterns, statuses effectively added)
  -> numeric_bound(max = 0)
```

Текущий `DiffFactSelector.changed_paths` имеет `exclude_statuses`, а не `statuses`. Для selection только added использовать конечный набор исключений текущего `DiffFileStatus`, например исключить `modified`, `deleted`, `renamed` согласно фактическому типу после свежего reread. Не расширять selector только ради удобства, если существующее поле выражает нужную выборку.

- [ ] Unclassified added path:

```text
diff.changed_paths(
  patterns = union(all new-file class patterns),
  mode = outside,
  exclude_statuses = all statuses except added
)
  -> numeric_bound(max = 0)
```

- [ ] `max_per_class[class]`:

```text
added paths matching class
  -> numeric_bound(max = configured limit)
```

- [ ] `new_files.max_new_files`:

```text
diff.metric(new_files)
  -> numeric_bound(max = configured limit)
```

## Задача 2.5 — развернуть profile budgets

Использовать ровно те же canonical diff metrics, что и top-level `diff_rules`:

```text
max_new_docs -> diff.metric(new_docs, exclude_paths=canonical_docs)
max_new_files -> diff.metric(new_files)
max_net_added_lines -> diff.metric(net_added_lines)
```

каждый с `numeric_bound(max=...)`.

- [ ] Не дублировать вычисление line growth вручную.
- [ ] Не вызывать `classifyNewFiles`/`detectTouchedSurfaces` из evaluator для semantic decision.

## Задача 2.6 — удалить dedicated evaluator `change_profile`

**Файлы:**

- изменить `src/checks/rules/constraints.mts`;
- удалить `src/checks/rules/change-profiles.mts`;
- сборкой удалить `dist/checks/rules/change-profiles.mjs`;
- изменить `src/checks/constraint-program.mts`.

- [ ] Удалить runtime emission `runtime:change-profile`.
- [ ] Удалить import `checkChangeProfile`.
- [ ] Удалить `change_profile` из `RuntimeConstraintKind`, `CONSTRAINT_PHASES`, dispatch.
- [ ] Если `facts.derived` после удаления больше не нужен constraints family, убрать его из локальной projection; не удалять acquisition globally до отдельного аудита, если он нужен другим consumers/reporting.

- [ ] Собрать и выполнить focused test:

```bash
npm run build
npm run check:dist
node tests/test-c3-3d2-change-profile-lowering.mjs
```

- [ ] Коммит production lowering:

```bash
git add src/checks/constraint-program.mts src/checks/rules/constraints.mts src/policy-compiler.mts dist/checks/constraint-program.mjs dist/checks/rules/constraints.mjs dist/policy-compiler.mjs
git add -u src/checks/rules/change-profiles.mts dist/checks/rules/change-profiles.mjs
git commit -m "refactor(c3.3d2): lower change profiles into relations"
```

Добавлять `policy-compiler` только если он реально изменён.

## Задача 2.7 — мигрировать старые profile-тесты без потери семантики

**Основные файлы:**

- `tests/test-policy-profiles.mjs`;
- `tests/test-compression-rules.mjs`;
- `tests/test-policy-compiler-boundary.mjs`;
- `tests/test-execution-phases.mjs`;
- `tests/test-structured-output.mjs`;
- `tests/test-self-hosting.mjs`.

- [ ] Удалить прямые imports `checkChangeProfile`.
- [ ] Перенести полезные behavioral cases на `compileConstraintProgram` + `evaluateConstraintIR`/canonical relation results.
- [ ] Не сохранять старую форму diagnostics как контракт. Проверять решение, relation origin, selected facts и fail-closed reason.
- [ ] `repo-policy.json` не переписывать: это ключевое доказательство, что тот же публичный `change_profiles` syntax self-hosts через новый lowering.

- [ ] Полный поиск:

```bash
git grep -n -I -E 'checkChangeProfile|change_profile|change-profiles.mjs' -- tests src dist
```

После миграции допускается `change_profiles` как public syntax, но не `change_profile` runtime kind и не evaluator import.

- [ ] Полный набор:

```bash
npm test
```

- [ ] Коммит тестовой миграции:

```bash
git add tests
git commit -m "test(c3.3d2): prove canonical profile equivalence"
```

## Задача 2.8 — приёмка d2

Требуемые метрики:

```text
runtime_constraint_kinds = 3
runtime_constraint_kind_names = integration,primitive_relation,size_rules
relation descriptors = 10
FactRef sources = 4
```

- [ ] Повторить полный self-hosting и canonical metrics.
- [ ] Проверить, что `repo-policy.json` по-прежнему использует свои пять `change_profiles` и проходит без dedicated evaluator.
- [ ] Ready-state exact-head gate, merge, post-merge `CI`.
- [ ] Записать accepted checkpoint в #398.

---

# Часть III — C3.3d3: `size_rules` через канонические факты

## Задача 3.0 — открыть d3 только от accepted d2

- [ ] Создать child issue только после post-merge зелёного d2:

```text
[C3.3d3] Lower size rules through canonical repository and diff facts
```

- [ ] Зафиксировать exact new `main`.
- [ ] Цель issue:

```text
runtime kinds 3 -> 2
remaining = integration,primitive_relation
relation descriptors = 10
FactRef sources = 4
RepositoryFactSelector may grow by at most one finite kind, only if RED proves need
```

- [ ] Новая branch только от accepted d2 `main`, новый draft `PR`.

## Задача 3.1 — написать первый красный тест, который сначала проверяет необходимость acquisition extension

**Файл:** создать `tests/test-c3-3d3-size-rule-lowering.mjs`.

Тест должен иметь две группы.

### Группа A — канонический reader

- [ ] Попытаться выразить абсолютный file/directory size через текущий `FactRef` без нового selector.
- [ ] Зафиксировать красное доказательство, если словарь не умеет получить числовой current-state repository fact.
- [ ] Только этот красный разрешает добавить `repository.path_metric`.

Требуемые кейсы после реализации:

```text
tracked file line max
tracked file byte max
directory sum lines
directory file count
ignore patterns
changed-only file population
empty selected set -> deterministic zero where aggregate permits it
matching unreadable file -> fail closed
```

### Группа B — high-level `size_rules` lowering

Проверить:

```text
file lines absolute pass/fail
directory lines absolute pass/fail
file count absolute pass/fail
ignore patterns
file changed_only pass/fail
applies_to_change_types selected/not-selected
state phase only for unconditional all_tracked absolute max
transaction phase for max_growth
transaction phase for applies_to_change_types
transaction phase for file changed_only
line growth pass/fail
file-count growth pass/fail
negative max_growth
advisory violation remains non-blocking
blocking violation remains blocking
measurement failure fails closed
metric=files + file scope rejected before runtime
max_growth + file scope rejected before runtime
max_growth + bytes rejected before runtime
directory + changed_only rejected unless a simpler canonical proof is found
runtime program contains no size_rules kind
size-rules evaluator file absent after implementation
```

- [ ] Первый d3 коммит — только этот тест.
- [ ] Зафиксировать намеренно красный `CI`.

## Задача 3.2 — если доказано необходимо, добавить один `repository.path_metric`

**Основные файлы:**

- `src/document-facts.mts`;
- возможно `src/facts/input.mts`, только если canonical reader context реально не получает нужные current-state facts;
- `src/checks/relation-kernel.mts` менять запрещено, если не обнаружена отдельная ошибка вне утверждённого дизайна;
- сгенерированные `dist/document-facts.mjs`, при необходимости `dist/facts/input.mjs`.

Целевой union:

```ts
export type RepositoryFactSelector =
  | { kind: "anchor_values"; anchor_type: string }
  | {
      kind: "path_metric";
      patterns: readonly string[];
      ignore?: readonly string[];
      population: "tracked" | "changed";
      metric: "lines" | "bytes" | "files";
      aggregate: "max" | "sum";
    };
```

- [ ] `FactRef` для repository больше не должен принудительно иметь только `type: "string_set"`; тип должен быть конечным union, позволяющим `anchor_values -> string_set`, `path_metric -> scalar` без ослабления типизации до arbitrary value.
- [ ] Предпочтительно выразить это discriminated union внутри repository alternative, а не общий `type: DocumentFactType` без связи с selector.

- [ ] Минимально расширить `FactReadContext` только реально нужными inputs текущего состояния, например:

```ts
repositoryRoot?: string;
trackedFiles?: string[];
readFile?: (filePath: string) => unknown;
```

Точные имена сверить с accepted d2 source перед изменением и переиспользовать уже существующие поля, если они появились.

- [ ] Для `population=tracked` выбирать текущие tracked/non-deleted paths.
- [ ] Для `population=changed` выбирать изменённые non-deleted paths.
- [ ] Применять `patterns` и `ignore` существующими path-pattern utilities.
- [ ] `metric=files` не читает содержимое, возвращает count.
- [ ] `metric=lines|bytes` обязан прочитать каждый выбранный файл; `null`, исключение или невозможность чтения -> `document_read_error`, а не пропуск.
- [ ] `aggregate=sum` суммирует значения; пустое множество даёт 0.
- [ ] `aggregate=max` для пустого множества должно иметь заранее определённую безопасную семантику. Для size upper-bound удобно 0; это должно быть явно протестировано и не использовать `-Infinity`.
- [ ] Использовать один общий line-count helper. Если `countTextLines` удаляется вместе с size evaluator, перенести маленькую чистую функцию в `document-facts.mts` или подходящий repository utility; не создавать новый size subsystem.

- [ ] Focused reader tests:

```bash
node tests/test-document-facts-boundary.mjs
node tests/test-c3-3d3-size-rule-lowering.mjs
```

- [ ] Коммит acquisition отдельно:

```bash
git add src/document-facts.mts dist/document-facts.mjs tests/test-document-facts-boundary.mjs tests/test-c3-3d3-size-rule-lowering.mjs
# добавить facts/input только если реально изменён
git commit -m "refactor(c3.3d3): add canonical repository path metric"
```

Если RED закрывается без `path_metric`, эту задачу пропустить и зафиксировать в d3 issue, что новый selector не потребовался.

## Задача 3.3 — расширить существующий `diff.metric` только настолько, насколько требует growth

**Файл:** `src/document-facts.mts`.

Текущий selector до d3 имеет глобальные:

```text
new_docs
new_files
net_added_lines
```

- [ ] Сначала попытаться переиспользовать `net_added_lines` и changed path facts без расширения.
- [ ] Если scoped growth нельзя выразить, расширить существующий `metric` selector полями:

```ts
patterns?: readonly string[];
ignore?: readonly string[];
```

и конечным metric vocabulary только для реально нужной семантики, например:

```text
net_added_lines
net_files
```

- [ ] `net_files` считать как added minus deleted на выбранной поверхности.
- [ ] `net_added_lines` при наличии patterns/ignore считать diff line delta только для выбранных файлов.
- [ ] Существующие top-level budgets без patterns должны сохранить прежнее поведение.
- [ ] Не вводить второй diff source или snapshot subsystem.

## Задача 3.4 — сузить публичную `size_rule` схему до реально поддерживаемого поднабора

**Файл:** `schemas/repo-policy.schema.json`.

- [ ] Сохранить публичные поля, которые canonical lowering поддерживает.
- [ ] Добавить schema/semantic ограничения так, чтобы до runtime отвергались:

```text
scope=file + metric=files
scope=file + max_growth
metric=bytes + max_growth
scope=directory + count=changed_only
```

Последнюю форму можно сохранить только если test-first работа нашла простое выражение существующими facts/relations без нового conditional acquisition mode. По утверждённому дизайну default — reject.

- [ ] Для `max`/`max_growth` сохранить текущие числовые диапазоны, включая отрицательный `max_growth`, если схема это уже допускает.
- [ ] Не добавлять deprecated aliases.

- [ ] В `tests/validate-schemas.mjs` добавить явные negative regression cases для всех удалённых комбинаций.

## Задача 3.5 — скомпилировать абсолютные `size_rules` в `primitive_relation`

**Файл:** `src/checks/constraint-program.mts`.

- [ ] Сохранить существующий strictness IR для size rule entity/shape/max/level/count/ignore/max_growth. Runtime lowering и policy strictness — разные обязанности; удаление evaluator не должно ослабить governance сравнение политики.

- [ ] Для `scope=file` использовать `repository.path_metric`:

```text
population = all_tracked ? tracked : changed
metric = lines|bytes
aggregate = max
patterns = [glob || "**"]
ignore = policy.paths.operational_paths + rule.ignore
```

затем:

```text
numeric_bound(max = rule.max)
```

- [ ] Для `scope=directory` абсолютный max:

```text
population = tracked
metric = lines|bytes|files
aggregate = sum
```

- [ ] Если `applies_to_change_types` существует и текущий `change_type` не входит в список — не создавать runtime relation.
- [ ] Если входит — relation phase = transaction.
- [ ] Unconditional `all_tracked` absolute relation phase = state.
- [ ] `changed_only` file absolute relation phase = transaction.

## Задача 3.6 — скомпилировать growth через `diff` fact + `numeric_bound`

- [ ] Для `max_growth` создать отдельную primitive relation с phase `transaction`.
- [ ] `metric=lines` -> scoped `diff.metric(net_added_lines)`.
- [ ] `metric=files` -> scoped `diff.metric(net_files)`.
- [ ] parameters `{ max: rule.max_growth }`.
- [ ] Никаких `before/after/delta` специальных объектов не требуется для истинности. Диагностика должна показать actual delta, bound и origin `size_rule:<id>`.

## Задача 3.7 — сделать `advisory` общей метаинформацией исполнения

Сначала проверить accepted d2 архитектуру: есть ли уже общий level/origin metadata path у canonical runtime/reporting.

- [ ] Если есть — переиспользовать.
- [ ] Если нет — минимально расширить `primitiveRuntime`/`RuntimeConstraint` метаданными:

```ts
level?: "blocking" | "advisory";
origin?: string;
```

- [ ] `level` не передавать в `evaluatePrimitiveRelation` как semantic parameter.
- [ ] Сначала relation возвращает обычное `ok`/diagnostics; затем общий constraints/reporting layer решает, превращается ли нарушение в blocking или advisory result.
- [ ] Удалить специальное имя `size-rules-advisory` как semantic side channel, если reporting может выразить origin/level канонически.
- [ ] Добавить focused test: одно и то же ложное relation при `blocking` блокирует, при `advisory` остаётся нарушением, но не блокирует exit.

## Задача 3.8 — удалить dedicated `size_rules` evaluator

**Файлы:**

- изменить `src/checks/rules/constraints.mts`;
- изменить `src/checks/constraint-program.mts`;
- удалить `src/checks/rules/size-rules.mts`;
- сборкой удалить `dist/checks/rules/size-rules.mjs`.

Удалить:

```text
SizeRule import
checkSizeRules import
projectSizeRules
size_rules runtime kind
size_rules fixed phase
size_rules dispatch
size-rules-advisory special branch
```

- [ ] После удаления `constraints.mts` должен знать только два runtime kinds:

```ts
type RuntimeConstraintKind =
  | "integration"
  | "primitive_relation";
```

- [ ] `CONSTRAINT_PHASES` после этого содержит только `integration`, если generic primitive phase берётся из descriptor/instance.

- [ ] Собрать:

```bash
npm run build
npm run check:dist
node tests/test-c3-3d3-size-rule-lowering.mjs
```

## Задача 3.9 — мигрировать старые size tests и пример

**Основные файлы:**

- `tests/test-compression-rules.mjs`;
- `tests/test-execution-phases.mjs`;
- `tests/test-policy-delta-rules.mjs`;
- `tests/test-self-hosting.mjs`;
- `tests/test-structured-output.mjs`;
- `tests/validate-schemas.mjs`;
- `examples/size-rules-policy.json`;
- `README.md` при наличии описания удалённой комбинации.

- [ ] Удалить direct import `checkSizeRules`.
- [ ] Перенести полезные line/file growth cases на canonical program/evaluator.
- [ ] Сохранить strictness tests `size_rule_max_increased`, `max_growth` weakening и т. п.
- [ ] Обновить `examples/size-rules-policy.json`, если там есть теперь неподдерживаемая комбинация; не менять публичный пример без необходимости.
- [ ] Self `repo-policy.json` должен остаться семантически тем же, если его три правила входят в сохранённый поднабор. Если одна из собственных форм оказывается удаляемой, остановить работу и вынести это как отдельное design discrepancy вместо молчаливого изменения self-policy.

- [ ] Полный поиск:

```bash
git grep -n -I -E 'checkSizeRules|size_rules|size-rules.mjs|changed_only|max_growth' -- tests examples README.md src dist repo-policy.json
```

`size_rules` как public high-level syntax может остаться; запрещены dedicated runtime kind/import/evaluator.

## Задача 3.10 — финальная приёмка C3.3d

- [ ] Новый архитектурный тест должен доказать:

```text
runtime_constraint_kinds = 2
runtime_constraint_kind_names = integration,primitive_relation
relation descriptors = 10
FactRef sources = 4
FactRef models = 1
primitive descriptor registries = 1
surface_debt absent public/runtime
registry_rules absent public/runtime
change_profile dedicated runtime absent
size_rules dedicated runtime absent
src/dist change-profiles evaluator absent
src/dist registry-rules evaluator absent
src/dist size-rules evaluator absent
integration unchanged
```

- [ ] Если `repository.path_metric` был добавлен, проверить, что `RepositoryFactSelector` имеет ровно два конечных вида:

```text
anchor_values
path_metric
```

- [ ] Проверить, что relation descriptors не выросли:

```bash
node tests/test-canonical-relation-kernel.mjs
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

- [ ] Полный набор:

```bash
npm run check:dist
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
```

- [ ] Проверить физическое сжатие `src + schemas` относительно базовой точки; рост новых acquisition lines должен быть перекрыт удалением трёх dedicated evaluator modules и debt runtime.
- [ ] Финальный `git grep` не должен находить старые runtime identifiers вне отрицательных regression tests и исторических design/plan docs.

- [ ] Ready-state exact-head `CI`.
- [ ] Merge exact head.
- [ ] Post-merge `CI` на `main`.
- [ ] Закрыть d3 issue.
- [ ] Закрыть #398 как выполненную только после доказательства runtime `integration + primitive_relation`.
- [ ] Обновить #374 checkpoint:

```text
C3.3d accepted:
surface_debt deleted
registry_rules deleted
change_profiles pure-lowered
size_rules pure-lowered
runtime kinds 6 -> 2
relation descriptors = 10
FactRef sources = 4
next = C3.3e integration / parallel convergence audit
```

---

# Запреты на всём C3.3d

Ни один срез не имеет права добавлять:

```text
new FactRef source
new relation descriptor
second evaluator
second FactStore
arbitrary expression language
compatibility alias
legacy runtime path
methodology-specific canonical primitive
integration semantic redesign
parallel/control-plane redesign
```

`repository.path_metric` — единственное заранее допустимое потенциальное расширение selector vocabulary, и только после красного доказательства d3.

Если при реализации обнаруживается, что утверждённая семантика требует чего-то большего, работу остановить на красном доказательстве и обновить #398; не расширять архитектуру молча.

---

# Контроль документов и бюджета

В design `PR` #399 создаются ровно два новых документа C3.3d:

```text
docs/superpowers/specs/2026-09-08-c3-3d-runtime-tail-convergence-design.md
docs/superpowers/plans/2026-09-08-c3-3d-runtime-tail-convergence.md
```

Это исчерпывает текущий `max_new_docs = 2` для этого изменения. Не создавать третий итоговый документ. Accepted evidence хранить в #398, дочерних issues, PR и существующем spec/plan.

---

# Финальная проверка плана перед исполнением

- [ ] Нет `TODO`, `TBD`, `placeholder` или неразрешённых архитектурных решений.
- [ ] d1 удаляет, а не заменяет `surface_debt`/`registry_rules`.
- [ ] d2 не добавляет selector/primitive и сохраняет overlap/governance/unclassified/new-file semantics.
- [ ] d3 сначала доказывает необходимость acquisition extension, затем использует максимум один новый repository selector.
- [ ] Неподдерживаемые size combinations отвергаются до runtime.
- [ ] Advisory/blocking не становится второй семантикой relation evaluator.
- [ ] `integration` остаётся нетронутым до C3.3e.
- [ ] Все метрики сравниваются только с `92432809fcddc290080beb51ba151e13a5761869`.
- [ ] Каждый следующий срез начинается только после принятия предыдущего.