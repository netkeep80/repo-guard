# C3.3d3 Size-rule Lowering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dedicated `size_rules` runtime/evaluator and lower the supported language into canonical repository/diff scalar facts plus existing `numeric_bound` relations.

**Architecture:** `size_rules` remains only a policy frontend. Repository-state measurement is acquired through one generic `repository.path_metric` selector; diff growth is acquired through the existing `diff.metric` selector extended with path scoping and `net_files`. All limits execute through the existing primitive relation kernel; no new relation kind or FactRef source is introduced.

**Tech Stack:** TypeScript `.mts`, generated `dist/*.mjs`, Node.js tests, Ajv JSON Schema, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-08-c3-3d3-size-rule-lowering.md`

## Global Constraints

- Accepted base is exactly `9ff00319f9828261ff997796bdb906b95e7a281f`.
- Issue authority is #409; parent is #398.
- `FactRef models = 1`.
- `FactRef sources = 4`.
- `relation descriptors = 10`.
- No new relation descriptor.
- No new FactRef source.
- No second evaluator or second FactStore.
- No compatibility alias.
- Final runtime kinds must be exactly `integration`, `primitive_relation`.
- RED-first: no production change before a failing D3 contract test is committed and observed failing for the intended missing behavior.
- Do not close #398 or #374 in D3.

---

### Task 1: RED D3 architectural contract

**Files:**
- Create: `tests/test-c3-3d3-size-rule-lowering.mjs`

**Interfaces:**
- Consumes: current `compileConstraintIR`, `evaluateConstraintIR`, canonical FactRef/relation exports, current schema through ordinary test surfaces.
- Produces: one fail-closed D3 contract test that proves the required architecture before production changes.

- [ ] **Step 1: Write the failing test**

The test must assert all of these through real public/internal runtime behavior, not source-text snapshots:

```text
A. a supported file rule compiles to primitive_relation/numeric_bound using repository.path_metric
B. a supported directory absolute rule compiles to primitive_relation/numeric_bound using repository.path_metric
C. a directory growth rule compiles to primitive_relation/numeric_bound using scoped diff.metric
D. a mixed directory rule emits separate state and transaction primitive constraints
E. advisory remains generic metadata and reports warning rather than dedicated size-rules-advisory
F. unreadable selected repository content fails closed
G. runtime kinds no longer include size_rules
H. relation descriptor count stays 10 and FactRef source count stays 4
```

Use a minimal facts fixture with `trackedFiles`, normalized diff entries and `readFile`. Include one unreadable matched file case.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
```

Expected: FAIL because the accepted base still emits `kind=size_rules` and lacks `repository.path_metric`/scoped `diff.metric` acquisition.

- [ ] **Step 3: Commit only the RED test**

```bash
git add tests/test-c3-3d3-size-rule-lowering.mjs
git commit -m "test(c3.3d3): add size-rule lowering falsifier"
```

No production files in this commit.

---

### Task 2: Canonical scalar acquisition

**Files:**
- Modify: `src/document-facts.mts`
- Modify only if reuse is needed: `src/diff/classification.mts`
- Test: `tests/test-c3-3d3-size-rule-lowering.mjs`

**Interfaces:**
- Produces repository selector shape:

```ts
{
  kind: "path_metric";
  patterns: readonly string[];
  exclude_paths?: readonly string[];
  population: "tracked" | "changed";
  metric: "lines" | "bytes" | "files";
  aggregate: "max" | "sum";
}
```

- Extends existing diff metric selector with `metric: "net_files"`, optional `patterns`, optional `exclude_paths`.

- [ ] **Step 1: Implement `repository.path_metric` acquisition minimally**

Selection rules:

```text
tracked population -> facts.trackedFiles
changed population -> checked diff paths intersected with tracked/current paths
patterns -> include matching paths
exclude_paths -> remove matching paths
files metric -> per-path value 1; no content read
lines -> count current file lines
bytes -> current file byte length
max -> maximum measurement, empty set = 0
sum -> sum measurements, empty set = 0
```

If a selected `lines`/`bytes` file cannot be read, return a structured fact failure. Do not skip it.

Return generic provenance containing selector kind, matched paths, measurements, aggregate and final value.

