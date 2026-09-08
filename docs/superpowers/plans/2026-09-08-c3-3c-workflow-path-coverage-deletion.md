# C3.3c — план реализации удаления `workflow_path_coverage`

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ ПОДНАВЫК: использовать `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans` для выполнения этого плана по задачам. Шаги используют флажки (`- [ ]`) для отслеживания выполнения.

**Цель:** полностью удалить историческую форму `workflow_path_coverage` из публичной схемы, семантической компиляции и рабочего выполнения без нового примитива, источника `FactRef`, псевдонима совместимости или второй подсистемы доказательств.

**Архитектура:** срез является чистым удалением. `anchor_value_coverage` остаётся единственным видом `evidence_bindings` и по-прежнему понижается в существующее отношение `set_subset`; интеграционный извлекатель и команда `validate-integration` не меняются. Число рабочих видов ограничений должно уменьшиться с семи до шести при неизменных десяти дескрипторах отношений и четырёх источниках `FactRef`.

**Технологии:** `Node.js`, `TypeScript`, файлы `.mts`, модули `ESM`, `AJV`, встроенный `node:test`, `JSON Schema`, сгенерированный каталог `dist/**`, `GitHub Actions`.

**Спецификация:** `docs/superpowers/specs/2026-09-08-c3-3c-workflow-path-coverage-deletion-design.md`

## Глобальные ограничения

```text
Issue = #394
PR = #395
branch = c3/394-workflow-path-coverage-deletion
accepted base main = ae8aa89c5a780d4a33a70fbd7329d358f954b91d
approved design head = 198924037521776c980ce6c04ef61178550cec00

FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
primitive runtime shapes = 1
runtime constraint kinds: 7 -> 6

NO new relation descriptor
NO new FactRef source
NO glob/pattern relation
NO replacement evidence subsystem
NO compatibility alias
NO second evaluator
NO policy relaxation
NO changes to repo-policy.json
NO changes to .github/**
NO changes to action.yml
```

`docs/architecture-compression-3-baseline.md` является замороженным историческим срезом и не изменяется. `docs/architecture-compression-3-c3.3b.md` является записью принятого состояния C3.3b и также не переписывается.

Весь `PR` допускает не более двух новых документов. Первый — утверждённая спецификация, второй — этот план. Отдельный новый итоговый документ C3.3c не создаётся.

Перед каждым записывающим действием сверять вершину рабочей ветки и состояние `PR` #395. Если `main` продвинулся, не выполнять скрытое перебазирование: сначала заново проверить, что новый базовый переход не меняет архитектурные предпосылки #394.

---

## Карта файлов

### Создаётся

- `tests/test-c3-3c-workflow-path-coverage-deletion.mjs` — исполняемый отрицательный контракт C3.3c. До удаления он намеренно падает, после удаления становится постоянной защитой от возврата исторической формы.

### Изменяются

- `schemas/repo-policy.schema.json` — удаляет публичную альтернативу `workflow_path_coverage`, сохраняя `anchor_value_coverage`.
- `src/checks/constraint-program.mts` — перестаёт компилировать `evidence_workflow_path_coverage`; сохраняет понижение `anchor_value_coverage` в `primitive_relation` с `set_subset`.
- `src/policy-compiler.mts` — удаляет отдельную ссылочную семантику рабочего процесса, блокировки и эквивалентного `referenced_paths_exist` для исторической формы.
- `src/checks/rules/constraints.mts` — удаляет рабочий вид, фазу, специализированный вычислитель и диспетчеризацию покрытия путей.
- `src/checks/integration-constraints.mts` — удаляет `WorkflowPathCoverageBinding`, `checkWorkflowPathCoverage` и ставший ненужным импорт сопоставления шаблонов.
- `tests/test-policy-compiler-boundary.mjs` — удаляет позитивные тесты уже неподдерживаемой формы; тесты `anchor_value_coverage` сохраняются.
- `tests/validate-schemas.mjs` — закрепляет отказ старой формы на границе схемы.
- `docs/superpowers/specs/2026-09-08-c3-3c-workflow-path-coverage-deletion-design.md` — меняет только статус с проекта на утверждённую архитектуру.

### Генерируются сборкой

