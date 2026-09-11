# C3.10b Consumer-policy Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сжать public policy authoring до одного closed built-in `packs` surface, устранить document snapshot special-case и доказать на `anum_parser` реальное уменьшение policy complexity без расширения canonical runtime.

**Architecture:** `packs` существует только до canonical compilation: schema validates finite built-in configs, one pack registry lowers them into existing low-level policy fragments, затем существующие compiler/FactRef/relation kernel/evaluator работают без знания pack origin. Existing `profile/profile_overrides` and `contract_conformance` are migrated into the same pack registry and removed as independent public concepts before acceptance; no compatibility aliases survive. `anum_parser#122` remains the external RED fixture until a new exact accepted repo-guard SHA exists.

**Tech Stack:** Node.js >=20, TypeScript `.mts`, JSON Schema draft-07/Ajv, existing `FactRef`, finite relation kernel, executable scenario harness, GitHub Actions.

**Spec:** `docs/c3.10b-consumer-policy-compression.md`

## Global Constraints

- GitHub is source of truth; re-read live `main`, issue and PR state before every write.
- Starting accepted main for this slice: `e5b9063c9d1c9e05404ec32b78ca005c278839ce`; if main changes, rebase/re-plan rather than silently continuing on stale authority.
- `v3.0.0` release remains HOLD until #507, `anum_parser` external proof and remaining #381 gates are accepted.
- `pack-specific runtime kinds = 0`.
- `pack-specific evaluators = 0`.
- `pack-specific comparison engines = 0`.
- `pack-specific FactRef types = 0`.
- No arbitrary predicates, JS, shell, JSONPath/JMESPath expression language, user-defined macro body, template engine or runtime plugin system.
- No `karpathy: true` or methodology-specific public switch.
- New built-in pack requires repeated real use, deterministic bounded lowering, existing canonical facts/relations, executable PASS+FAIL evidence and measurable authoring compression.
- `version-governance` means `HEAD semver > BASE semver`, not exact patch+1.
- `package.json` remains the only application version authority for `anum_parser`; no second `VERSION` file.
- JSON/YAML/plain_text document sources must support canonical `state|base|head` snapshot parity.
- Generated constraint ids use deterministic reserved `pack:<pack-name>:` identities; collisions fail closed; no hidden precedence/override semantics.
- Breaking pre-v3 cutover is allowed; no permanent aliases for `profile/profile_overrides` or standalone `contract_conformance` after acceptance if migration is feasible.
- Public docs/examples/Pages must converge in the same slice as public surface changes.

---

### Task 1: RED — expose the public FactRef/snapshot mismatch and pack contract

**Files:**
- Create: `tests/test-c3-10b-policy-packs.mjs`
- Modify: `schemas/repo-policy.schema.json`
- Test indirectly: generated `dist/**` freshness via existing build/check-dist gates

**Interfaces:**
- Consumes: current `document_relations` schema, `FactRef` snapshot support already implemented in `src/document-facts.mts`.
- Produces: failing executable expectations for structured BASE/HEAD selectors and a closed `packs` top-level schema.

- [ ] **Step 1: Write a failing schema/runtime test for JSON BASE/HEAD parity**

Create `tests/test-c3-10b-policy-packs.mjs` with a minimal policy containing one JSON document and selectors that distinguish `snapshot: "head"` and `snapshot: "base"` for `/version`. Assert that current schema rejects it before implementation; the test message must identify the current plain-text-only special case.

Target authoring shape:

```json
{
  "document_relations": {
    "documents": {
      "package": { "path": "package.json", "format": "json" }
    },
    "rules": [{
      "id": "version-monotonic",
      "kind": "scalar_strictly_greater",
      "comparator": "semver",
      "left":  { "document": "package", "snapshot": "head", "pointer": "/version", "type": "string" },
      "right": { "document": "package", "snapshot": "base", "pointer": "/version", "type": "string" }
    }]
  }
}
```

- [ ] **Step 2: Write failing schema tests for the future closed `packs` surface**

Add cases proving:

```text
packs.version-governance            accepted shape candidate
packs.repo-guard-workflow           accepted shape candidate
packs.unknown-pack                  rejected
arbitrary user macro body           rejected
```

Do not implement lowering yet.

- [ ] **Step 3: Run the targeted test and capture RED**

Run through the repository test runner or directly with Node after building current source as appropriate. Expected: FAIL because structured selector snapshots and/or `packs` are unsupported. Record the exact failing assertion in #507.

- [ ] **Step 4: Commit only the RED test**

Commit message:

```text
test(c3.10b): expose policy authoring amplification
```

