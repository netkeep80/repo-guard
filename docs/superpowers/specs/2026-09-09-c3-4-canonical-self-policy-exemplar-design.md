# C3.4 — Canonical self-policy exemplar design

Date: 2026-09-09

Parent: #375
Roadmap: #370
Depends on accepted C3.3: #374

Accepted base before design work:

```text
main = abd89e9c0ec5d9244756894f970b04db2aa26501
```

Canonical C3.0 measurement baseline:

```text
92432809fcddc290080beb51ba151e13a5761869
```

## 1. Purpose

C3.4 must make `repo-guard` itself the smallest honest production example of the architecture accepted after C3.3.

The self-policy must describe only real invariants of this repository. It must not be a catalogue of all product features and must not preserve historical syntax merely to demonstrate support.

Primary design bias:

```text
simpler > broader showcase
universal > repository-specific
remove > duplicate > macro-hide
real execution evidence > declarative imitation
```

C3.4 is not permission to introduce another runtime, profile, integration DSL, policy language, or repo-specific bypass.

## 2. Accepted architecture boundary

After C3.3 the canonical semantic runtime is:

```text
Git / GitHub / filesystem
          ↓
finite typed facts
          ↓
FactRef
          ↓
Constraint Program
          ↓
primitive_relation
          ↓
relation kernel
          ↓
AnalysisReport
```

Hard invariants for C3.4:

```text
runtime constraint kinds = 1
final runtime kind = primitive_relation
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
second evaluator = NONE
new arbitrary expression language = NONE
compatibility aliases = NONE
repo-specific semantic bypass = NONE
```

C3.4 must not grow any of these counts unless an independently demonstrated consumer falsifier proves a generic gap. No such gap is currently known.

## 3. Current self-policy problem

Current `repo-policy.json` is valid, but still resembles a broad feature showcase rather than a minimal executable statement of repo-guard's actual invariants.

The main duplication is:

```text
surfaces
new_file_classes
change_profiles
```

`surfaces` and `new_file_classes` mostly repeat the same repository path taxonomy, while five `change_profiles` repeat permissive/forbidden combinations over that taxonomy.

At the same time every real PR already declares its own executable transition boundary through `ChangeIntent`:

```text
change_type
scope
budgets
must_touch
must_not_touch
expected_effects
```

and ready PRs are validated through repo-guard's own public Action path:

```text
uses: ./
mode: check-pr
enforcement: blocking
```

Therefore the self-policy does not need a large internal taxonomy merely to classify development method names.

## 4. Selected approach — Minimal live exemplar

Three approaches were considered:

### A. Minimal live exemplar — SELECTED

Keep only real repository invariants in `repo-policy.json`. Product capabilities not genuinely needed by repo-guard itself remain covered by focused tests/examples and are not forced into self-policy.

### B. Consolidated taxonomy — REJECTED

Keep `surfaces + change_profiles`, reduce taxonomy size, delete only some duplication.

Rejected because the self-policy would still encode methodology-oriented classification that is already supplied by each PR's `ChangeIntent`.

### C. Broad showcase — REJECTED

Keep the current policy shape and only add more self-host assertions.

Rejected because it preserves complexity specifically for demonstration, contrary to Architecture Compression 3.0.

## 5. Target self-policy

The canonical repo-guard self-policy should contain only these categories unless RED proves another repository invariant is necessary:

```text
policy identity
blocking enforcement
trusted governance paths
forbidden paths
operational paths
global diff budgets
real compression/size bounds
real content rules
real source -> test cochange
stable public metadata/document relations
```

Expected deletion from repo-guard's own `repo-policy.json`:

```text
surfaces
new_file_classes
change_profiles
```

This is a self-policy compression only. It does NOT remove these public product capabilities from schema/runtime merely because the repo-guard repository no longer uses them itself.

No new built-in `repo-guard`, `tooling`, `self-host`, or similar profile may be created to hide the same policy complexity inside TypeScript.

## 6. Stable structural invariants use existing document relations

C3.4 should make the self-policy visibly exercise the canonical document-fact/relation model where the invariant is naturally structural.

