# C3.1 Canonical FactRef + Relation Kernel Design

Issue: #372
Parent: #370
Base main: `730769112d94ae03ab996ba19cc3b20da9be965f`

## Goal

Убрать дублирование semantic knowledge о document relation primitives. После C3.1 новый generic primitive должен требовать не более одного semantic edit-site в kernel, плюс schema и tests.

## Simplicity rule

Не создавать новую подсистему, если существующая подходит.

Authority после cutover:

- `src/document-facts.mts` — canonical typed `FactRef` и чтение фактов;
- `src/checks/relation-kernel.mts` — canonical finite relation descriptor registry и relation evaluation metadata;
- `src/checks/constraint-program.mts` — только lowering policy -> canonical runtime relation;
- `src/checks/rules/constraints.mts` — один evaluator entry point, который dispatches relation через kernel descriptor.

Запрещено:

- новый `primitive-registry` рядом с `relation-kernel`;
- второй evaluator;
- compatibility aliases для старых internal selectors/runtime kinds;
- arbitrary predicates/expression language;
- contract-conformance-specific semantics в новом kernel;
- C3.2 cochange compression в этом slice.

## Canonical FactRef

Существующий `DocumentFactSelector` заменяется одним canonical reference, который полностью описывает источник, snapshot, selector и ожидаемый тип.

Минимальная модель:

```ts
export type FactSnapshot = "state" | "base" | "head";

export interface FactRef {
  source: {
    document: string;
    path: string;
    format: "json" | "yaml" | "plain_text";
  };
  snapshot: FactSnapshot;
  pointer: string;
  projection?: DocumentProjection;
  type: DocumentFactType;
}
```

`readFact(...)` является единственной точкой чтения typed facts.

- `state` использует current repository `DocumentReader`;
- `base` использует `baseRef + readFileAtRef`;
- `head` использует `headRef + readFileAtRef`.

Старые `RuntimeDocumentSelector` и `snapshotOperand()` после миграции удаляются.

## Canonical relation descriptor registry

`src/checks/relation-kernel.mts` расширяется существующей конечной таблицей descriptors.

Descriptor владеет минимум:

```ts
interface RelationDescriptor {
  kind: string;
  operands: readonly OperandDescriptor[];
  phase: ExecutionPhase;
  evaluate: RelationEvaluator;
  strictness: "exact_or_incomparable" | RelationStrictnessDescriptor;
  identityInputs: readonly string[];
}
```

Registry является единственным semantic inventory relation kinds внутри runtime code.

Schema остаётся отдельным structural inventory как untrusted-input boundary.

## Runtime representation

Все document relation policy rules lower в один runtime shape:

```ts
{
  kind: "relation",
  name: "document-relation:<id>",
  relation_id: "<id>",
  relation: "scalar_equal" | "scalar_strictly_greater" | ...,
  operands: { ...canonical FactRef/document/literal operands... },
  parameters: { ... }
}
```

Не должно оставаться отдельных runtime kinds вида:

```text
document_scalar_equal
document_scalar_strictly_greater
document_set_equal
...
```

## Compiler behavior

`policy-compiler.mts` не перечисляет relation kinds для определения используемых документов.

Алгоритм:

1. lookup descriptor by `rule.kind`;
2. fail closed, если descriptor отсутствует;
3. пройти descriptor operand roles;
4. проверить/пометить referenced documents generically;
5. relation-specific structural compatibility, которая не может быть выражена общей operand metadata, принадлежит descriptor validation.

Это делает класс ошибки #368 механически невозможным: compiler consumer path выводится из descriptor, а не из отдельного switch.

## Constraint Program behavior

`constraint-program.mts` не содержит relation-kind switch.

Для каждой relation rule:

1. lookup descriptor;
2. compile operands to canonical refs/values;
3. emit one `kind: "relation"` runtime constraint;
4. emit existing entity/shape strictness entries using descriptor identity/strictness metadata.

## Evaluator behavior

`evaluateConstraintIR()` остаётся единственным evaluator entry point.

Для `kind: "relation"` он:

1. lookup descriptor by `constraint.relation`;
2. fail closed if unknown;
3. фильтрует по `descriptor.phase`;
4. вызывает `descriptor.evaluate`.

Отдельного `CONSTRAINT_PHASES` inventory для relation kinds больше нет.

Нереляционные historical runtime constraints пока остаются как есть; их lowering относится к C3.3.

## Falsifiers

C3.1 обязан иметь RED -> GREEN tests минимум для:

1. `scalar_strictly_greater` из #366/#368 компилируется и исполняется без отдельного compiler switch;
2. каждый registered relation автоматически учитывает все declared document operands в unused-document analysis;
3. unknown relation fails closed в compiler/runtime boundary;
4. runtime relation phase берётся из descriptor;
5. после cutover в production source нет старых document-specific runtime kind inventories;
6. schema relation kinds и kernel descriptors mechanically compared, чтобы drift был обнаружен тестом.

## Public surface

Public policy syntax C3.1 не расширяет.

Если canonical docs используют термин `DocumentFactSelector` как архитектурный authority, они обновляются на `FactRef` в этом же PR. Примеры policy не меняются, если их JSON surface остаётся прежним.

## Scope boundary

Не делать в C3.1:

- generic `cochange_group`;
- удаление `CONTRACT_CONFORMANCE_DOCUMENT_ROLES`;
- pure macro lowering `contract_conformance`;
- historical ChangeIntent/trace/integration family lowering;
- self-policy rewrite;
- Pages;
- version/release changes;
- CI optimization.

Это следующие C3 gates.

## Acceptance mapping

- one canonical FactRef model -> `document-facts.mts`;
- one primitive descriptor registry -> `relation-kernel.mts`;
- unknown primitive fails closed -> descriptor lookup boundaries;
- #368 class impossible/mechanically detected -> descriptor-driven operand consumption + schema/registry drift test;
- semantic edit-sites target -> one kernel descriptor edit-site + schema + tests;
- no second evaluator/registry -> existing kernel and existing `evaluateConstraintIR` only;
- tests/dist/self-policy green -> normal protected PR gate;
- docs current -> terminology updated only where public architecture changed.
