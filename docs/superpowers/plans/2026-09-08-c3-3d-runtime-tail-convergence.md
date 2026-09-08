# C3.3d — план реализации сжатия оставшегося исполняемого хвоста

> **Для исполнителя:** перед рабочими изменениями обязателен навык `test-driven-development`, а перед утверждением завершения каждого среза — `verification-before-completion`. Каждый срез выполняется отдельным запросом на слияние от фактически принятого `main`.

**Цель:** убрать самостоятельные исполняемые виды `surface_debt`, `registry_rules`, `change_profile`, `size_rules`, сохранив полезные возможности только как чистое разворачивание в канонические факты и существующую алгебру отношений.

**Архитектура:** пользовательский высокоуровневый синтаксис может оставаться только там, где он полезен. После `compileConstraintProgram` семантика должна течь через один `FactRef`, десять канонических дескрипторов отношений и один исполнитель `primitive_relation`. C3.3d не меняет `integration`.

**Технологии:** `Node.js 24`, `TypeScript .mts`, сгенерированный `dist/*.mjs`, `JSON Schema draft-07`, встроенный `node:test`, собственный `repo-guard`, `GitHub Actions`.

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

- [ ] Перед каждым срезом заново прочитать `main`, родительскую задачу, дочернюю задачу и состояние открытых запросов на слияние.
- [ ] Ветвить следующий срез только от фактически принятого `main` после предыдущего среза.
- [ ] Первый коммит каждого исполняемого среза содержит только тесты и намеренно остаётся красным.
- [ ] Зафиксировать точную причину красного `CI`; красный должен доказывать отсутствие целевой архитектуры, а не случайную поломку окружения.
- [ ] Затем делать минимальное изменение рабочего кода и схем.
- [ ] Сгенерировать `dist` обычной сборкой; не редактировать его смысл вручную.
- [ ] Мигрировать старые тесты только после зелёного целевого теста.
- [ ] Выполнить полный набор тестов, самопроверку и метрики сжатия от канонической базовой точки.
- [ ] Держать запрос на слияние черновиком до полного зелёного состояния на точной голове.
- [ ] Перевести его в готовое состояние без изменения головы и получить успешный `Run PR policy check`.
- [ ] Слить только точную проверенную голову.
- [ ] Проверить полный `CI` уже на новом `main`.
- [ ] Только после этого создавать следующую дочернюю задачу и ветку.

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

Перед каждой записью в репозиторий дополнительно проверять точную голову и набор изменённых файлов. В среде без локального `git` эти факты брать через чтение `main`, головы ветки и сравнение коммитов в GitHub.

---

# Часть I — C3.3d1: удалить `surface_debt` и `registry_rules`

## Задача 1.1 — независимый красный архитектурный тест

**Файлы:**

- создать `tests/test-c3-3d1-runtime-tail-deletion.mjs`;
- пока не менять рабочий код, схемы, `dist` и старые тесты.

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

- [ ] Для проверки схем использовать реальные валидные базовые объекты и добавлять только удаляемое поле; текстовый поиск не заменяет проверку схемы.

Пример удаляемого `surface_debt`:

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

Пример удаляемого `registry_rules`:

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

До удаления рабочего кода проверки 1–7 и 11 должны быть красными, а инварианты 8–10 — зелёными.

- [ ] Запустить полный набор, чтобы подтвердить, что новый тест является единственным намеренным источником красного:

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
- соответствующие файлы в `dist/` получить обычной сборкой.

- [ ] Из `schemas/change-intent.schema.json` физически удалить свойство `surface_debt` целиком.
- [ ] Поскольку используется `additionalProperties: false`, старая форма после этого должна отвергаться автоматически.
- [ ] Не добавлять пометки устаревания, псевдонимы и отдельную ветвь совместимости.
- [ ] Из `ChangeIntentProjection` удалить `surface_debt?: unknown`.
- [ ] Удалить безусловное добавление:

```ts
add("surface-debt", {
  kind: "surface_debt",
  name: "surface-debt",
  debt: changeIntent?.surface_debt,
});
```