Initial target relations should use only existing generic descriptors, for example:

```text
package.json:/main
  =
package.json:/bin/repo-guard

package.json:/main
  =
"dist/repo-guard.mjs"

action.yml:/inputs/mode/default
  =
"check-pr"

action.yml:/inputs/enforcement/default
  =
"blocking"
```

The exact final set is bounded by usefulness and stability. Every relation must represent a real public/runtime contract, not a synthetic demonstration.

Allowed existing primitives are sufficient:

```text
scalar_equal
scalar_equals_literal
```

C3.4 must NOT add an integration-specific relation or workflow-specific FactRef selector.

## 7. Workflow execution is evidence, not policy text semantics

C3.4 must preserve the C3.3 decision that GitHub workflow topology is not a second policy language.

Do NOT add policy rules that inspect workflow step arrays, command strings, or action text merely to prove CI wiring.

Wrong direction:

```text
workflow YAML text -> special policy evaluator
```

Correct direction:

```text
real CI execution
  -> check:dist
  -> compression metrics
  -> repo-policy validation
  -> doctor
  -> discovered tests
  -> public Action check-pr
  -> smoke packaged artifact
```

Generated `dist` is similarly proven by `npm run check:dist`; a weak rule such as `src changed -> dist changed` is not equivalent and must not replace the build freshness check.

## 8. Machine-visible self-host topology

C3.4 must make the full self-host path mechanically testable from existing authoritative artifacts, without adding a manually maintained topology manifest.

Required observed chain:

```text
ChangeIntent
    ↓
trusted BASE repo-policy
    ↓
trusted GovernanceGrant for governance mutation
    ↓
protected PR
    ↓
repo-guard public Action (uses: ./, check-pr, blocking)
    ↓
validate + smoke-pack required checks
    ↓
accepted main
```

The self-host ratchet should derive evidence directly from current repository files and GitHub-facing configuration such as:

```text
repo-policy.json
.github/PULL_REQUEST_TEMPLATE.md
.github/ISSUE_TEMPLATE/change-intent.yml
.github/workflows/ci.yml
action.yml
package.json
```

It must not create another static capability/topology registry that duplicates these sources.

## 9. Governance boundary

The trusted governance set should represent files that define policy, validation, Action, CI/build/release behavior.

The current set should be reviewed for tightening to include real control-plane files such as:

```text
package.json
package-lock.json
tsconfig.json
scripts/build.mjs
scripts/check-dist.mjs
scripts/verify-release-ref.mjs
```

Only actual authority-bearing files should be included. Do not classify ordinary source merely because it is important.

Any expansion of governance paths is a tightening and must still pass the normal trusted governance path.

## 10. Generic strictness granularity prerequisite

The current policy comparison can collapse unknown top-level vocabulary changes into the root pointer:

```text
/
```

That makes an otherwise narrow self-policy compression require an excessively broad GovernanceGrant such as:

```text
allow_policy_relaxation:
  - /
```

C3.4 must not authorize that broad escape hatch.

Before the self-policy deletion slice, implement one generic strictness improvement:

```text
unknown top-level policy sections are compared independently by key
```

So deleting current sections can be reported as narrow incomparable/relaxation pointers:

```text
/surfaces
/new_file_classes
/change_profiles
```

The generic comparison algorithm must not contain those field names. It must operate over unknown top-level keys generically.

No new semantic runtime kind or relation descriptor is needed.

## 11. Self-hosting coverage truthfulness

Current documentation claims that `tests/test-self-hosting.mjs` derives command/rule/profile capabilities and compares them against self-policy/CI/exceptions. The present test primarily exercises `doctor` and runtime environment checks instead.

C3.4 must remove this factual mismatch.

Preferred target:

```text
derive normal capability inventory from code/registries
+
derive actual self-host evidence from live repository artifacts
+
keep docs/self-hosting-coverage.json only for honest exceptions
```

Do not replace the current exception-only JSON with a manually maintained full capability matrix.

If a product capability is intentionally not used by repo-guard itself, a focused product test may prove it while `self-hosting-coverage.json` records the reason self-application would be artificial.