- `dist/checks/constraint-program.mjs`
- `dist/policy-compiler.mjs`
- `dist/checks/rules/constraints.mjs`
- `dist/checks/integration-constraints.mjs`

`scripts/compression-metrics.mjs` не изменяется: текущий измеритель уже считает `evidence_binding_kinds`, `runtime_constraint_kinds`, `runtime_constraint_kind_names`, дескрипторы отношений и источники фактов.

---

### Задача 1: зафиксировать целевое отсутствие исторической формы красным тестом

**Файлы:**
- Создать: `tests/test-c3-3c-workflow-path-coverage-deletion.mjs`
- Читать: `schemas/repo-policy.schema.json`
- Читать: `src/checks/constraint-program.mts`
- Читать: `src/policy-compiler.mts`
- Читать: `src/checks/rules/constraints.mts`
- Читать: `src/checks/integration-constraints.mts`
- Читать: `src/document-facts.mts`
- Читать: `src/init.mts`
- Читать: `repo-policy.json`

**Интерфейсы:**
- Использует: `compileConstraintProgram(policy, changeIntent?)`, `runtimeConstraints(program)`, `relationDescriptors()`.
- Создаёт: постоянный тест отсутствия старой формы и сохранения канонических инвариантов.

- [ ] **Шаг 1: получить полный список известных упоминаний**

```bash
git grep -n -I -E 'workflow_path_coverage|evidence_workflow_path_coverage|checkWorkflowPathCoverage|WorkflowPathCoverageBinding' -- ':!dist/**'
```

До удаления ожидаются содержательные упоминания в:

```text
schemas/repo-policy.schema.json
src/checks/constraint-program.mts
src/policy-compiler.mts
src/checks/rules/constraints.mts
src/checks/integration-constraints.mts
tests/test-policy-compiler-boundary.mjs
docs/architecture-compression-3-baseline.md
docs/architecture-compression-3-c3.3b.md
docs/superpowers/specs/2026-09-08-c3-3c-workflow-path-coverage-deletion-design.md
docs/superpowers/plans/2026-09-08-c3-3c-workflow-path-coverage-deletion.md
```

Исторические документы, спецификация и план не считаются рабочим программным интерфейсом. Если команда обнаружит дополнительный производственный потребитель или пример политики, которого нет в этой карте, остановить реализацию и сопоставить его с границей #394 до редактирования.

- [ ] **Шаг 2: создать красный тест**

Создать `tests/test-c3-3c-workflow-path-coverage-deletion.mjs`:

```js
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileConstraintProgram, runtimeConstraints } from "../dist/checks/constraint-program.mjs";
import { relationDescriptors } from "../dist/checks/relation-kernel.mjs";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf-8");
let failures = 0;

function expect(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS: ${label}`);
  } catch {
    failures++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

const schema = JSON.parse(read("schemas/repo-policy.schema.json"));
const evidenceKinds = (schema.definitions?.evidence_binding?.oneOf || [])
  .map((entry) => entry?.properties?.kind?.const)
  .filter((value) => typeof value === "string")
  .sort();
expect("public evidence binding vocabulary contains only anchor_value_coverage", evidenceKinds, ["anchor_value_coverage"]);

const basePolicy = {
  policy_format_version: "0.3.0",
  repository_kind: "tooling",
  paths: { forbidden: [], canonical_docs: [], operational_paths: [], governance_paths: [] },
  diff_rules: {},
  content_rules: [],
  cochange_rules: [],
};

const referencedPaths = {
  id: "owners-exist",
  kind: "referenced_paths_exist",
  source: {
    document: "contract",
    pointer: "/owners",
    projection: "object_values",
    type: "repository_path_set",
  },
};

const legacyPolicy = {
  ...basePolicy,
  integration: {
    workflows: [{
      id: "project-ci",
      kind: "github_actions",
      path: ".github/workflows/ci.yml",
      role: "ci_gate",
      expect: {
        events: ["pull_request"],
        enforcement: "blocking",
        disallow: ["continue_on_error"],
      },
    }],
  },
  document_relations: {
    documents: { contract: { path: "contracts/contract.json", format: "json" } },
    rules: [referencedPaths],
  },
  evidence_bindings: [{
    id: "owners-covered",
    kind: "workflow_path_coverage",
    source: referencedPaths.source,
    workflow: "project-ci",
    covers: ["tests/**"],
  }],
};

const legacyRuntime = runtimeConstraints(compileConstraintProgram(legacyPolicy));
expect(
  "constraint compiler emits no historical workflow coverage runtime",
  legacyRuntime.some((item) => item.kind === "evidence_workflow_path_coverage"),
  false,
);

const runtimeSource = read("src/checks/rules/constraints.mts");
expect(
  "runtime evaluator contains no workflow coverage kind or dedicated helper",
  runtimeSource.includes("evidence_workflow_path_coverage") || runtimeSource.includes("checkEvidenceWorkflowPathCoverage"),
  false,
);

const integrationSource = read("src/checks/integration-constraints.mts");
expect(
  "integration constraints contain no workflow path coverage evaluator",
  integrationSource.includes("checkWorkflowPathCoverage") || integrationSource.includes("WorkflowPathCoverageBinding"),
  false,
);

const policyCompilerSource = read("src/policy-compiler.mts");
expect(
  "semantic policy compiler contains no workflow path coverage branch",
  policyCompilerSource.includes("workflow_path_coverage"),
  false,
);

expect(
  "self-hosted repo policy does not consume workflow path coverage",
  read("repo-policy.json").includes("workflow_path_coverage"),
  false,
);
expect(
  "init does not generate workflow path coverage",
  read("src/init.mts").includes("workflow_path_coverage"),
  false,
);

const anchorPolicy = {
  ...basePolicy,
  anchors: {
    types: {
      case_evidence: {
        sources: [{ kind: "regex", glob: "tests/**", pattern: "CASE:([a-z-]+)" }],
      },
    },
  },
  document_relations: {
    documents: { conformance: { path: "contracts/conformance.json", format: "json" } },
    rules: [],
  },
  evidence_bindings: [{
    id: "cases-have-evidence",
    kind: "anchor_value_coverage",
    source: {
      document: "conformance",
      pointer: "/requiredCases",
      projection: "array_items",
      type: "string_set",
    },
    target_anchor_type: "case_evidence",
  }],
};
const anchorRuntime = runtimeConstraints(compileConstraintProgram(anchorPolicy));
const anchorCoverage = anchorRuntime.find((item) => item.relation_id === "evidence:cases-have-evidence");
expect("anchor value coverage remains primitive_relation", anchorCoverage?.kind, "primitive_relation");
expect("anchor value coverage remains set_subset", anchorCoverage?.primitive, "set_subset");
expect("relation descriptor count remains ten", relationDescriptors().length, 10);

const factSourceMatch = read("src/document-facts.mts").match(/export type FactSource = ([^;]+);/);
const factSources = factSourceMatch
  ? [...factSourceMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort()
  : [];
expect("FactRef source vocabulary remains the accepted four", factSources, [
  "change_intent",
  "diff",
  "document",
  "repository",
]);

console.log(`\n${failures === 0 ? "C3.3c workflow path coverage deletion contract passed" : `C3.3c deletion RED confirmed by ${failures} failing probe(s)`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Шаг 3: подтвердить намеренный красный результат**

```bash
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
```

Ожидаются ровно пять отказов:

```text
public evidence binding vocabulary contains only anchor_value_coverage
constraint compiler emits no historical workflow coverage runtime
runtime evaluator contains no workflow coverage kind or dedicated helper
integration constraints contain no workflow path coverage evaluator
semantic policy compiler contains no workflow path coverage branch
```

Проверки собственного `repo-policy.json`, `init`, `anchor_value_coverage`, десяти дескрипторов и четырёх источников `FactRef` должны уже проходить.

- [ ] **Шаг 4: проверить, что старые тесты не сломаны новым тестовым коммитом**

```bash
npm test
```

Ненулевой код должен объясняться только новым `test-c3-3c-workflow-path-coverage-deletion.mjs`.

- [ ] **Шаг 5: закоммитить только тест**

```bash
git add tests/test-c3-3c-workflow-path-coverage-deletion.mjs
git commit -m "test(c3.3c): falsify workflow path coverage deletion"
```

После публикации сохранить номер намеренно красного запуска в комментарии #394. Производственные файлы в этом коммите не менять.

---

### Задача 2: удалить публичную и исполняемую семантику

**Файлы:**
- Изменить: `schemas/repo-policy.schema.json`
- Изменить: `src/checks/constraint-program.mts`
- Изменить: `src/policy-compiler.mts`
- Изменить: `src/checks/rules/constraints.mts`
- Изменить: `src/checks/integration-constraints.mts`
- Сгенерировать: соответствующие файлы `dist/**/*.mjs`

**Интерфейсы:**
- Сохраняет: `compileEvidenceBindingsPolicy(policy)` для `anchor_value_coverage`.
- Сохраняет: `compileConstraintProgram(policy, changeIntent?)`, `runtimeConstraints(program)`.
- Сохраняет: `integrationConstraintEntries(integration)` и команду `validate-integration`.
- Удаляет: `WorkflowPathCoverageBinding`, `checkWorkflowPathCoverage`, `checkEvidenceWorkflowPathCoverage`, `evidence_workflow_path_coverage`.

- [ ] **Шаг 1: удалить первую альтернативу из схемы**

В `definitions.evidence_binding.oneOf` оставить только:

```json
{
  "type": "object",
  "required": ["id", "kind", "source", "target_anchor_type"],
  "additionalProperties": false,
  "properties": {
    "id": { "$ref": "#/definitions/non_empty_string" },
    "kind": { "const": "anchor_value_coverage" },
    "source": { "$ref": "#/definitions/document_string_set_selector" },
    "target_anchor_type": { "$ref": "#/definitions/non_empty_string" }
  }
}
```

Не сворачивать `oneOf`: существующий измеритель должен продолжить читать конечный набор без своего изменения.

- [ ] **Шаг 2: удалить историческую ветку из `compileEvidenceBindingsPolicy`**

Удалить `documentSelectorKey`, вычисление `pathExistenceSelectors`, карту `workflows` и ветку `binding.kind === "workflow_path_coverage"`.

Целевая функция:

```ts
export function compileEvidenceBindingsPolicy(policy: PolicyProjection = {}): SemanticDiagnostic[] {
  const bindings = list<LooseObject>(policy.evidence_bindings);
  if (!bindings.length) return [];
  const errors: SemanticDiagnostic[] = [], seenIds = new Set<unknown>();
  const relationSection = object(policy.document_relations), documents = object(relationSection.documents);
  const anchorTypes = new Set(Object.keys(object(policy.anchors?.types)));

  for (const [index, binding] of bindings.entries()) {
    const id = binding.id;
    if (seenIds.has(id)) errors.push({ evidence_binding: id, index, message: `evidence_bindings[${index}].id duplicates binding "${id}"` });
    seenIds.add(id);
    const source = object(binding.source), document = source.document;
    if (typeof document !== "string" || !Object.hasOwn(documents, document)) errors.push({ evidence_binding: id, document, message: `evidence binding "${id}" source references unknown document "${document}"` });

    if (binding.kind === "anchor_value_coverage") {
      const target = binding.target_anchor_type;
      if (typeof target !== "string" || !anchorTypes.has(target)) errors.push({ evidence_binding: id, target_anchor_type: target, message: `evidence binding "${id}" references unknown anchor type "${target}"` });
    }
  }
  return errors;
}
```

Не добавлять специальную ошибку совместимости: старый синтаксис должен отвергаться схемой.

- [ ] **Шаг 3: сузить представление привязки в `constraint-program`**

Из `EvidenceBindingProjection` удалить:

```ts
workflow?: unknown;
covers?: unknown;
```

Целевой цикл:

```ts
for (const binding of array(policy.evidence_bindings)) {
  const id = String(binding.id ?? ""), owner = `evidence-binding:${id}`, pointer = `/evidence_bindings/${id}`;
  const source = compileFactRef(binding.source, documents);
  const shape = { kind: binding.kind, source, target_anchor_type: binding.target_anchor_type };
  const runtime = binding.kind === "anchor_value_coverage"
    ? primitiveRuntime(owner, `evidence:${id}`, leftSubsetPrimitive, {
      left: source,
      right: repositoryAnchorFact(binding.target_anchor_type),
    })
    : null;
  add(owner, runtime, entity({ owner, pointer, removeKind: "evidence_binding_removed", evidence_binding_id: id,
    removeBefore: shape, removeAfter: { present: false }, removeMessage: `evidence binding "${id}" removed` }));
  add(`${owner}:shape`, null, exact(shape, { owner, pointer, evidence_binding_id: id, incomparableMessage: `evidence binding "${id}" changed semantics` }));
}
```

Идентичность `evidence-binding:<id>` и строгость `anchor_value_coverage` сохраняются.

- [ ] **Шаг 4: удалить рабочий вид из `constraints.mts`**

Целевой союз:

```ts
type RuntimeConstraintKind =
  | "surface_debt"
  | "size_rules"
  | "registry_rules"
  | "change_profile"
  | "integration"
  | "primitive_relation";
```

Удалить только старые поля:

```ts
binding_id?: string;
source?: FactRef;
workflow?: string;
covers?: string[];
```

Удалить `factOperand`, `checkEvidenceWorkflowPathCoverage`, фазу `evidence_workflow_path_coverage: "state"` и соответствующую ветку диспетчеризации.

Импорт фактов сузить до реально оставшегося типа:

```ts
import type { DocumentReader } from "../../document-facts.mjs";
```

Импорт интеграции сузить до:

```ts
import { integrationConstraintEntries } from "../integration-constraints.mjs";
```

- [ ] **Шаг 5: удалить helper из `integration-constraints.mts`**

Удалить:

```ts
export interface WorkflowPathCoverageBinding {
  workflow: string;
  covers: string[];
}
```

и всю функцию:

```ts
export function checkWorkflowPathCoverage(
  integration: IntegrationFacts,
  binding: WorkflowPathCoverageBinding,
  referencedPaths: string[]
)
```

После этого удалить:

```ts
import { matchesAny } from "../utils/path-patterns.mjs";
```

Не изменять `workflowDetails`, `parallelReadinessDetails`, `integrationConstraintEntries` и роли интеграции: это C3.3d.

- [ ] **Шаг 6: собрать и проверить `dist`**

```bash
npm run build
npm run check:dist
```

Ожидается:

```text
Generated dist is current.
```

- [ ] **Шаг 7: превратить новый тест в зелёный**

```bash
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
node tests/test-c3-3b-trace-anchor-lowering.mjs
```

Обе команды должны завершиться с кодом `0`; вторая доказывает сохранение `anchor_value_coverage -> set_subset` и десяти дескрипторов.

- [ ] **Шаг 8: закоммитить производственное удаление и свежий `dist`**

```bash
git add schemas/repo-policy.schema.json \
  src/checks/constraint-program.mts \
  src/policy-compiler.mts \
  src/checks/rules/constraints.mts \
  src/checks/integration-constraints.mts \
  dist/checks/constraint-program.mjs \
  dist/policy-compiler.mjs \
  dist/checks/rules/constraints.mjs \
  dist/checks/integration-constraints.mjs
git commit -m "refactor(c3.3c): delete workflow path coverage runtime"
```

---

### Задача 3: заменить тесты поддержки на тесты окончательного удаления

**Файлы:**
- Изменить: `tests/test-policy-compiler-boundary.mjs`
- Изменить: `tests/validate-schemas.mjs`

**Интерфейсы:**
- Сохраняет позитивные проверки `anchor_value_coverage`.
- Добавляет постоянную регрессионную проверку отказа старой формы на уровне схемы.
- Удаляет тесты, которые требуют существования старого интерфейса покрытия путей рабочего процесса.

- [ ] **Шаг 1: удалить исторические вспомогательные фикстуры**

Из `tests/test-policy-compiler-boundary.mjs` удалить полностью определения `ciWorkflow` и `evidencePolicy`.

Также удалить тест с именем:

```text
requires evidence bindings to reuse known blocking workflows and exact R2 existence selectors
```

и весь раздел:

```text
workflow path evidence public/runtime boundary
```

Не удалять `anchorEvidencePolicy` и раздел:

```text
anchor value evidence public/runtime boundary
```

- [ ] **Шаг 2: добавить явную регрессию схемы**

После проверки `evidence trace` в `tests/validate-schemas.mjs` добавить:

```js
expect("removed workflow_path_coverage rejected", policy({
  ...validPolicy,
  evidence_bindings: [{
    id: "legacy-workflow-coverage",
    kind: "workflow_path_coverage",
    source: {
      document: "contract",
      pointer: "/owners",
      projection: "object_values",
      type: "repository_path_set",
    },
    workflow: "project-ci",
    covers: ["tests/**"],
  }],
}), false);
```

- [ ] **Шаг 3: запустить узкие проверки**

```bash
node tests/validate-schemas.mjs
node tests/test-policy-compiler-boundary.mjs
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
node tests/test-c3-3b-trace-anchor-lowering.mjs
```

Все четыре команды должны завершиться с кодом `0`.

- [ ] **Шаг 4: запустить весь набор**

```bash
npm test
```

Ожидается полный зелёный результат. Если обнаружится ещё один тест, который требует `workflow_path_coverage`, сначала определить, является ли он исторической записью или текущим продуктовым потребителем. Псевдоним совместимости не добавлять.

- [ ] **Шаг 5: закоммитить миграцию тестов**

```bash
git add tests/test-policy-compiler-boundary.mjs tests/validate-schemas.mjs
git commit -m "test(c3.3c): enforce workflow coverage removal"
```

---

### Задача 4: доказать сжатие и синхронизировать утверждённую спецификацию

**Файлы:**
- Изменить: `docs/superpowers/specs/2026-09-08-c3-3c-workflow-path-coverage-deletion-design.md`
- Не изменять: `scripts/compression-metrics.mjs`
- Не изменять: `docs/architecture-compression-3-baseline.md`
- Не изменять: `docs/architecture-compression-3-c3.3b.md`

- [ ] **Шаг 1: изменить только статус спецификации**

Заменить:

```text
Статус: проект архитектуры для #394.
```

на:

```text
Статус: утверждённая архитектура C3.3c для #394; реализация ведётся в PR #395.
```

- [ ] **Шаг 2: проверить машинные метрики**

```bash
node scripts/compression-metrics.mjs > /tmp/c3-3c-metrics.json
node -e '
const m = JSON.parse(require("node:fs").readFileSync("/tmp/c3-3c-metrics.json", "utf8")).architecture;
const expectedKinds = ["change_profile","integration","primitive_relation","registry_rules","size_rules","surface_debt"];
const expectedSources = ["change_intent","diff","document","repository"];
const expectedEvidence = ["anchor_value_coverage"];
if (m.runtime_constraint_kinds !== 6) throw new Error(`runtime kinds = ${m.runtime_constraint_kinds}`);
if (JSON.stringify(m.runtime_constraint_kind_names) !== JSON.stringify(expectedKinds)) throw new Error(JSON.stringify(m.runtime_constraint_kind_names));
if (JSON.stringify(m.evidence_binding_kinds) !== JSON.stringify(expectedEvidence)) throw new Error(JSON.stringify(m.evidence_binding_kinds));
if (m.primitive_descriptor_kinds.length !== 10) throw new Error(`descriptors = ${m.primitive_descriptor_kinds.length}`);
if (JSON.stringify(m.canonical_fact_sources) !== JSON.stringify(expectedSources)) throw new Error(JSON.stringify(m.canonical_fact_sources));
if (m.canonical_factref_model_count !== 1) throw new Error(`FactRef models = ${m.canonical_factref_model_count}`);
if (m.primitive_descriptor_registry_count !== 1) throw new Error(`descriptor registries = ${m.primitive_descriptor_registry_count}`);
if (m.primitive_runtime_shape_count !== 1) throw new Error(`primitive runtime shapes = ${m.primitive_runtime_shape_count}`);
console.log("C3.3c architecture metrics passed");
'
```

Ожидается:

```text
C3.3c architecture metrics passed
```

- [ ] **Шаг 3: доказать отсутствие рабочей исторической семантики**

```bash
git grep -n -I -E 'workflow_path_coverage|evidence_workflow_path_coverage|checkWorkflowPathCoverage|WorkflowPathCoverageBinding' -- \
  schemas src tests examples README.md RELEASING.md PORTFOLIO.md
```

В `schemas/**`, `src/**`, `examples/**`, `README.md`, `RELEASING.md`, `PORTFOLIO.md` совпадений быть не должно. В тестах допустимы только строки, явно проверяющие удаление или отказ старого имени.

- [ ] **Шаг 4: выполнить полную проверку**

```bash
npm run check:dist
npm test
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
```

Все команды должны завершиться с кодом `0`.

- [ ] **Шаг 5: закоммитить изменение статуса документа**

```bash
git add docs/superpowers/specs/2026-09-08-c3-3c-workflow-path-coverage-deletion-design.md
git commit -m "docs(c3.3c): mark deletion design approved"
```

---

### Задача 5: провести `PR` через собственную политику и принять точную вершину

**Источник санкции:** Issue #394.

**Кандидат:** `PR` #395.

**Интерфейсы:**
- Использует `ChangeIntent` и `GovernanceGrant` из #394.
- Разрешает изменение только `schemas/repo-policy.schema.json` среди управляющих путей.
- Не допускает слияние вершины, которая не проходила готовую проверку.

- [ ] **Шаг 1: проверить чистоту ветки и точный набор файлов**

```bash
git status --short
git diff --stat ae8aa89c5a780d4a33a70fbd7329d358f954b91d...HEAD
git diff --name-only ae8aa89c5a780d4a33a70fbd7329d358f954b91d...HEAD
```

Требования:

```text
repo-policy.json absent
.github/** absent
action.yml absent
new docs count = 2
```

- [ ] **Шаг 2: выполнить финальную локальную проверку вершины**

```bash
npm run check:dist
npm test
node scripts/compression-metrics.mjs
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
```

- [ ] **Шаг 3: опубликовать вершину и сохранить её `SHA`**

```bash
git push origin c3/394-workflow-path-coverage-deletion
HEAD=$(git rev-parse HEAD)
echo "$HEAD"
```

Черновой `CI` должен иметь зелёные `validate` и `smoke-pack`. Пока `PR` остаётся черновым, шаг `Run PR policy check` может быть пропущен.

- [ ] **Шаг 4: перевести `PR` #395 в готовое состояние без изменения вершины**

```bash
gh pr ready 395 --repo netkeep80/repo-guard
READY_HEAD=$(gh pr view 395 --repo netkeep80/repo-guard --json headRefOid --jq .headRefOid)
test "$READY_HEAD" = "$HEAD"
```

- [ ] **Шаг 5: проверить собственную политику на том же `SHA`**

В запуске события `ready_for_review` должны быть зелёными как минимум:

```text
validate
smoke-pack
Run PR policy check
Verify generated dist freshness
Report architecture compression metrics
Validate repo-policy.json
Run validate-integration on self
Run doctor diagnostics on self
Run discovered test suite
Exercise advisory policy mode
```

Если собственная политика сообщает ослабление, не расширять `GovernanceGrant`: `allow_policy_relaxation` в #394 намеренно пуст.

- [ ] **Шаг 6: слить только проверенный `SHA`**

```bash
gh api --method PUT repos/netkeep80/repo-guard/pulls/395/merge \
  -f merge_method=merge \
  -f sha="$READY_HEAD"
```

Ответ должен сообщить успешное слияние. Если `SHA` изменился или операция отклонена, не повторять её без полной проверки нового состояния.

- [ ] **Шаг 7: проверить новый `main` и проверку после слияния**

```bash
git fetch origin main
git rev-parse origin/main
```

Новый `main` должен быть коммитом слияния, содержащим проверенный `READY_HEAD`. Проверка после слияния должна завершиться зелёными `validate` и `smoke-pack`.

- [ ] **Шаг 8: закрыть контрольный цикл**

Убедиться, что #394 закрыта как `completed` через `Fixes #394`, `PR` #395 имеет состояние `merged`, а #374 остаётся открытой.

В #374 зафиксировать только следующий итог:

```text
C3.3c accepted: workflow_path_coverage deleted without replacement; runtime kinds 7 -> 6; descriptors 10; FactRef sources 4. Next architectural subject: C3.3d integration convergence.
```

Не начинать C3.3d в этой ветке или `PR`.