The RED commit is evidence and must not include implementation.

---

### Task 2: Public FactRef parity — move snapshot to selectors without changing runtime semantics

**Files:**
- Modify: `schemas/repo-policy.schema.json`
- Modify: `src/checks/constraint-program.mts`
- Modify: `src/policy-compiler.mts`
- Modify: tests around document relations / `tests/test-c3-10b-policy-packs.mjs`
- Generated: `dist/**`

**Interfaces:**
- Consumes: canonical document `FactRef` selector `{path, format, snapshot, pointer, projection}`.
- Produces: low-level public selectors that can request `state|base|head` for JSON/YAML/plain_text, while document declarations remain identity-only `{path, format}`.

- [ ] **Step 1: Add schema support for selector-level snapshot**

Extend document scalar/string/set selector schemas with optional:

```json
"snapshot": { "type": "string", "enum": ["state", "base", "head"] }
```

Keep document declarations as `{path, format}` only. Remove the plain-text-only document-definition snapshot branch rather than preserving dual snapshot authorities.

- [ ] **Step 2: Update policy compiler validation**

Ensure `compileDocumentRelationsPolicy` validates selector references while treating `snapshot` as selector data. No special case by document format.

- [ ] **Step 3: Update canonical lowering**

Change `compileFactRef` in `src/checks/constraint-program.mts` so:

```ts
snapshot = selector.snapshot ?? "state"
```

and document definitions supply only path/format. Do not touch `src/document-facts.mts` runtime read semantics unless a test proves a bug there; it already supports all formats at snapshots.

- [ ] **Step 4: Make RED snapshot test GREEN and add YAML/plain_text parity coverage**

Add positive JSON/YAML/plain_text BASE/HEAD tests and negative invalid snapshot tests.

- [ ] **Step 5: Build + targeted tests + full tests**

Run:

```bash
npm run build
node tests/test-c3-10b-policy-packs.mjs
npm test
npm run check:dist
```

Expected: all GREEN; canonical runtime kinds unchanged.

- [ ] **Step 6: Commit**

```text
refactor(c3.10b): align public snapshots with canonical FactRef
```

---

### Task 3: One closed built-in pack registry and deterministic lowering

**Files:**
- Create: `src/policy-packs.mts`
- Modify: `src/policy-profiles.mts` or delete it after migration in Task 5; do not maintain two registries after acceptance
- Modify: policy loading/normalization entry point that currently invokes profile/contract lowering
- Modify: `schemas/repo-policy.schema.json`
- Modify: `tests/test-c3-10b-policy-packs.mjs`
- Generated: `dist/**`

**Interfaces:**
- Produces public internal API:

```ts
interface PackDescriptor<C> {
  name: string;
  lower(config: C): PolicyFragment;
}

function lowerBuiltInPacks(policy: RawPolicy): ExpandedPolicy
function listBuiltInPacks(): string[]
```

`PolicyFragment` is ordinary existing policy vocabulary; no evaluator callbacks.

- [ ] **Step 1: Write RED tests for registry closure and deterministic expansion**

Prove unknown pack rejection, deterministic generated ids, generated/generated and generated/explicit collision rejection, and equal canonical constraint shapes for pack vs explicit low-level equivalent.

- [ ] **Step 2: Implement the smallest closed registry**

Create one registry object keyed by finite built-in names. Do not implement user-defined registration. Each descriptor contains configuration validation metadata/lowering only.

- [ ] **Step 3: Implement merge rules**

Lower all selected packs before canonical policy compilation. Merge generated policy fragments structurally; generated ids use `pack:<name>:` prefix. Collision is compile error. Explicit policy never overrides generated output.

- [ ] **Step 4: Prove semantic equivalence at Constraint Program boundary**

For an explicit policy and pack-generated equivalent, compile both and compare canonical program keys/runtime shapes after canonicalization. They must be equal.

- [ ] **Step 5: Full verification and commit**

```bash
npm run build
node tests/test-c3-10b-policy-packs.mjs
npm test
npm run check:dist
```

Commit:

```text
feat(c3.10b): add closed pure-lowering pack registry
```

---

### Task 4: `version-governance` pack — real structured version authority

**Files:**
- Modify: `src/policy-packs.mts`
- Modify: `schemas/repo-policy.schema.json`
- Modify: `examples/scenarios/version-transition/**`
- Modify/Create tests in `tests/test-c3-10b-policy-packs.mjs` and scenario harness expectations
- Modify docs/README examples where version transition is documented
- Generated: `dist/**`

**Interfaces:**
- Config:

```ts
{
  authority: { path: string; pointer: string; format?: "json"|"yaml"|"plain_text" };
  advance: "semver";
  mirrors?: Array<{ path: string; pointer: string; format?: "json"|"yaml"|"plain_text" }>;
}
```

- Lowering output: document declarations + `scalar_strictly_greater` HEAD/BASE + zero or more HEAD `scalar_equal` mirror relations + cochange only if needed for fail-closed transition semantics.

- [ ] **Step 1: Write RED tests for no-bump and mirror mismatch**

Cases:

```text
BASE 0.5.0 -> HEAD 0.5.0 = FAIL
BASE 0.5.0 -> HEAD 0.5.1 = PASS
HEAD authority 0.5.1 vs mirror 0.5.0 = FAIL
```

Use `package.json`/`package-lock.json` JSON fixtures, not a synthetic `VERSION` authority.

- [ ] **Step 2: Implement safe format inference inside pack references**

```text
.json -> json
.yaml/.yml -> yaml
ambiguous extension -> require explicit format and fail closed
```

Do not change low-level expert `document_relations.documents` inference unless required by a separate simplification test.

- [ ] **Step 3: Implement lowering only with existing relations**

No new primitive. Generated relation ids must be deterministic under `pack:version-governance:`.

- [ ] **Step 4: Replace `version-transition` executable scenario**

Scenario authority becomes structured JSON. Preserve bounded negative case and add mirror mismatch negative evidence if scenario format permits multiple cases without duplicating harness logic.

- [ ] **Step 5: Verify explicit-vs-pack equivalence, full suite, commit**

Commit:

```text
feat(c3.10b): add version governance pack
```

---

### Task 5: `repo-guard-workflow` pack — compact immutable blocking workflow governance

**Files:**
- Modify: `src/policy-packs.mts`
- Modify: `schemas/repo-policy.schema.json`
- Modify/Create scenario fixture for workflow governance; prefer extending existing governance/executable corpus rather than creating a redundant scenario family
- Modify: tests and README/docs examples
- Generated: `dist/**`

**Interfaces:**
- Config:

```ts
{
  path: string;
  action: string;
  ref: string;
  mode: "check-pr";
  enforcement: "blocking";
  permissions: Record<string, "read">;
}
```

- Lowering output: YAML document + existing scalar literal relations for exact `uses`, mode, enforcement and permissions.

- [ ] **Step 1: Write bounded negative tests**

Each of these must independently FAIL:

```text
mutable/wrong Action ref
wrong mode
advisory enforcement
write permission where read required
```

- [ ] **Step 2: Implement exact workflow selector lowering**

Use deterministic YAML pointers matching the supported workflow shape. Pack accepts explicit exact ref; do not discover or mutate the current SHA automatically.

- [ ] **Step 3: Prove equivalent canonical program to explicit document relations**

No workflow-specific runtime branch may exist after lowering.

- [ ] **Step 4: Full verification and commit**

```text
feat(c3.10b): add repo-guard workflow pack
```

---

### Task 6: Consolidate existing high-level mechanisms into `packs`

**Files:**
- Modify: `src/policy-packs.mts`
- Delete or radically reduce: `src/policy-profiles.mts` after moving generic pack lowering into one place
- Modify: `schemas/repo-policy.schema.json`
- Modify: all repository policies/fixtures/scenarios using `profile`, `profile_overrides`, or `contract_conformance`
- Modify: tests for requirements-strict and contract-conformance
- Modify: README/docs/templates/init output
- Generated: `dist/**`

**Interfaces:**
- `packs.requirements-strict` preserves existing deterministic requirement anchor/trace expansion.
- `packs.contract-conformance` preserves existing deterministic document/relations/cochange expansion.

- [ ] **Step 1: Write migration RED assertions**

New forms must compile to canonical programs equivalent to current accepted behavior. Old top-level forms must be rejected by final schema after cutover.

- [ ] **Step 2: Move `requirements-strict` into the common registry**

Preserve defaults and finite override schema, but remove independent `profile/profile_overrides` public concepts.

- [ ] **Step 3: Move `contract-conformance` into the common registry**

If this requires new runtime semantics or canonical primitive changes, STOP and record architecture decision in #507 instead of forcing migration.

- [ ] **Step 4: Delete old public schema properties and obsolete lowering branches**

No aliases. No dual syntax. Update `policy-vocabulary` historical projection only as necessary to treat retired high-level vocabulary as historical BASE evidence, not supported HEAD syntax.

- [ ] **Step 5: Measure concept reduction**

Record before/after at minimum:

```text
public high-level mechanisms
schema properties/lines
policy-packs/profile source lines
self-policy concepts
runtime kinds
relation primitive count
```

