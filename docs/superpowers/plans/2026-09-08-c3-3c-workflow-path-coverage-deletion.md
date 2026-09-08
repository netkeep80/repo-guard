# C3.3c — план реализации удаления `workflow_path_coverage`

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ ПОДНАВЫК: использовать `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans` для выполнения этого плана по задачам. Шаги используют флажки (`- [ ]`) для отслеживания выполнения.

**Цель:** полностью удалить историческую форму `workflow_path_coverage` из публичной схемы, семантической компиляции и рабочего выполнения без нового примитива, источника `FactRef`, псевдонима совместимости или второй подсистемы доказательств.

**Архитектура:** срез является чистым удалением. `anchor_value_coverage` остаётся единственным видом `evidence_bindings` и по-прежнему понижается в существующее отношение `set_subset`; интеграционный извлекатель и команда `validate-integration` не меняются. Удаление должно уменьшить число рабочих видов ограничений с семи до шести при неизменных десяти дескрипторах отношений и четырёх источниках `FactRef`.

**Технологии:** `Node.js`, `TypeScript` в файлах `.mts`, модули `ESM`, `AJV`, встроенный `node:test`, исполняемая схема `JSON Schema`, сгенерированный каталог `dist/**`, `GitHub Actions`.

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

`docs/architecture-compression-3-baseline.md` является замороженным историческим срезом и не изменяется. `docs/architecture-compression-3-c3.3b.md` является записью принятого состояния C3.3b и также не переписывается. Весь PR допускает не более двух новых документов; первый — утверждённая спецификация, второй — этот план. Поэтому отдельный новый итоговый документ C3.3c не создаётся.

Перед каждым записывающим действием сверять вершину рабочей ветки и состояние PR #395. Если `main` продвинулся, не выполнять скрытое перебазирование: сначала заново проверить, что новый базовый переход не меняет архитектурные предпосылки #394.

---

## Карта файлов

### Создаётся

- `tests/test-c3-3c-workflow-path-coverage-deletion.mjs` — отдельный отрицательный контракт C3.3c; сначала даёт намеренный красный результат, после удаления становится постоянной защитой от возврата исторической формы.

### Изменяются в рабочей реализации

- `schemas/repo-policy.schema.json` — удаляет публичную альтернативу `workflow_path_coverage`, сохраняя `anchor_value_coverage`.
- `src/checks/constraint-program.mts` — перестаёт компилировать `evidence_workflow_path_coverage`; сохраняет понижение `anchor_value_coverage -> primitive_relation(set_subset)`.
- `src/policy-compiler.mts` — удаляет отдельную ссылочную семантику рабочего процесса, блокировки и эквивалентного `referenced_paths_exist` для исторической формы.
- `src/checks/rules/constraints.mts` — удаляет рабочий вид, фазу, специализированный вычислитель и диспетчеризацию покрытия путей.
- `src/checks/integration-constraints.mts` — удаляет `WorkflowPathCoverageBinding`, `checkWorkflowPathCoverage` и ставший ненужным импорт сопоставления шаблонов.
- `tests/test-policy-compiler-boundary.mjs` — удаляет позитивные тесты уже неподдерживаемой формы; тесты `anchor_value_coverage` сохраняются.
- `tests/validate-schemas.mjs` — закрепляет, что удалённая форма теперь отвергается на границе схемы.
- `docs/superpowers/specs/2026-09-08-c3-3c-workflow-path-coverage-deletion-design.md` — меняет статус с проекта на утверждённую архитектуру; архитектурное содержание не расширяется.

### Генерируются сборкой

- `dist/checks/constraint-program.mjs`
- `dist/policy-compiler.mjs`
- `dist/checks/rules/constraints.mjs`
- `dist/checks/integration-constraints.mjs`

Сборка может технически переписать другие файлы `dist/**`, но в коммит не должны попадать файлы без содержательного изменения относительно исходников. `scripts/compression-metrics.mjs` не изменяется: текущий измеритель уже считает `evidence_binding_kinds`, `runtime_constraint_kinds`, `runtime_constraint_kind_names`, дескрипторы и источники фактов.

---

### Задача 1: зафиксировать целевое отсутствие исторической формы красным тестом

