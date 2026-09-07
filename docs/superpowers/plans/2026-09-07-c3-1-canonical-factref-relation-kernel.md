# C3.1 Canonical FactRef + Relation Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** свести document-relation semantics к одному canonical `FactRef` и одной finite relation descriptor table без второго evaluator или compatibility-слоя.

**Architecture:** `src/document-facts.mts` становится единственным владельцем typed `FactRef` и чтения state/base/head фактов. `src/checks/relation-kernel.mts` становится единственным владельцем relation kind, operand roles, phase, evaluator binding, strictness fallback и stable identity inputs. `constraint-program` и `constraints` используют generic relation lookup и не перечисляют primitive kinds самостоятельно.

**Tech Stack:** TypeScript 7, Node.js >=20, ESM, JSON Schema draft-07, существующий build в `scripts/build.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-07-c3-1-canonical-factref-relation-kernel-design.md`

## Global Constraints

- Base accepted main: `730769112d94ae03ab996ba19cc3b20da9be965f`.
- Issue: #372.
- Один canonical evaluator entry point: `evaluateConstraintIR`.
- Один canonical FactRef model.
- Один relation descriptor registry; он живёт в существующем `relation-kernel.mts`.
- Никакого нового `primitive-registry.mts`.
- Никаких compatibility aliases старых internal selector/runtime kinds.
- Unknown primitive fails closed.
- Public policy syntax в C3.1 не расширяется.
- Contract-conformance/cochange compression остаётся C3.2.
- Новый generic primitive: <=1 semantic kernel edit-site + schema + tests.

---

### Task 1: RED architecture falsifier

**Files:**
- Create: `tests/test-canonical-relation-kernel.mjs`
- Modify: none

**Produces:** regression contract для #366/#368 class: один registry обязан владеть relation metadata; compiler/runtime не должны иметь независимые primitive switches.

- [ ] **Step 1: Write the failing test**

Проверить из built `dist`:

```js
import { relationDescriptors, relationDescriptor } from "../dist/checks/relation-kernel.mjs";

expect(relationDescriptors().map((item) => item.kind).sort().join(","),
  "referenced_paths_exist,referenced_pointer_exists,scalar_equal,scalar_equals_literal,scalar_strictly_greater,set_equal,set_subset");
expect(relationDescriptor("scalar_strictly_greater").phase, "transaction");
expect(relationDescriptor("scalar_strictly_greater").operands.join(","), "left,right");
expect(() => relationDescriptor("unknown_relation"), "throws");
```

Дополнительно прочитать source text и доказать, что `policy-compiler.mts`, `constraint-program.mts`, `constraints.mts` не содержат собственный перечень семи public relation kinds после cutover.

- [ ] **Step 2: Verify RED**

Run in CI through draft PR:

```bash
npm test
```

Expected: новый тест падает, потому что descriptor API ещё отсутствует.

- [ ] **Step 3: Commit RED only**

```bash
git add tests/test-canonical-relation-kernel.mjs
git commit -m "test(c3): falsify duplicated relation semantics"
```

---

### Task 2: Canonical FactRef

**Files:**
- Modify: `src/document-facts.mts`
- Test: `tests/test-canonical-relation-kernel.mjs`

**Produces:** `FactRef`, `FactSnapshot`, generic typed fact read boundary for state/base/head.

- [ ] **Step 1: Extend RED test**

Assert exported canonical type behavior through runtime helpers: state reads structured documents; base/head reads plain-text snapshot values; malformed snapshot request fails closed.

- [ ] **Step 2: Replace selector model**

Canonical source shape:

```ts
export type FactSnapshot = "state" | "base" | "head";

export interface FactRef {
  path: string;
  format: "json" | "yaml" | "plain_text";
  snapshot: FactSnapshot;
  pointer: string;
  projection?: DocumentProjection;
  type: DocumentFactType;
}
```

Add one `readFact(...)` boundary that receives repository/document readers plus base/head refs and resolves the requested snapshot.

- [ ] **Step 3: Delete superseded internal selector type**

Do not leave `DocumentFactSelector` as alias. Migrate all canonical callers in the same branch.

- [ ] **Step 4: Run focused tests**