- [ ] В `src/checks/rules/constraints.mts` удалить:

```text
SurfaceDebt interface
calculateDiffGrowth import, if unused afterwards
surface_debt from RuntimeConstraintKind
surface_debt from CONSTRAINT_PHASES
debt field from RuntimeConstraint
checkSurfaceDebt
surface_debt dispatch branch
```

- [ ] Не менять `GovernanceGrant`, `diff_rules` и обычные бюджеты. Удаление `surface_debt` не должно давать новый способ обхода ограничений.

## Задача 1.3 — удалить публичный и исполняемый `registry_rules`

**Файлы:**

- изменить `schemas/repo-policy.schema.json`;
- изменить `src/checks/constraint-program.mts`;
- изменить `src/checks/rules/constraints.mts`;
- удалить `src/checks/rules/registry-rules.mts`;
- соответствующий `dist/checks/rules/registry-rules.mjs` удалить через обычную генерацию `dist`.

- [ ] Из `schemas/repo-policy.schema.json` удалить верхнеуровневое свойство `registry_rules`.
- [ ] Из `definitions` удалить `registry_source` и другие определения, которые используются только этим разделом. Перед удалением подтвердить отсутствие других ссылок поиском.
- [ ] Не переносить `markdown_section_links` в новый селектор.
- [ ] Из `ConstraintPolicyProjection` удалить `registry_rules?: unknown[]`.
- [ ] Удалить добавление исполняемой записи:

```ts
if (array(policy.registry_rules).length) {
  add("runtime:registry-rules", {
    kind: "registry_rules",
    name: "registry-rules",
    rules: policy.registry_rules,
  });
}
```

- [ ] В `constraints.mts` удалить импорт `checkRegistryRules`, вид `registry_rules`, его фазу и ветвь выполнения.
- [ ] Физически удалить `src/checks/rules/registry-rules.mts`.
- [ ] Не добавлять новую обёртку вокруг `compareSets`.

## Задача 1.4 — сборка и первый зелёный результат d1

- [ ] Собрать:

```bash
npm run build
npm run check:dist
```

- [ ] Проверить новый целевой тест:

```bash
node tests/test-c3-3d1-runtime-tail-deletion.mjs
```

- [ ] Проверить предыдущие храповики C3:

```bash
node tests/test-c3-3-historical-lowering.mjs
node tests/test-c3-3b-trace-anchor-lowering.mjs
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
node tests/test-canonical-relation-kernel.mjs
```

- [ ] Коммит удаления рабочего кода, схем и `dist`:

```bash
git add schemas/change-intent.schema.json schemas/repo-policy.schema.json
git add src/checks/constraint-program.mts src/checks/rules/constraints.mts
git add dist/checks/constraint-program.mjs dist/checks/rules/constraints.mjs
git add -u src/checks/rules/registry-rules.mts dist/checks/rules/registry-rules.mjs
git commit -m "refactor(c3.3d1): delete debt and registry runtimes"
```

## Задача 1.5 — мигрировать исторические тесты и пользовательские описания d1

Проверить и при необходимости изменить:

```text
tests/validate-schemas.mjs
tests/test-change-intent.mjs
tests/test-policy-compiler-boundary.mjs
tests/test-policy-delta-rules.mjs
tests/test-compression-rules.mjs
tests/test-execution-phases.mjs
tests/test-structured-output.mjs
README.md
RELEASING.md
PORTFOLIO.md
examples/**
```

- [ ] Точный поиск:

```bash
git grep -n -I -E 'surface_debt|surface-debt|registry_rules|registry-rules|checkSurfaceDebt|checkRegistryRules|markdown_section_links|set_equality' -- \
  tests README.md RELEASING.md PORTFOLIO.md examples schemas src
```

- [ ] Удалить тесты поведения удалённых исполнителей.
- [ ] Вместо них оставить явные отрицательные проверки схем:

```text
surface_debt rejected
registry_rules rejected
```