**Файлы:**
- Создать: `tests/test-c3-3c-workflow-path-coverage-deletion.mjs`
- Читать без изменения: `schemas/repo-policy.schema.json`
- Читать без изменения: `src/checks/constraint-program.mts`
- Читать без изменения: `src/policy-compiler.mts`
- Читать без изменения: `src/checks/rules/constraints.mts`
- Читать без изменения: `src/checks/integration-constraints.mts`
- Читать без изменения: `src/document-facts.mts`
- Читать без изменения: `src/init.mts`
- Читать без изменения: `repo-policy.json`

**Интерфейсы:**
- Использует: `compileConstraintProgram(policy, changeIntent?)`, `runtimeConstraints(program)`, `relationDescriptors()`.
- Создаёт: постоянный исполняемый контракт, требующий отсутствия `workflow_path_coverage` и сохранения канонических инвариантов.

- [ ] **Шаг 1: перед тестом доказать полноту известных упоминаний**

Выполнить:

```bash
git grep -n -I -E 'workflow_path_coverage|evidence_workflow_path_coverage|checkWorkflowPathCoverage|WorkflowPathCoverageBinding' -- ':!dist/**'
```

Ожидаемые содержательные области до удаления:

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

Исторические документы и текущие design/plan документы не считаются рабочим API. Если команда обнаружит дополнительный производственный потребитель или пример политики, которого нет в этой карте, остановить реализацию и сопоставить его с границей #394 до редактирования.

- [ ] **Шаг 2: создать красный тест ровно на целевую архитектуру**

Создать `tests/test-c3-3c-workflow-path-coverage-deletion.mjs` с таким содержанием:

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

- [ ] **Шаг 3: запустить только новый тест и подтвердить намеренный красный результат**

Выполнить:

```bash
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
```

Ожидаемый результат на ещё не изменённом рабочем коде:

```text
FAIL: public evidence binding vocabulary contains only anchor_value_coverage
FAIL: constraint compiler emits no historical workflow coverage runtime
FAIL: runtime evaluator contains no workflow coverage kind or dedicated helper
FAIL: integration constraints contain no workflow path coverage evaluator
FAIL: semantic policy compiler contains no workflow path coverage branch
```

Одновременно должны пройти проверки отсутствия self-consumer, отсутствия генерации через `init`, сохранения `anchor_value_coverage`, десяти дескрипторов и четырёх источников `FactRef`.

Если число или причины отказов отличаются, не переходить к удалению до объяснения расхождения.

- [ ] **Шаг 4: запустить весь набор тестов и убедиться, что дополнительный отказ вызван только новым тестом**

Выполнить:

```bash
npm test
```

Ожидается ненулевой код только из-за `test-c3-3c-workflow-path-coverage-deletion.mjs`. Все существовавшие до этого тестовые файлы должны оставаться зелёными.

- [ ] **Шаг 5: закоммитить только красный тест**

```bash
git add tests/test-c3-3c-workflow-path-coverage-deletion.mjs
git commit -m "test(c3.3c): falsify workflow path coverage deletion"
```

После публикации коммита зафиксировать номер намеренно красного запуска CI в комментарии #394. Не менять производственные файлы в этом коммите.

---

### Задача 2: удалить публичную и исполняемую семантику `workflow_path_coverage`

**Файлы:**
- Изменить: `schemas/repo-policy.schema.json`
- Изменить: `src/checks/constraint-program.mts`
- Изменить: `src/policy-compiler.mts`
- Изменить: `src/checks/rules/constraints.mts`
- Изменить: `src/checks/integration-constraints.mts`
- Сгенерировать: соответствующие `dist/**/*.mjs`
- Проверить: `tests/test-c3-3c-workflow-path-coverage-deletion.mjs`
- Проверить: `tests/test-c3-3b-trace-anchor-lowering.mjs`

**Интерфейсы:**
- Сохраняет: `compileEvidenceBindingsPolicy(policy)` для `anchor_value_coverage`.
- Сохраняет: `compileConstraintProgram(policy, changeIntent?)` и `runtimeConstraints(program)`.
- Сохраняет: `integrationConstraintEntries(integration)` и весь текущий продуктовый слой интеграции.
- Удаляет: `WorkflowPathCoverageBinding`, `checkWorkflowPathCoverage`, `checkEvidenceWorkflowPathCoverage`, рабочий вид `evidence_workflow_path_coverage`.