```bash
npm run build
node tests/test-canonical-relation-kernel.mjs
node tests/test-document-facts-boundary.mjs
node tests/test-transition-rules.mjs
```

---

### Task 3: Turn relation-kernel into the single descriptor authority

**Files:**
- Modify: `src/checks/relation-kernel.mts`
- Modify: `src/checks/constraint-program.mts`
- Modify: `src/policy-compiler.mts`
- Modify: `src/checks/rules/constraints.mts`
- Test: `tests/test-canonical-relation-kernel.mjs`

**Produces:** one descriptor table and one generic runtime relation shape.

- [ ] **Step 1: Add finite descriptor table**

Each descriptor owns exactly:

```ts
kind
operands
phase
evaluate
strictness
identity
```

The seven current relation kinds are the complete initial table.

- [ ] **Step 2: Make unknown lookup fail closed**

```ts
relationDescriptor(kind)
```

throws for an unregistered kind.

- [ ] **Step 3: Generic lowering**

Replace the relation-kind switch in `constraint-program.mts` with descriptor-driven operand compilation. Emit one runtime shape:

```ts
{ kind: "primitive_relation", primitive: rule.kind, relation_id: id, operands, parameters }
```

- [ ] **Step 4: Generic compiler consumer discovery**

Replace `policy-compiler.mts` kind conditions with `descriptor.operands`, so every fact/document operand is mechanically consumed from the same descriptor.

- [ ] **Step 5: Generic evaluator dispatch**

Delete document-specific runtime kinds and their entries from `CONSTRAINT_PHASES`. For `primitive_relation`, fetch the descriptor, use its phase, and call its evaluator through the existing `evaluateConstraintIR` loop.

- [ ] **Step 6: Preserve policy comparison semantics**

Relation descriptors use explicit incomparable-on-shape-change semantics in C3.1 unless a monotonic ordering is already proven. Stable semantic identity remains the relation `id`.

- [ ] **Step 7: Run focused regression set**

```bash
npm run build
node tests/test-canonical-relation-kernel.mjs
node tests/test-transition-policy-compiler.mjs
node tests/test-transition-rules.mjs
node tests/test-cross-document-traceability.mjs
node tests/test-execution-phases.mjs
node tests/test-policy-delta-rules.mjs
```

---

### Task 4: Schema/runtime mechanical consistency and compression evidence

**Files:**
- Modify: `tests/validate-schemas.mjs` or the focused C3.1 test if sufficient
- Modify: `scripts/compression-metrics.mjs`
- Modify: `docs/architecture-compression-3-baseline.md`

**Produces:** machine proof that schema kinds and kernel kinds cannot silently drift, plus measured C3.1 edit-site result.

- [ ] **Step 1: Add schema-to-kernel consistency assertion**

Extract `document_relation_rule` kinds from schema and require exact equality with `relationDescriptors()`.

- [ ] **Step 2: Extend compression metrics**

Report:

```text
primitive_descriptor_registry_count = 1
canonical_factref_model_count = 1
independent_document_relation_switches = 0
semantic_edit_sites_per_new_primitive = 1
```

- [ ] **Step 3: Update canonical architecture doc**

Append accepted C3.1 architecture and explain that public policy syntax is unchanged; internal selectors/runtime kinds were removed rather than aliased.

---

### Task 5: Full verification and protected acceptance

**Files:**
- Generated: `dist/**`
- No new production concepts.

- [ ] **Step 1: Generate dist**

```bash
npm run build
```

- [ ] **Step 2: Verify generated freshness**

```bash
npm run check:dist
```

- [ ] **Step 3: Run full suite**

```bash
npm test
```

- [ ] **Step 4: Run self-policy/integration gates through PR CI**

Required checks:

```text
validate
smoke-pack
```

The ready-for-review run must execute the real self `check-pr` step.

- [ ] **Step 5: Exact-head merge only**

Before merge fresh-read `main`, #372, PR head/base/mergeability and exact-head CI. Merge only if base is still accepted C3.0 main or the branch is cleanly updated and reverified.

- [ ] **Step 6: Post-merge evidence**

Verify new `main`, merged PR, #372 closed completed, required checks green, then and only then proceed to #373/C3.2.