- [ ] Не добавлять пользовательские разделы об устаревании. История остаётся в системе контроля версий и задачах.
- [ ] Если старая #35 относится только к `surface_debt`, после принятия d1 закрыть её как поглощённую удалением концепта.

- [ ] Полный тест:

```bash
npm test
```

- [ ] Коммит миграции:

```bash
git add tests README.md RELEASING.md PORTFOLIO.md examples
git commit -m "test(c3.3d1): enforce deleted public concepts"
```

Добавлять только реально изменённые файлы.

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

- [ ] Полная самопроверка:

```bash
npm run check:dist
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
```

- [ ] Проверить набор изменённых файлов: `repo-policy.json`, `.github/**`, `action.yml` и семантика `integration` не должны меняться.
- [ ] Дождаться зелёного `CI` в черновом состоянии.
- [ ] Перевести запрос на слияние в готовое состояние без изменения точной головы.
- [ ] Убедиться, что `validate`, `smoke-pack`, `Run PR policy check` зелёные на одной голове.
- [ ] Слить только эту голову.
- [ ] Проверить `CI` после слияния на новом `main`.
- [ ] Закрыть #400 как выполненную, если это не сделал `Fixes #400`.
- [ ] Записать в #398 принятую контрольную точку: `6 -> 4`, десять дескрипторов, четыре источника `FactRef`.

---

# Часть II — C3.3d2: чистое разворачивание `change_profiles`

## Задача 2.0 — открыть работу только от принятого d1

- [ ] Заново прочитать новый `main` после d1 и записать его точный хеш в новую дочернюю задачу.
- [ ] Создать дочернюю задачу с названием:

```text
[C3.3d2] Pure-lower change profiles into canonical diff relations
```

- [ ] В ней зафиксировать цель:

```text
runtime kinds 4 -> 3
remaining = size_rules,integration,primitive_relation
relation descriptors = 10
FactRef sources = 4
new selector = NONE
```

- [ ] Создать ветку только от нового принятого `main`; не переиспользовать ветку проекта C3.3d1.
- [ ] Открыть черновой запрос на слияние с `Fixes #<d2 issue>` и узким `ChangeIntent`.

## Задача 2.1 — красный тест эквивалентности и архитектуры

**Файл:** создать `tests/test-c3-3d2-change-profile-lowering.mjs`.

- [ ] Новый тест не использует `checkChangeProfile` как целевой механизм. Он строит политику и `ChangeIntent`, вызывает каноническую компиляцию/оценку и проверяет итоговое решение.

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

- [ ] До изменения рабочего кода тест должен быть красным прежде всего из-за отсутствия чистого разворачивания и наличия отдельного вида `change_profile`.
- [ ] Хранить небольшие исходные данные прямо в тесте; не создавать новый каркас тестовых данных.
- [ ] Коммит только теста:

```bash
git add tests/test-c3-3d2-change-profile-lowering.mjs
git commit -m "test(c3.3d2): falsify change-profile lowering"
```

- [ ] Зафиксировать красный `CI` в дочерней задаче d2.

## Задача 2.2 — типизированное представление профилей в `constraint-program`

**Файлы:**

- изменить `src/checks/constraint-program.mts`;
- при необходимости изменить только проверку ссылочной целостности в `src/policy-compiler.mts`;
- ядро отношений не менять.

- [ ] Заменить `change_profiles?: unknown` минимальными типизированными представлениями:

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

- [ ] Добавить соответствующие отображения `surfaces`, `new_file_classes`, `change_profiles` в `ConstraintPolicyProjection`.
- [ ] Добавить `change_type?: string` в `ChangeIntentProjection`, если на принятом d1 его там ещё нет.
- [ ] Не добавлять новый источник или селектор `FactRef`.
- [ ] Использовать существующие конструкции:

```text
diff.changed_paths(patterns, mode, exclude_statuses)
diff.metric(new_docs|new_files|net_added_lines)
numeric_bound(min|max)
```

## Задача 2.3 — чистое разворачивание поверхностей

В `compileConstraintProgram`:

- [ ] Если `policy.change_profiles` отсутствует, ничего не добавлять.
- [ ] Если `change_type === "governance"`, не создавать ограничения профиля.
- [ ] Если профили существуют, а `change_type` отсутствует, завершать компиляцию запрещающей диагностикой через существующую границу компилятора, не создавая нового исполняемого вида.
- [ ] Если ненормативный `change_type` неизвестен, аналогично закрывать проверку до исполнения.

Для выбранного профиля:

`forbid_surfaces`:

```text
diff.changed_paths(patterns = surface patterns, exclude deleted)
  -> numeric_bound(max = 0)
```

`require_surfaces`:

```text
diff.changed_paths(patterns = surface patterns, exclude deleted)
  -> numeric_bound(min = 1)
```

`allow_surfaces`:

- [ ] Вычислить все объявленные поверхности, которых нет в разрешённом наборе.
- [ ] Для каждой такой поверхности создать отдельный `numeric_bound(max=0)`.
- [ ] Не заменять это проверкой «путь входит хотя бы в одну разрешённую поверхность», потому что она ломает семантику пересечений.

`allow_unclassified_surfaces = false`:

- [ ] Создавать запрет только если профиль реально задаёт хотя бы одно из `require_surfaces`, `allow_surfaces`, `forbid_surfaces`.

```text
diff.changed_paths(
  patterns = union(all declared surface patterns),
  mode = outside,
  exclude deleted
)
  -> numeric_bound(max = 0)
```

## Задача 2.4 — чистое разворачивание новых файлов

- [ ] Если `new_files` отсутствует, не создавать ограничений классов.
- [ ] Если блок присутствует, добавленные пути проверять относительно всех `new_file_classes`.

Для каждого класса, не входящего в `allow_classes`:

```text
diff.changed_paths(
  patterns = class patterns,
  exclude_statuses = modified,deleted
)
  -> numeric_bound(max = 0)
```

Текущий `DiffFileStatus` на принятой базе имеет ровно:

```text
modified
added
deleted
```

Поэтому выбор только добавленных файлов выражается существующим `exclude_statuses = ["modified", "deleted"]`; новый селектор ради этого не нужен.

Неклассифицированный добавленный путь:

```text
diff.changed_paths(
  patterns = union(all new-file class patterns),
  mode = outside,
  exclude_statuses = modified,deleted
)
  -> numeric_bound(max = 0)
```

`max_per_class[class]`:

```text
added paths matching class
  -> numeric_bound(max = configured limit)
```

`new_files.max_new_files`:

```text
diff.metric(new_files)
  -> numeric_bound(max = configured limit)
```

## Задача 2.5 — развернуть бюджеты профиля

Использовать те же канонические метрики изменения, что и верхнеуровневые `diff_rules`:

```text
max_new_docs -> diff.metric(new_docs, exclude_paths=canonical_docs)
max_new_files -> diff.metric(new_files)
max_net_added_lines -> diff.metric(net_added_lines)
```

Каждая метрика проверяется через `numeric_bound(max=...)`.

- [ ] Не дублировать вычисление роста строк вручную.
- [ ] Не использовать `classifyNewFiles` или `detectTouchedSurfaces` как отдельный семантический исполнитель решения.

## Задача 2.6 — удалить отдельный исполнитель `change_profile`

**Файлы:**

- изменить `src/checks/rules/constraints.mts`;
- удалить `src/checks/rules/change-profiles.mts`;
- удалить соответствующий `dist/checks/rules/change-profiles.mjs` обычной сборкой;
- изменить `src/checks/constraint-program.mts`.

- [ ] Удалить добавление `runtime:change-profile`.
- [ ] Удалить импорт `checkChangeProfile`.
- [ ] Удалить `change_profile` из `RuntimeConstraintKind`, `CONSTRAINT_PHASES` и ветви выполнения.
- [ ] Если `facts.derived` после этого больше не нужен этой семье ограничений, убрать его из локального представления. Не удалять получение производных фактов глобально, пока отдельный аудит не докажет отсутствие других потребителей.