- [ ] **Шаг 1: удалить первую альтернативу из публичной схемы**

В `definitions.evidence_binding.oneOf` оставить единственный объект:

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

Не сворачивать `oneOf` в другую форму: существующая метрика `schemaConstKinds(..., "evidence_binding")` должна продолжить читать конечный набор без изменения измерителя.

- [ ] **Шаг 2: удалить историческую ветку из `compileEvidenceBindingsPolicy`**

Удалить `documentSelectorKey`, вычисление `pathExistenceSelectors`, карту `workflows` и ветку `binding.kind === "workflow_path_coverage"`.

Целевая форма функции:

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

Не добавлять отдельную ошибку совместимости для `workflow_path_coverage`: публичная схема уже должна отвергать её как неподдерживаемую форму.

- [ ] **Шаг 3: сузить представление привязки и компиляцию рабочего ограничения**

В `EvidenceBindingProjection` удалить поля:

```ts
workflow?: unknown;
covers?: unknown;
```

В цикле `policy.evidence_bindings` заменить выбор исторической формы на единственное поддерживаемое понижение:

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

Семантическая идентичность `evidence-binding:<id>` и строгость удаления/изменения `anchor_value_coverage` остаются прежними.

- [ ] **Шаг 4: удалить рабочий вид и специализированный вычислитель**

В `src/checks/rules/constraints.mts` целевой союз должен стать:

```ts
type RuntimeConstraintKind =
  | "surface_debt"
  | "size_rules"
  | "registry_rules"
  | "change_profile"
  | "integration"
  | "primitive_relation";
```

Удалить из `RuntimeConstraint` поля, использовавшиеся только старой формой:

```ts
binding_id?: string;
source?: FactRef;
workflow?: string;
covers?: string[];
```

Удалить импорт:

```ts
import { readFact, type DocumentReader, type FactRef } from "../../document-facts.mjs";
```

и заменить его на импорт только реально оставшегося `DocumentReader`, если этот тип ещё используется в файле:

```ts
import type { DocumentReader } from "../../document-facts.mjs";
```

Удалить:

```ts
checkEvidenceWorkflowPathCoverage
factOperand
```

Удалить пару:

```ts
evidence_workflow_path_coverage: "state"
```

из `CONSTRAINT_PHASES` и удалить ветку:

```ts
else if (constraint.kind === "evidence_workflow_path_coverage") check = checkEvidenceWorkflowPathCoverage(facts, constraint);
```

Импорт интеграционного модуля должен остаться только таким:

```ts
import { integrationConstraintEntries } from "../integration-constraints.mjs";
```

- [ ] **Шаг 5: удалить helper покрытия из интеграционного модуля**

В `src/checks/integration-constraints.mts` удалить:

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

После этого удалить ставший ненужным импорт:

```ts
import { matchesAny } from "../utils/path-patterns.mjs";
```

Не изменять `workflowDetails`, `parallelReadinessDetails`, `integrationConstraintEntries` или роли интеграции: они относятся к C3.3d.

- [ ] **Шаг 6: собрать `dist` из исходников**

```bash
npm run build
```

Ожидается успешная сборка. Затем проверить, что сгенерированная поверхность свежая:

```bash
npm run check:dist
```

Ожидается:

```text
Generated dist is current.
```

- [ ] **Шаг 7: превратить новый отрицательный тест из красного в зелёный**

```bash
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
```

Ожидается:

```text
C3.3c workflow path coverage deletion contract passed
```

- [ ] **Шаг 8: доказать, что каноническое покрытие якорей не изменилось**

```bash
node tests/test-c3-3b-trace-anchor-lowering.mjs
```

Ожидается успешный итог C3.3b, включая:

```text
anchor value coverage lowers to existing set_subset
C3.3b keeps exactly the existing ten relation descriptors
```

На этом этапе полный набор тестов ещё может быть красным из-за старых тестов, которые намеренно ожидают поддержку удалённого API. Их миграция — следующая отдельная задача.