- [ ] **Step 2: Extend existing `diff.metric`**

Apply optional `patterns`/`exclude_paths` before metric computation. Preserve existing behavior when those fields are absent.

Implement:

```text
net_files = count(added) - count(deleted)
```

Modified files contribute zero.

- [ ] **Step 3: Run focused D3 test**

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
```

Expected: still FAIL at compiler/runtime-kind assertions; acquisition-specific assertions may now pass.

- [ ] **Step 4: Run canonical fact tests**

```bash
node tests/test-document-facts-boundary.mjs
node tests/test-canonical-relation-kernel.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/document-facts.mts src/diff/classification.mts tests/test-c3-3d3-size-rule-lowering.mjs
git commit -m "feat(c3.3d3): add canonical path metric facts"
```

Omit `src/diff/classification.mts` if unchanged.

---

### Task 3: Lower `size_rules` in the Constraint Program

**Files:**
- Modify: `src/checks/constraint-program.mts`
- Modify: `src/checks/rules/constraints.mts`
- Test: `tests/test-c3-3d3-size-rule-lowering.mjs`

**Interfaces:**
- Existing `primitiveRelation(...)` remains the emitted runtime shape.
- Add only generic primitive metadata if necessary:

```ts
advisory?: boolean
```

- [ ] **Step 1: Compile selected size rules into primitive relations**

For each rule selected by `applies_to_change_types`:

```text
file absolute -> repository.path_metric(max) -> numeric_bound(max)
directory absolute -> repository.path_metric(sum) -> numeric_bound(max)
directory growth lines -> diff.metric(net_added_lines, scoped) -> numeric_bound(max_growth)
directory growth files -> diff.metric(net_files, scoped) -> numeric_bound(max_growth)
```

Use phase `state` for all-tracked absolute constraints and `transaction` for changed-only file constraints and growth constraints.

A mixed directory rule emits two constraints. Do not emit `kind=size_rules`.

- [ ] **Step 2: Remove dedicated size-rule execution branch**

Delete from `constraints.mts`:

```text
size_rules runtime kind
CONSTRAINT_PHASES.size_rules
projectSizeRules(...)
checkSizeRules import/call
size-rules-advisory special result
```

For primitive constraints with `advisory=true`, copy `{ advisory: true }` into the evaluated check result generically after relation evaluation.

- [ ] **Step 3: Run focused D3 test**

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
```

Expected: GREEN except schema-cut assertions not yet added/applied.

- [ ] **Step 4: Run execution/pipeline tests**

```bash
node tests/test-execution-phases.mjs
node tests/test-pipeline.mjs
node tests/test-rule-registry.mjs
```

Expected: identify only stale assertions that pin the deleted runtime topology. Do not change production to satisfy stale topology.

- [ ] **Step 5: Commit**

```bash
git add src/checks/constraint-program.mts src/checks/rules/constraints.mts tests/test-c3-3d3-size-rule-lowering.mjs
git commit -m "refactor(c3.3d3): lower size rules to primitive relations"
```

---

### Task 4: Move unsupported combinations to schema/frontend failure

**Files:**
- Modify: `schemas/repo-policy.schema.json`
- Modify: `tests/validate-schemas.mjs`
- Modify: `examples/size-rules-policy.json` only if needed to stay within the approved subset
- Test: `tests/test-c3-3d3-size-rule-lowering.mjs`

**Interfaces:**
- Public supported subset is exactly the spec; unsupported combinations are rejected before runtime.

- [ ] **Step 1: Add RED schema assertions**

Assert invalid:

```text
file + metric=files
file + max_growth
directory + bytes + max_growth
directory + count=changed_only
```

Assert valid representative forms for file lines, file bytes changed-only, directory lines growth, directory files growth, directory bytes absolute.

- [ ] **Step 2: Run schema validation and verify RED**

```bash
node tests/validate-schemas.mjs
```

Expected: FAIL because current schema is broader.

- [ ] **Step 3: Tighten only `definitions.size_rule`**

Use structural `oneOf`/conditional schema so invalid combinations cannot reach runtime. Do not add compatibility fields.

- [ ] **Step 4: Run schema validation**