- [ ] Собрать и выполнить целевой тест:

```bash
npm run build
npm run check:dist
node tests/test-c3-3d2-change-profile-lowering.mjs
```

- [ ] Коммит рабочего разворачивания:

```bash
git add src/checks/constraint-program.mts src/checks/rules/constraints.mts
git add dist/checks/constraint-program.mjs dist/checks/rules/constraints.mjs
git add -u src/checks/rules/change-profiles.mts dist/checks/rules/change-profiles.mjs
# добавить policy-compiler только если он действительно изменён
git commit -m "refactor(c3.3d2): lower change profiles into relations"
```

## Задача 2.7 — мигрировать старые тесты профилей без потери семантики

Основные файлы:

```text
tests/test-policy-profiles.mjs
tests/test-compression-rules.mjs
tests/test-policy-compiler-boundary.mjs
tests/test-execution-phases.mjs
tests/test-structured-output.mjs
tests/test-self-hosting.mjs
```

- [ ] Удалить прямые импорты `checkChangeProfile`.
- [ ] Перенести полезные поведенческие случаи на `compileConstraintProgram` и канонические результаты отношений.
- [ ] Не сохранять старую форму диагностического объекта как контракт. Проверять решение, происхождение ограничения, выбранные факты и причину закрывающей ошибки.
- [ ] `repo-policy.json` не переписывать: тот же публичный `change_profiles` должен пройти самопроверку уже через новое разворачивание.

- [ ] Точный поиск:

```bash
git grep -n -I -E 'checkChangeProfile|change_profile|change-profiles.mjs' -- tests src dist
```

После миграции `change_profiles` допустим как публичный высокоуровневый синтаксис; `change_profile` как исполняемый вид и прямой импорт исполнителя запрещены.

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

- [ ] Повторить полный набор тестов, самопроверку и канонические метрики.
- [ ] Проверить, что `repo-policy.json` по-прежнему использует свои пять `change_profiles` и проходит без отдельного исполнителя.
- [ ] Получить зелёный `CI` на точной голове в готовом к проверке состоянии.
- [ ] Слить только эту голову и проверить `CI` после слияния.
- [ ] Записать принятую контрольную точку в #398.

---

# Часть III — C3.3d3: `size_rules` через канонические факты

## Задача 3.0 — открыть d3 только от принятого d2

- [ ] Создать дочернюю задачу только после зелёного `CI` на `main` после d2:

```text
[C3.3d3] Lower size rules through canonical repository and diff facts
```

- [ ] Зафиксировать точный новый `main`.
- [ ] Цель задачи:

```text
runtime kinds 3 -> 2
remaining = integration,primitive_relation
relation descriptors = 10
FactRef sources = 4
RepositoryFactSelector may grow by at most one finite kind, only if RED proves need
```

- [ ] Создать новую ветку только от принятого d2 `main` и новый черновой запрос на слияние.

## Задача 3.1 — первый красный тест: сначала доказать необходимость расширения получения фактов

**Файл:** создать `tests/test-c3-3d3-size-rule-lowering.mjs`.

Тест содержит две группы.

### Группа A — каноническое чтение фактов

- [ ] Попытаться выразить абсолютный размер файла/каталога через текущий `FactRef` без нового селектора.
- [ ] Зафиксировать красное доказательство, если текущий словарь не умеет получить числовой факт текущего состояния репозитория.
- [ ] Только этот красный результат разрешает добавить `repository.path_metric`.

Требуемые случаи после реализации:

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

### Группа B — разворачивание `size_rules`

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

- [ ] Первый коммит d3 содержит только этот тест.
- [ ] Зафиксировать намеренно красный `CI`.

## Задача 3.2 — при доказанной необходимости добавить один `repository.path_metric`

**Основные файлы:**

- `src/document-facts.mts`;
- при необходимости `src/facts/input.mts`, только если существующий контекст чтения действительно не предоставляет нужные факты текущего состояния;
- соответствующие файлы в `dist/`;
- ядро отношений не менять.