- [ ] **Шаг 9: закоммитить производственное удаление и свежий `dist`**

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
- Проверить: `tests/test-c3-3c-workflow-path-coverage-deletion.mjs`
- Проверить: `tests/test-c3-3b-trace-anchor-lowering.mjs`

**Интерфейсы:**
- Сохраняет позитивные тесты `anchor_value_coverage`.
- Добавляет постоянный schema-level regression test на отказ удалённой формы.
- Удаляет тесты, требующие существования старого workflow coverage API.

- [ ] **Шаг 1: удалить исторические fixture helpers из `test-policy-compiler-boundary.mjs`**

Удалить полностью:

```js
const ciWorkflow = (enforcement = "blocking") => ({
  id: "project-ci", kind: "github_actions", path: ".github/workflows/ci.yml", role: "ci_gate",
  expect: { events: ["pull_request"], enforcement, disallow: ["continue_on_error"] },
});
const evidencePolicy = (overrides = {}) => ({
  ...basePolicy,
  integration: { workflows: [ciWorkflow()] },
  document_relations: {
    documents: { contract: structuredClone(documents.contract) },
    rules: [structuredClone(referencedPaths)],
  },
  evidence_bindings: [{ id: "owners-covered", kind: "workflow_path_coverage", source: structuredClone(referencedPaths.source), workflow: "project-ci", covers: ["tests/**"] }],
  ...overrides,
});
```

Удалить тест:

```text
requires evidence bindings to reuse known blocking workflows and exact R2 existence selectors
```

и весь блок:

```text
workflow path evidence public/runtime boundary
```

Не удалять `anchorEvidencePolicy` и блок `anchor value evidence public/runtime boundary`.

- [ ] **Шаг 2: добавить явную schema-регрессию**

Сразу после существующей проверки `evidence trace` в `tests/validate-schemas.mjs` добавить:

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

Это закрепляет fail-closed границу: старый синтаксис является ошибкой схемы, а не молча игнорируемой конфигурацией.

- [ ] **Шаг 3: запустить узкие тесты схемы и компилятора**

```bash
node tests/validate-schemas.mjs
node tests/test-policy-compiler-boundary.mjs
node tests/test-c3-3c-workflow-path-coverage-deletion.mjs
node tests/test-c3-3b-trace-anchor-lowering.mjs
```

Все четыре команды должны завершиться с кодом `0`.

- [ ] **Шаг 4: запустить весь обнаруживаемый набор тестов**

```bash
npm test
```

Ожидается полный зелёный результат. Если остаётся тест, который требует `workflow_path_coverage`, сначала определить, является ли он исторической записью или текущим продуктовым потребителем. Не добавлять псевдоним совместимости ради прохождения такого теста.

- [ ] **Шаг 5: закоммитить миграцию тестов**

```bash
git add tests/test-policy-compiler-boundary.mjs tests/validate-schemas.mjs
git commit -m "test(c3.3c): enforce workflow coverage removal"
```

---

### Задача 4: доказать архитектурное сжатие и синхронизировать утверждённую спецификацию

**Файлы:**
- Изменить: `docs/superpowers/specs/2026-09-08-c3-3c-workflow-path-coverage-deletion-design.md`
- Не изменять: `scripts/compression-metrics.mjs`
- Не изменять: `docs/architecture-compression-3-baseline.md`
- Не изменять: `docs/architecture-compression-3-c3.3b.md`

**Интерфейсы:**
- Использует существующий машинный измеритель `scripts/compression-metrics.mjs`.
- Фиксирует только статус утверждённой спецификации; не создаёт третий документ.

- [ ] **Шаг 1: изменить только строку статуса спецификации**

Заменить:

```text
Статус: проект архитектуры для #394.
```

на:

```text
Статус: утверждённая архитектура C3.3c для #394; реализация ведётся в PR #395.
```

Не переписывать разделы C3.3d и не добавлять новую семантику.

- [ ] **Шаг 2: получить машинные метрики текущей вершины**

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

- [ ] **Шаг 3: доказать отсутствие рабочей исторической семантики после удаления**

Выполнить:

```bash
git grep -n -I -E 'workflow_path_coverage|evidence_workflow_path_coverage|checkWorkflowPathCoverage|WorkflowPathCoverageBinding' -- \
  schemas src tests examples README.md RELEASING.md PORTFOLIO.md
```