## 12. Templates and documentation

C3.4 must synchronize consumer-facing examples with the accepted live architecture.

Known drift to remove includes at least:

```text
templates/repo-policy.min.json
  policy_format_version 0.1.0 -> current canonical version

templates/example-workflow.yml
  stale Action dependency versions -> current supported example

README.md
  remove references to already-deleted historical product concepts
  use canonical self-policy as the primary real example where useful
```

Templates remain consumer-oriented minimal examples. They should not blindly copy every self-policy rule.

## 13. Execution decomposition

C3.4 should be implemented as two separately reviewable acceptance slices.

### C3.4a — generic strictness granularity

Goal:

```text
root-wide incomparable pointer
  -> independent unknown top-level pointers
```

Properties:

```text
generic algorithm only
no repo-policy rewrite
no new primitive
no new FactRef source
no relation descriptor growth
no repository-specific field names in canonical comparison logic
```

RED-first proof must show the accepted base currently reports a broad root pointer for independent unknown top-level changes and that the target behavior requires narrow per-key pointers.

### C3.4b — canonical self-policy exemplar

After C3.4a is accepted:

```text
compress repo-policy.json
add only real existing document relations
strengthen governance paths where justified
repair self-hosting evidence ratchet
sync templates/docs
measure final self-policy complexity
```

No compatibility layer between old and new self-policy may remain after merge.

## 14. TDD and acceptance

Every implementation slice is RED-first.

C3.4a acceptance:

```text
test-only RED first
focused GREEN
full discovered suite GREEN
dist fresh
self-policy GREEN
compression metrics GREEN
ready-state validate + smoke-pack + Run PR policy check GREEN
exact-head merge
post-merge validate + smoke-pack GREEN
```

C3.4b RED probes must establish at minimum:

```text
current self-policy still contains surfaces/new_file_classes/change_profiles
current self-policy size/complexity is the accepted starting point
canonical self-policy does not yet contain the selected real document relations
self-hosting documentation claim is not yet mechanically proven
consumer templates contain the known stale values
```

Final C3.4b acceptance:

```text
self-policy uses only real current repository invariants
surfaces = absent from self-policy
new_file_classes = absent from self-policy
change_profiles = absent from self-policy
selected document_relations = present and evaluated through canonical relation runtime
runtime kinds = 1
FactRef sources = 4
relation descriptors = 10
new engine concepts = 0
public Action self-check exercised in ready PR CI
trusted governance path still fail-closed
check:dist is explicit executable evidence
smoke-pack proves packaged artifact
self-hosting coverage claims match executable tests
README/templates/examples synchronized
policy complexity materially smaller/easier than current and C3.0 baseline
ready-state validate + smoke-pack + Run PR policy check GREEN
exact-head merge
post-merge validate + smoke-pack GREEN
```

## 15. Compression measurement

At minimum report before/after:

```text
repo-policy bytes
repo-policy top-level concepts
surfaces count
new-file-class count
change-profile count
size-rule count
content-rule count
cochange-rule/group count
document-relation rule count
governance path count
runtime constraint kinds
FactRef models/sources
relation descriptor count
self-hosting exception count
```

Success is not merely fewer bytes. The important result is fewer independent concepts needed to understand how repo-guard governs itself.

## 16. Explicit non-goals

```text
NO new runtime kind
NO new FactRef source
NO new relation descriptor unless independent consumer RED proves necessity
NO integration/workflow DSL
NO repo-guard-specific built-in profile
NO capability showcase inside self-policy
NO manually duplicated self-host topology manifest
NO legacy syntax compatibility
NO broad allow_policy_relaxation: /
NO C3.5/C3.6 work folded into C3.4
```

## 17. Final architectural criterion

The desired end state is:

```text
repo-guard's own repository policy
    =
small ordinary consumer policy
+
a few real generic relations
+
trusted governance boundary
+
real CI execution evidence
```

A new consumer should be able to understand the architecture by reading repo-guard's own policy without first learning a repo-guard-specific meta-policy.

That is the C3.4 definition of "canonical exemplar".