Целевой конечный тип:

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

- [ ] Вариант `repository` в `FactRef` должен оставаться конечным типизированным объединением: `anchor_values -> string_set`, `path_metric -> scalar`.
- [ ] Не ослаблять тип до произвольного значения.
- [ ] Предпочесть дискриминируемое объединение внутри варианта `repository`, чтобы тип результата был связан с видом селектора.
- [ ] Минимально расширить `FactReadContext` только реально нужными данными текущего состояния и переиспользовать существующие поля, если они уже появились к d3.
- [ ] Для `population=tracked` выбирать текущие отслеживаемые и не удалённые пути.
- [ ] Для `population=changed` выбирать текущие изменённые и не удалённые пути.
- [ ] Применять `patterns` и `ignore` существующими утилитами сопоставления путей.
- [ ] `metric=files` не читает содержимое и возвращает количество путей.
- [ ] `metric=lines|bytes` обязан прочитать каждый выбранный файл; `null`, исключение или невозможность чтения должны давать закрывающую ошибку чтения, а не молчаливый пропуск.
- [ ] `aggregate=sum` для пустого множества возвращает 0.
- [ ] `aggregate=max` для пустого множества также возвращает 0; не использовать `-Infinity`.
- [ ] Использовать одну маленькую общую функцию подсчёта строк. Если `countTextLines` удаляется вместе со старым исполнителем, перенести её в подходящую каноническую границу, не создавая новую подсистему размеров.

- [ ] Целевые проверки чтения:

```bash
node tests/test-document-facts-boundary.mjs
node tests/test-c3-3d3-size-rule-lowering.mjs
```

- [ ] Отдельный коммит получения факта:

```bash
git add src/document-facts.mts dist/document-facts.mjs
git add tests/test-document-facts-boundary.mjs tests/test-c3-3d3-size-rule-lowering.mjs
# добавить facts/input только если он действительно изменён
git commit -m "refactor(c3.3d3): add canonical repository path metric"
```

Если красный тест закрывается без `path_metric`, эту задачу пропустить и явно зафиксировать в d3, что новый селектор не потребовался.

## Задача 3.3 — расширить существующий `diff.metric` только при доказанной необходимости роста по области

**Файл:** `src/document-facts.mts`.

Текущий селектор до d3 имеет глобальные метрики:

```text
new_docs
new_files
net_added_lines
```

- [ ] Сначала попытаться переиспользовать `net_added_lines` и факты изменённых путей без расширения.
- [ ] Если рост по выбранной области нельзя выразить, расширить существующий селектор `metric` полями:

```ts
patterns?: readonly string[];
ignore?: readonly string[];
```

и конечным словарём метрик только для реально нужной семантики, например:

```text
net_added_lines
net_files
```

- [ ] `net_files` считать как число добавленных минус число удалённых файлов на выбранной поверхности.
- [ ] `net_added_lines` при наличии `patterns`/`ignore` считать разницу строк только для выбранных файлов.
- [ ] Существующие верхнеуровневые бюджеты без `patterns` должны сохранить прежнее поведение.
- [ ] Не вводить второй источник `diff` и отдельную подсистему снимков.

## Задача 3.4 — сузить публичную схему `size_rule` до реально поддерживаемого поднабора

**Файл:** `schemas/repo-policy.schema.json`.

- [ ] Сохранить поля, для которых каноническое разворачивание имеет однозначную семантику.
- [ ] Добавить ограничения схемы или семантического компилятора так, чтобы до исполнения отвергались:

```text
scope=file + metric=files
scope=file + max_growth
metric=bytes + max_growth
scope=directory + count=changed_only
```

Последнюю форму можно сохранить только если работа от красного теста найдёт простое выражение уже существующими фактами и отношениями без нового условного режима получения фактов. По утверждённому проекту исходное решение — отвергать её.

- [ ] Для `max` и `max_growth` сохранить текущие числовые диапазоны, включая отрицательный `max_growth`, если текущая схема его допускает.
- [ ] Не добавлять псевдонимы совместимости.
- [ ] В `tests/validate-schemas.mjs` добавить явные отрицательные проверки всех удалённых сочетаний.

