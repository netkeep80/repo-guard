# C3.2 — план реализации структурного сжатия

> **Для агентных исполнителей:** обязательный дополнительный навык — `superpowers:executing-plans` либо `superpowers:subagent-driven-development`. Шаги отмечаются флажками и выполняются по TDD.

**Цель:** заменить N²-понижение `contract_conformance.cochange` на одну универсальную `cochange_group`, удалить обратное распознавание ролей из канонического ядра и сохранить независимые направленные `cochange_rules`.

**Архитектура:** высокоуровневый пакет остаётся только в `policy-profiles.mts` и понижает роли в канонические пути. Каноническая политика получает `cochange_groups`; `constraint-program.mts` создаёт семантическую identity и strictness по `id`, а существующий evaluator исполняет all-or-none семантику как ещё один runtime kind. Новых модулей и второй evaluator не создаётся.

**Стек:** TypeScript `.mts`, ESM `.mjs`, Node.js 20+, Ajv draft-07, GitHub Actions.

**Спецификация:** `docs/superpowers/specs/2026-09-07-c3-2-structural-compression-design.md`

## Общие ограничения

- `main` защищён; все изменения идут через issue #373 и PR.
- `contract_conformance` после понижения не оставляет role vocabulary в canonical core.
- Для N ролей создаётся ровно одна `cochange_group` и ноль generated directed edges.
- Независимые `cochange_rules` сохраняют существующую implication-семантику.
- Identity группы: `cochange-group:<id>`.
- Изменение `members` сравнивается как `equal_or_incomparable`; удаление группы — relaxation.
- `cochange_group` выполняется в transaction phase.
- Никаких legacy aliases/adapters и никаких изменений package version/release/Pages/CI optimization.

---

### Задача 1: RED-контракт архитектуры и поведения

**Файлы:**
- Изменить: `tests/test-generated-cochange-identity.mjs`
- Создать: `tests/test-cochange-group.mjs`

**Интерфейсы:**
- Использует: `resolvePolicyProfile`, `compareConstraintPrograms`, `evaluateConstraintIR`.
- Доказывает: `cochange_groups`, identity по `id`, all-or-none runtime, отсутствие role vocabulary в canonical core.

- [ ] **Шаг 1: заменить тест generated-edge identity на falsifier чистого lowering**

Тест должен построить macro с пятью ролями и проверить:

```js
const resolved = resolvePolicyProfile(macroSource()).policy;
assert.equal(resolved.cochange_groups.length, 1);
assert.equal(resolved.cochange_groups[0].id, "contract-conformance");
assert.equal(resolved.cochange_groups[0].members.length, 5);
assert.equal(resolved.cochange_rules.length, 0);
```

Также статически прочитать `src/checks/constraint-program.mts` и запретить:

```js
for (const token of [
  "ContractConformanceRole",
  "CONTRACT_CONFORMANCE_DOCUMENT_ROLES",
  "contractConformanceRolesByPath",
  "cochangeRoleEdge",
  "generatedContractConformanceCochange",
  "current.contract",
  "current.conformance",
  "previous.contract",
  "previous.conformance",
  "acceptance",
]) assert.doesNotMatch(core, new RegExp(token.replaceAll(".", "\\.")));
```

- [ ] **Шаг 2: добавить RED runtime matrix для generic group**

Минимальная policy:

```js
const policy = {
  paths: { canonical_docs: [], operational_paths: [] },
  cochange_groups: [{ id: "pair", members: ["a.json", "b.json", "c.json"] }],
};
```

Проверки:

```text
[]                  -> PASS
[a.json]            -> FAIL
[a.json,b.json]     -> FAIL
[a.json,b.json,c.json] -> PASS
```

- [ ] **Шаг 3: проверить RED через Actions**

После commit открыть draft PR и ожидать падение `validate` именно потому, что `cochange_groups` ещё не поддерживается/не генерируется. `smoke-pack` может оставаться зелёным.

- [ ] **Шаг 4: commit**

```bash
git add tests/test-generated-cochange-identity.mjs tests/test-cochange-group.mjs
git commit -m "test(c3): falsify structural macro compression"
```

### Задача 2: публичная canonical schema и semantic validation

**Файлы:**
- Изменить: `schemas/repo-policy.schema.json`
- Изменить: `src/policy-compiler.mts`
- Изменить: `src/runtime/validation.mts`
- Изменить: соответствующие schema/compiler tests