```bash
node tests/validate-schemas.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add schemas/repo-policy.schema.json tests/validate-schemas.mjs examples/size-rules-policy.json
git commit -m "refactor(c3.3d3): bound size-rule surface at schema"
```

Omit example file if unchanged.

---

### Task 5: Delete the dedicated evaluator and migrate stale tests

**Files:**
- Delete: `src/checks/rules/size-rules.mts`
- Modify only proven stale consumers, likely: `tests/test-compression-rules.mjs`, `tests/test-execution-phases.mjs`, `tests/test-pipeline.mjs`, `tests/test-rule-registry.mjs`
- Modify generated counterparts under `dist/**` through the repository build step, not manual semantic divergence.

**Interfaces:**
- No exported `checkSizeRules` remains.
- No runtime result named `size-rules` is required as a topology contract; lowered constraints use their stable rule-derived names.

- [ ] **Step 1: Delete `size-rules.mts` and stale direct imports**

Migrate tests toward canonical behavior only when they still prove useful semantics. Delete assertions whose only purpose is pinning the removed evaluator/result topology.

For the historical transaction test, replace `directory + changed_only` with a valid `file + changed_only` case; do not recreate conditional subtree semantics.

- [ ] **Step 2: Build generated dist**

Run the repository's standard build command from `package.json` that regenerates `dist`.

- [ ] **Step 3: Run focused tests one failure at a time**

```bash
node tests/test-c3-3d3-size-rule-lowering.mjs
node tests/test-compression-rules.mjs
node tests/test-execution-phases.mjs
node tests/test-pipeline.mjs
node tests/test-rule-registry.mjs
```

Expected: PASS after only evidence-backed migrations.

- [ ] **Step 4: Commit**

```bash
git add -A src/checks/rules/size-rules.mts dist tests
git commit -m "refactor(c3.3d3): delete size-rule runtime evaluator"
```

---

### Task 6: Ratchet compression invariants and full verification

**Files:**
- Modify: `tests/test-c3-3d1-runtime-tail-deletion.mjs` or create a D3-specific ratchet if clearer
- Modify compression metric expectations only where they represent accepted architectural counts.

**Interfaces:**
- Runtime kinds exactly: `integration`, `primitive_relation`.
- Relation descriptors exactly 10.
- FactRef sources exactly 4.

- [ ] **Step 1: Add/adjust exact structural ratchets**

Assert physical absence of source/dist `size-rules` evaluator and exact runtime kind count `2`.

- [ ] **Step 2: Run dist freshness and compression metrics**

```bash
npm run check:dist
npm run check:compression
```

If script names differ, use the exact commands defined in current `package.json`; do not invent replacement gates.

- [ ] **Step 3: Run full discovered suite**

```bash
node tests/run.mjs
```

Expected: all discovered test files GREEN.

- [ ] **Step 4: Commit ratchet changes**

```bash
git add tests scripts docs
git commit -m "test(c3.3d3): ratchet two-kind runtime tail"
```

Only add files actually changed.

---

### Task 7: Draft PR, exact-head review, Ready acceptance and merge

**Files:** none unless review finds a defect.

- [ ] **Step 1: Open draft PR**

PR title:

```text
C3.3d3: lower size rules into canonical scalar facts
```

Body must include `Fixes #409`, exact accepted base, RED evidence, semantic cuts, invariant counts and explicit statement that #398/#374 remain open.

- [ ] **Step 2: Wait for draft CI and review the exact head**

Require `validate` and `smoke-pack` GREEN on the reviewed head. Review changed files for hidden size-specific evaluator logic, second FactStore, new relation kinds/sources and compatibility aliases.

- [ ] **Step 3: Mark Ready and require PR policy evidence**

On the exact Ready head require:

```text
validate = SUCCESS
smoke-pack = SUCCESS
Run PR policy check = SUCCESS
```

- [ ] **Step 4: Race-check and merge**

Verify PR head/base SHAs immediately before merge. Merge only that exact head.

- [ ] **Step 5: Verify post-merge exact SHA**

Require push CI:

```text
validate = SUCCESS
smoke-pack = SUCCESS
```

Only then call C3.3d3 accepted, synchronize #409/#398/#374/#370, and leave overall C3.3 open for the integration audit.