## Задача 3.5 — скомпилировать абсолютные `size_rules` в `primitive_relation`

**Файл:** `src/checks/constraint-program.mts`.

- [ ] Сохранить существующую модель строгости для сущности `size_rule`: форма, `max`, `level`, `count`, `ignore`, `max_growth` остаются частью сравнения политики. Удаление отдельного исполнителя не должно ослабить контроль изменения политики.

Для `scope=file`:

```text
repository.path_metric(
  population = all_tracked ? tracked : changed,
  metric = lines|bytes,
  aggregate = max,
  patterns = [glob || "**"],
  ignore = operational_paths + rule.ignore
)
  -> numeric_bound(max = rule.max)
```

Для `scope=directory` абсолютный предел:

```text
repository.path_metric(
  population = tracked,
  metric = lines|bytes|files,
  aggregate = sum,
  patterns = [glob || "**"],
  ignore = operational_paths + rule.ignore
)
  -> numeric_bound(max = rule.max)
```

- [ ] Если `applies_to_change_types` существует и текущий `change_type` не входит в список, ограничение не создавать.
- [ ] Если входит, фаза отношения — `transaction`.
- [ ] Безусловный абсолютный `all_tracked` — фаза `state`.
- [ ] `changed_only` для файла — фаза `transaction`.

## Задача 3.6 — скомпилировать рост через факт `diff` и `numeric_bound`

- [ ] Для `max_growth` создать отдельную `primitive_relation` с фазой `transaction`.
- [ ] `metric=lines` использует ограниченную по области `diff.metric(net_added_lines)`.
- [ ] `metric=files` использует ограниченную по области `diff.metric(net_files)`.
- [ ] Параметр отношения:

```ts
{ max: rule.max_growth }
```

- [ ] Для истинности не нужны отдельные объекты `before/after/delta`. Диагностика должна показывать фактическую дельту, предел и происхождение `size_rule:<id>`.

## Задача 3.7 — сделать `advisory` общей метаинформацией исполнения

Сначала перечитать принятое состояние d2 и проверить, существует ли уже общий путь метаданных уровня и происхождения у канонического исполнения/отчётности.

- [ ] Если существует, переиспользовать его.
- [ ] Если нет, минимально расширить `primitiveRuntime`/`RuntimeConstraint` метаданными:

```ts
level?: "blocking" | "advisory";
origin?: string;
```

- [ ] `level` не передавать в `evaluatePrimitiveRelation` как семантический параметр.
- [ ] Отношение сначала вычисляет обычный результат `ok`; затем общий слой отчётности решает, блокирует ли нарушение принятие изменения.
- [ ] Удалить специальный побочный путь `size-rules-advisory`, если происхождение и уровень можно выразить общей метаинформацией.
- [ ] Добавить целевой тест: одно и то же ложное отношение при `blocking` блокирует, а при `advisory` остаётся нарушением, но не блокирует код выхода.

## Задача 3.8 — удалить отдельный исполнитель `size_rules`

**Файлы:**

- изменить `src/checks/rules/constraints.mts`;
- изменить `src/checks/constraint-program.mts`;
- удалить `src/checks/rules/size-rules.mts`;
- соответствующий `dist/checks/rules/size-rules.mjs` удалить обычной сборкой.

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

- [ ] После удаления `constraints.mts` должен знать только два вида:

```ts
type RuntimeConstraintKind =
  | "integration"
  | "primitive_relation";
```

- [ ] Для `primitive_relation` фаза продолжает браться из дескриптора или конкретной записи, а не из нового специального переключателя.

- [ ] Собрать:

```bash
npm run build
npm run check:dist
node tests/test-c3-3d3-size-rule-lowering.mjs
```

## Задача 3.9 — мигрировать старые тесты размеров и пример

Основные файлы:

```text
tests/test-compression-rules.mjs
tests/test-execution-phases.mjs
tests/test-policy-delta-rules.mjs
tests/test-self-hosting.mjs
tests/test-structured-output.mjs
tests/validate-schemas.mjs
examples/size-rules-policy.json
README.md
```

- [ ] Удалить прямой импорт `checkSizeRules`.
- [ ] Перенести полезные случаи роста строк/файлов на каноническую программу и единый исполнитель отношений.
- [ ] Сохранить проверки строгости `size_rule_max_increased`, ослабления `max_growth` и аналогичные.
- [ ] Обновить `examples/size-rules-policy.json`, только если он использует форму, которая теперь сознательно отвергается.
- [ ] Собственная `repo-policy.json` должна остаться семантически прежней, если её три правила входят в сохраняемый поднабор.
- [ ] Если хотя бы одна собственная форма оказывается удаляемой, остановить работу и зафиксировать расхождение проекта в #398; не менять собственную политику молча.

- [ ] Точный поиск:

```bash
git grep -n -I -E 'checkSizeRules|size_rules|size-rules.mjs|changed_only|max_growth' -- \
  tests examples README.md src dist repo-policy.json
```

`size_rules` может остаться как публичный высокоуровневый синтаксис; отдельный исполняемый вид, импорт и исполнитель запрещены.

## Задача 3.10 — финальная приёмка C3.3d

- [ ] Архитектурный тест должен доказать:

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

- [ ] Проверить, что дескрипторы отношений не выросли:

```bash
node tests/test-canonical-relation-kernel.mjs
npm run compression:metrics -- --compare 92432809fcddc290080beb51ba151e13a5761869
```

- [ ] Полная проверка:

```bash
npm run check:dist
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
```

- [ ] Проверить физическое сжатие `src + schemas` относительно базовой точки; прирост строк получения фактов должен быть перекрыт удалением отдельных исполнителей и `surface_debt`.
- [ ] Финальный поиск не должен находить старые исполняемые идентификаторы вне отрицательных тестов и исторических документов проекта.
- [ ] Получить зелёный `CI` на точной голове в готовом состоянии.
- [ ] Слить только эту голову.
- [ ] Проверить `CI` после слияния на `main`.
- [ ] Закрыть d3.
- [ ] Закрыть #398 только после доказательства состояния `integration + primitive_relation`.
- [ ] Обновить #374 контрольной точкой:

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

`repository.path_metric` — единственное заранее допустимое потенциальное расширение словаря селекторов, и только после красного доказательства d3.

Если при реализации обнаруживается, что утверждённая семантика требует чего-то большего, работу остановить на красном доказательстве и обновить #398; архитектуру молча не расширять.

---

# Контроль документов и бюджета

В #399 создаются ровно два новых документа C3.3d:

```text
docs/superpowers/specs/2026-09-08-c3-3d-runtime-tail-convergence-design.md
docs/superpowers/plans/2026-09-08-c3-3d-runtime-tail-convergence.md
```

Это исчерпывает текущий `max_new_docs = 2` для данного изменения. Третий итоговый документ не создавать. Принятые доказательства хранить в #398, дочерних задачах, запросах на слияние и существующих двух документах.

---

# Финальная проверка плана перед исполнением

- [ ] Нет незаполненных мест и неразрешённых архитектурных решений.
- [ ] d1 удаляет, а не заменяет `surface_debt` и `registry_rules`.
- [ ] d2 не добавляет селектор или примитив и сохраняет пересечения поверхностей, `governance`, неклассифицированные пути и семантику новых файлов.
- [ ] d3 сначала доказывает необходимость расширения получения фактов, затем использует максимум один новый селектор `repository`.
- [ ] Неподдерживаемые сочетания `size_rules` отвергаются до исполнения.
- [ ] `advisory`/`blocking` не становится второй семантикой исполнителя отношений.
- [ ] `integration` остаётся нетронутым до C3.3e.
- [ ] Все метрики сравниваются только с `92432809fcddc290080beb51ba151e13a5761869`.
- [ ] Каждый следующий срез начинается только после принятия предыдущего.