Expected: public high-level concept count decreases; runtime kinds remain `1`.

- [ ] **Step 6: Full suite + commit**

```text
refactor(c3.10b): converge high-level policy packs
```

---

### Task 7: Self-host, docs, Pages and compression metrics

**Files:**
- Modify: `repo-policy.json` where packs materially shorten equivalent self-governance
- Modify: `README.md`
- Modify: canonical docs under `docs/**`
- Modify: Pages generator/data if public policy topology rendering assumes old concepts
- Modify: `docs/self-hosting-coverage.json`
- Modify: compression metrics script/tests if public concept metrics need explicit pack counts
- Generated: `dist/**`, generated Pages data as required by existing repository workflow

**Interfaces:**
- Public docs explain `intent -> scope -> limits -> invariants -> evidence` and packs as pure authoring sugar.
- Pages shows pack config and lowered canonical facts/relations, making clear that pack is not a runtime engine.

- [ ] **Step 1: Convert applicable self-policy boilerplate to packs**

Only convert when policy bytes/concepts decrease. Do not force pack usage where explicit low-level form is clearer or one-off.

- [ ] **Step 2: Update README quick start and architecture**

Show compact `version-governance` and `repo-guard-workflow` examples plus one explicit equivalent/lowering diagram.

- [ ] **Step 3: Update Pages observability**

Render built-in pack catalog/config and lowered canonical constraint topology without giving Pages mutation authority.

- [ ] **Step 4: Record before/after authoring metrics**

At minimum compare the provisional `anum_parser#122` verbose policy against target compact pack policy:

```text
policy lines/bytes
document declarations
selectors
explicit relations
concepts to understand
canonical constraints after lowering
```

- [ ] **Step 5: Run all repository acceptance gates**

```bash
npm run build
npm test
npm run check:dist
npm run compression:metrics
```

Also run the repository's scenario/Pages CI-equivalent commands exposed by package/workflow scripts.

- [ ] **Step 6: Open protected PR for #507 and require exact-head GREEN**

PR body must contain ChangeIntent and docs answer. Required checks remain `validate` and `smoke-pack`; additionally inspect all relevant CI/Pages checks before merge.

- [ ] **Step 7: Exact-head merge and post-merge evidence**

Record accepted repo-guard main SHA in #507/#381. Do not tag/release v3.0.0 yet.

---

### Task 8: Resume `anum_parser#122` on the accepted C3.10b SHA

**Files in `netkeep80/anum_parser`:**
- Modify: `repo-policy.json`
- Modify: `.github/workflows/repo-guard.yml`
- Modify: `package.json`, `package-lock.json` only after intended RED is observed
- Modify: CI workflows/scripts for previously approved CI compression
- Keep existing Pages version authority path from `package.json`

**Interfaces:**
- `packs.version-governance` governs every PR semver advance and lock mirror.
- `packs.repo-guard-workflow` governs exact accepted SHA, blocking check-pr and read-only permissions.

- [ ] **Step 1: Re-read live consumer main, #121 and PR #122**

Ensure no active development has resumed or conflicting PR/main changes appeared. If it has, stop and reassess before writes.

- [ ] **Step 2: Repin workflow to exact accepted C3.10b SHA and replace verbose provisional relations with compact packs**

Keep application version `0.5.0`.

- [ ] **Step 3: Require intended RED**

The repo-guard failure must specifically show version advancement failure (`HEAD 0.5.0` is not greater than `BASE 0.5.0`). Policy compilation errors do not count.

- [ ] **Step 4: GREEN version transition**

Change:

```text
package.json      0.5.0 -> 0.5.1
package-lock.json 0.5.0 -> 0.5.1
```

and require version/mirror relations GREEN.

- [ ] **Step 5: Complete approved CI compression**

One dependency materialization in core flow, remove duplicated consumer setup where assertion remains named/fail-closed, concurrency cancellation, Playwright 2 workers with fallback to 1 only on demonstrated coupling.

- [ ] **Step 6: Measure before/after CI and policy**

Record exact run IDs, wall-clock, browser wall-clock, job count, repeated preparation count and policy metrics.

- [ ] **Step 7: Exact-head merge and Pages verification**

Require repo-guard + ordinary CI GREEN; merge exact head; verify post-merge CI/Pages deploy and published UI `v0.5.1` from `package.json`.

- [ ] **Step 8: Close external proof loop in `repo-guard#381`**

Record exact consumer BASE/HEAD, accepted repo-guard SHA, RED diagnostic, GREEN runs, policy compression, CI compression, `consumer-specific core logic = 0`. Only then proceed to remaining final release gates.
