# C3.3d3 Size-rule lowering specification

Issue authority: #409  
Parent: #398  
Accepted base: `9ff00319f9828261ff997796bdb906b95e7a281f`

## Goal

Remove the dedicated `size_rules` runtime kind and `checkSizeRules` evaluator. Supported `size_rules` compile into existing `primitive_relation` constraints whose semantics are provided by `numeric_bound` over canonical scalar facts.

Target runtime kinds:

```text
integration
primitive_relation
```

## Canonical acquisition delta

No new FactRef source. Extend only existing sources.

### `repository.path_metric`

```text
patterns: string[]
exclude_paths?: string[]
population: tracked | changed
metric: lines | bytes | files
aggregate: max | sum
```

This selector is acquisition only. It must not know about policy rule IDs, `size_rules`, limits, advisory behavior, ChangeIntent, or execution phases.

Selected repository paths that require content measurement and cannot be read fail closed as a fact-read failure. Provenance is generic: matched paths, per-path measurements, aggregate, final value.

### `diff.metric`

Keep the existing selector kind. Extend it with optional path scoping and one scalar metric:

```text
metric = new_docs | new_files | net_added_lines | net_files
patterns?: string[]
exclude_paths?: string[]
```

`net_files`: added `+1`, deleted `-1`, modified `0` after path scoping.

## Lowering

File absolute rule:

```text
repository.path_metric(population=all_tracked?tracked:changed,
                       metric=lines|bytes,
                       aggregate=max)
-> numeric_bound(max=rule.max)
```

Directory absolute rule:

```text
repository.path_metric(population=tracked,
                       metric=lines|bytes|files,
                       aggregate=sum)
-> numeric_bound(max=rule.max)
```

Directory growth rule:

```text
diff.metric(metric=net_added_lines|net_files,
            patterns=[rule.glob],
            exclude_paths=rule.ignore)
-> numeric_bound(max=rule.max_growth)
```

A directory rule containing both `max` and `max_growth` compiles into two independent constraints: state absolute and transaction growth.

`applies_to_change_types` is frontend selection only. A non-selected rule emits no primitive constraint.

`level=advisory` is generic runtime/reporting metadata applied after primitive evaluation; no advisory evaluator or size-specific result family is allowed.

## Supported public subset

```text
file:
  metric = lines | bytes
  max = required
  count = all_tracked | changed_only
  max_growth = forbidden

directory:
  metric = lines | bytes | files
  max = required
  count = all_tracked
  max_growth = allowed only for lines | files
```

The following are invalid before runtime:

```text
file + metric=files
file + max_growth
directory + bytes + max_growth
directory + count=changed_only
```

No compatibility translation for these forms.

## Invariants

```text
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
new relation descriptor = NONE
new FactRef source = NONE
second evaluator = NONE
compatibility alias = NONE
runtime kinds = 2
```

Do not preserve `size_violations[]`, `growth[]`, or the `size-rules-advisory` topology as a compatibility API. Diagnostics come from generic fact provenance plus `numeric_bound` result data.

## Acceptance

RED-first is mandatory. The first production commit must have a preceding failing D3 test commit on the accepted base.

Ready-head acceptance requires `validate`, `smoke-pack`, and `Run PR policy check` GREEN on the exact head. Final acceptance additionally requires post-merge `validate` and `smoke-pack` GREEN on the exact merge SHA.