**Интерфейсы:**
- Создать `compileCochangeGroupsPolicy(policy): SemanticDiagnostic[]`.
- `loadPolicyRuntimeFromObject` обязан включить эту проверку в semantic groups.

- [ ] **Шаг 1: добавить schema shape**

Каноническая структура:

```json
"cochange_groups": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["id", "members"],
    "additionalProperties": false,
    "properties": {
      "id": { "type": "string", "minLength": 1 },
      "members": {
        "type": "array",
        "items": { "type": "string", "minLength": 1 },
        "minItems": 2,
        "uniqueItems": true
      }
    }
  }
}
```

- [ ] **Шаг 2: добавить semantic compiler для canonical paths и unique ids**

Сигнатура:

```ts
export function compileCochangeGroupsPolicy(policy: PolicyProjection = {}): SemanticDiagnostic[]
```

Алгоритм:

```ts
const seen = new Set<unknown>();
for (const [index, raw] of list<LooseObject>(policy.cochange_groups).entries()) {
  const group = object(raw), id = group.id;
  if (seen.has(id)) errors.push({ id, index, message: `cochange_groups[${index}].id duplicates group "${id}"` });
  seen.add(id);
  for (const [memberIndex, member] of list(group.members).entries()) {
    try { normalizeDocumentFact(member, "repository_path"); }
    catch (error) { errors.push({ id, index, member_index: memberIndex, member, message: `cochange_groups[${index}].members[${memberIndex}] is invalid: ${(error as Error).message}` }); }
  }
}
```

- [ ] **Шаг 3: включить compiler в runtime validation**

```ts
["cochange group compilation", compileCochangeGroupsPolicy(policy), (error) => (error as { message: string }).message],
```

- [ ] **Шаг 4: проверить malformed/duplicate cases**

Тесты обязаны отвергать duplicate id, duplicate member, less-than-two members и некорректный repository path.

- [ ] **Шаг 5: commit**

```bash
git add schemas/repo-policy.schema.json src/policy-compiler.mts src/runtime/validation.mts tests
git commit -m "feat(c3): define canonical cochange groups"
```

### Задача 3: pure lowering `contract_conformance`

**Файлы:**
- Изменить: `src/policy-profiles.mts`
- Изменить: `tests/test-generated-cochange-identity.mjs`

**Интерфейсы:**
- `PolicyProjection` получает `cochange_groups?: unknown`.
- `expandContractConformancePolicy` генерирует одну группу `id: "contract-conformance"`.

- [ ] **Шаг 1: добавить collision validation для generated group id**

Если explicit `cochange_groups` уже содержит `contract-conformance`, compiler macro возвращает ошибку:

```ts
errors.push({
  field: "cochange_groups",
  message: "contract_conformance generated cochange group \"contract-conformance\" collides with explicit cochange_groups",
});
```

- [ ] **Шаг 2: удалить N² lowering**

Удалить:

```ts
for (const role of cochange)
  for (const peer of cochange)
    if (peer !== role) cochangeRules.push(...);
```

Заменить на:

```ts
const cochangeGroups = Array.isArray(base.cochange_groups) ? clone(base.cochange_groups) : [];
cochangeGroups.push({
  id: "contract-conformance",
  members: (macro.cochange as ContractRole[]).map((role) => rolePaths[role]).sort(),
});
base.cochange_groups = cochangeGroups;
```

- [ ] **Шаг 3: доказать, что explicit directed rules не затронуты**

При входном `cochange_rules: [{ if_changed:["src/**"], must_change_any:["tests/**"] }]` после macro lowering этот массив должен остаться ровно из одного исходного правила.

- [ ] **Шаг 4: commit**

```bash
git add src/policy-profiles.mts tests/test-generated-cochange-identity.mjs
git commit -m "refactor(c3): lower contract cochange to one group"
```

### Задача 4: canonical Constraint Program и runtime all-or-none

**Файлы:**
- Изменить: `src/checks/constraint-program.mts`
- Изменить: `src/checks/rules/constraints.mts`
- Изменить: `tests/test-cochange-group.mjs`
- Изменить: `tests/test-generated-cochange-identity.mjs`

**Интерфейсы:**

```ts
interface CochangeGroupProjection { id?: unknown; members?: unknown; }
```

Runtime shape:

```ts
{ kind: "cochange_group", name: `cochange-group:${id}`, members: string[] }
```

- [ ] **Шаг 1: удалить reverse-recognition machinery**

Из `constraint-program.mts` удалить полностью:

```text
ContractConformanceRole
CochangeRoleEdge
CONTRACT_CONFORMANCE_DOCUMENT_ROLES
contractConformanceRolesByPath
cochangeRoleEdge
generatedContractConformanceCochange
```

- [ ] **Шаг 2: добавить semantic group entries**

Для каждой группы:

```ts
const owner = `cochange-group:${id}`;
const members = array(group.members as string[]).map(canonicalDocumentPath).sort();
add(owner, { kind: "cochange_group", name: owner, members }, entity({
  owner,
  pointer: `/cochange_groups/${id}`,
  removeKind: "cochange_group_removed",
  removeBefore: { id, members },
  removeAfter: { present: false },
  removeMessage: `cochange group "${id}" removed`,
}));
add(`${owner}:shape`, null, exact({ members }, {
  owner,
  pointer: `/cochange_groups/${id}`,
  incomparableMessage: `cochange group "${id}" changed members`,
}));
```

Обычные `cochange_rules` оставить с их существующей positional identity, потому что это отдельная generic capability и её compression относится не к macro-generated identity.

- [ ] **Шаг 3: добавить runtime kind и transaction phase**

```ts
type RuntimeConstraintKind = ... | "cochange_group";
```

```ts
cochange_group: "transaction",
```

- [ ] **Шаг 4: реализовать all-or-none evaluator в существующем цикле**

```ts
function checkCochangeGroup(files, members) {
  const changed = members.filter((member) => selectPaths(files, [member]).length > 0);
  const missing = members.filter((member) => !changed.includes(member));
  return {
    ok: changed.length === 0 || changed.length === members.length,
    changed,
    missing,
  };
}
```

Диагностика FAIL должна содержать semantic id, `changed` и `missing`.

- [ ] **Шаг 5: обновить unknown projection**

`cochange_groups` должен удаляться из `unknownProjection`, потому что теперь это известная canonical поверхность Constraint Program.

- [ ] **Шаг 6: проверить identity/strictness**

Тесты:

```text
reorder groups -> equal
reorder members -> equal
remove group -> weaker + cochange_group_removed
change members -> incomparable
add group -> stricter
```

- [ ] **Шаг 7: commit**

```bash
git add src/checks/constraint-program.mts src/checks/rules/constraints.mts tests
git commit -m "feat(c3): execute semantic cochange groups"
```

### Задача 5: метрики, документация и generated dist

**Файлы:**
- Изменить: `scripts/compression-metrics.mjs`
- Изменить: `docs/architecture-compression-3-baseline.md`
- Изменить: `README.md` только если canonical public syntax перечислена там
- Изменить: `dist/**` только generated counterparts изменённых `.mts`
- Изменить: `tests/test-compression-3-baseline.mjs` либо отдельный C3.2 metric assertion

**Интерфейсы:**
- Метрики должны вычисляться из source, а не быть вручную заданными константами.

- [ ] **Шаг 1: добавить C3.2 machine metrics**

Проверить значения:

```text
contract_conformance_role_vocabulary_in_canonical_core = 0
generated_edge_recognition_helpers = 0
contract_conformance_cochange_constraints = 1
macro_generated_positional_identity = 0
high_level_pack_semantic_edit_sites_in_canonical_core = 0
```

- [ ] **Шаг 2: обновить публичную документацию**

Объяснить простую семантику:

```text
changed(members) = ∅ OR changed(members) = members
```

И явно отделить её от directed `cochange_rules`.

- [ ] **Шаг 3: сгенерировать dist штатной сборкой**

```bash
npm run build
npm run check:dist
```

Generated файлы не редактировать семантически вручную.

- [ ] **Шаг 4: полный verification**

```bash
npm test
npm run compression:metrics
npm run check:dist
```

После draft GREEN перевести PR в ready-for-review и потребовать реальный `Run PR policy check = success`, а не skipped.

- [ ] **Шаг 5: exact-head merge и post-merge evidence**

Перед merge заново проверить `main`, #373, exact PR head, `behind_by=0`, required checks и self-check. Merge только с `expected_head_sha`; после merge подтвердить новый `main`, merged PR и закрытие #373.