Допустимое совпадение после задачи 3 — только отрицательные тестовые строки, явно утверждающие удаление или отклонение старого имени. В `schemas/**`, `src/**`, `examples/**`, `README.md`, `RELEASING.md`, `PORTFOLIO.md` совпадений быть не должно.

- [ ] **Шаг 4: проверить языковую политику документации через полный набор**

```bash
npm test
```

Ожидается зелёный `test-documentation-language.mjs` вместе со всем набором.

- [ ] **Шаг 5: проверить свежесть генерации и сам инструмент**

```bash
npm run check:dist
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
```

Все команды должны завершиться успешно.

- [ ] **Шаг 6: закоммитить только изменение статуса документа**

```bash
git add docs/superpowers/specs/2026-09-08-c3-3c-workflow-path-coverage-deletion-design.md
git commit -m "docs(c3.3c): mark deletion design approved"
```

---

### Задача 5: провести PR через собственную политику и принять exact head

**Файлы:**
- Новых изменений файлов не должно быть.
- Источник санкции: Issue #394.
- Кандидат: PR #395.

**Интерфейсы:**
- Использует `ChangeIntent` и `GovernanceGrant` из #394.
- Требует `authorized_governance_paths: [schemas/repo-policy.schema.json]` и пустой `allow_policy_relaxation`.
- Не допускает merge другого head, чем прошедший готовую проверку.

- [ ] **Шаг 1: проверить чистоту рабочей ветки и точный diff**

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

- [ ] **Шаг 2: выполнить финальную локальную верификацию exact head**

```bash
npm run check:dist
npm test
node scripts/compression-metrics.mjs
node dist/repo-guard.mjs
node dist/repo-guard.mjs validate-integration
node dist/repo-guard.mjs doctor
```

Все команды должны завершиться с кодом `0`.

- [ ] **Шаг 3: опубликовать вершину и дождаться зелёного draft CI**

```bash
git push origin c3/394-workflow-path-coverage-deletion
HEAD=$(git rev-parse HEAD)
echo "$HEAD"
```

Сохранить точный SHA. Draft CI должен иметь зелёные `validate` и `smoke-pack`. На этом состоянии `Run PR policy check` может быть пропущен, потому что PR ещё draft.

- [ ] **Шаг 4: перевести PR #395 в готовое состояние без изменения head**

```bash
gh pr ready 395 --repo netkeep80/repo-guard
```

Сразу повторно получить SHA:

```bash
READY_HEAD=$(gh pr view 395 --repo netkeep80/repo-guard --json headRefOid --jq .headRefOid)
test "$READY_HEAD" = "$HEAD"
```

- [ ] **Шаг 5: проверить готовую self-policy на том же exact head**

Дождаться запуска события `ready_for_review` и проверить, что зелёными являются как минимум:

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

Если self-policy сообщает ослабление политики, не расширять `GovernanceGrant`: в #394 разрешено изменение схемы, но `allow_policy_relaxation` намеренно пуст.

- [ ] **Шаг 6: слить только проверенный SHA**

```bash
gh api --method PUT repos/netkeep80/repo-guard/pulls/395/merge \
  -f merge_method=merge \
  -f sha="$READY_HEAD"
```

Ответ должен сообщить успешное слияние. Если SHA изменился или merge отклонён, не повторять команду без повторной полной проверки нового состояния.

- [ ] **Шаг 7: проверить новый `main` и post-merge CI**

```bash
git fetch origin main
git rev-parse origin/main
```

Новый `main` должен быть merge commit, содержащим проверенный `READY_HEAD`. Post-merge CI на этом коммите должен завершиться зелёными `validate` и `smoke-pack`.

- [ ] **Шаг 8: закрыть контрольный цикл**

Убедиться, что #394 закрыта как `completed` через `Fixes #394`, PR #395 имеет состояние `merged`, а #374 остаётся открытой. В #374 зафиксировать только следующий факт программы:

```text
C3.3c accepted: workflow_path_coverage deleted without replacement; runtime kinds 7 -> 6; descriptors 10; FactRef sources 4. Next architectural subject: C3.3d integration convergence.
```

Не начинать C3.3d в этой ветке или PR.
