import { DocumentFactFailure, readFact, resolveJsonPointer, } from "../document-facts.mjs";
const set = (values = []) => new Set(values);
export function compareSets(left = [], right = [], relation = "equal") {
    const l = set(left), r = set(right);
    const missing = left.filter((value) => !r.has(value));
    const extra = right.filter((value) => !l.has(value));
    const ok = relation === "left_subset" ? !missing.length
        : relation === "right_subset" ? !extra.length
            : !missing.length && !extra.length;
    return { ok, missing, extra };
}
export const implies = (trigger, evidence) => !trigger || Boolean(evidence);
export const maxBound = (actual, max) => max === undefined || actual <= max;
function factRef(relation, role) {
    const operand = relation.operands[role];
    if (!operand || !("source" in operand))
        throw new Error(`relation "${relation.relation_id}" requires fact operand "${role}"`);
    return operand;
}
function documentTarget(relation, role) {
    const operand = relation.operands[role];
    if (!operand || "source" in operand)
        throw new Error(`relation "${relation.relation_id}" requires document operand "${role}"`);
    return operand;
}
function documentFactSelector(ref, relationId) {
    if (ref.source !== "document")
        throw new Error(`relation "${relationId}" requires document fact operands`);
    return ref.selector;
}
function factOperand(facts, relation, role) {
    return readFact(facts, factRef(relation, role));
}
function parseSemverCore(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    if (!match)
        return null;
    const tuple = [Number(match[1]), Number(match[2]), Number(match[3])];
    return tuple.every(Number.isSafeInteger) ? tuple : null;
}
function tupleGreater(left, right) {
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index])
            return left[index] > right[index];
    }
    return false;
}
function scalarStrictlyGreater(facts, relation) {
    const leftRef = factRef(relation, "left"), rightRef = factRef(relation, "right");
    const leftSelector = documentFactSelector(leftRef, relation.relation_id), rightSelector = documentFactSelector(rightRef, relation.relation_id);
    const baseRef = leftSelector.snapshot === "base" ? leftRef : rightSelector.snapshot === "base" ? rightRef : null;
    const headRef = leftSelector.snapshot === "head" ? leftRef : rightSelector.snapshot === "head" ? rightRef : null;
    const baseSelector = baseRef ? documentFactSelector(baseRef, relation.relation_id) : null;
    const headSelector = headRef ? documentFactSelector(headRef, relation.relation_id) : null;
    const path = headSelector?.path || baseSelector?.path || leftSelector.path || rightSelector.path || "";
    const comparator = relation.parameters.comparator;
    if (!baseRef || !headRef || !baseSelector || !headSelector)
        return {
            ok: false,
            message: `document relation "${relation.relation_id}" requires one BASE and one HEAD operand`,
            rule_id: relation.relation_id, path, base_value: undefined, head_value: undefined,
            expected_relation: "strictly_greater", comparator,
        };
    if (baseSelector.path !== headSelector.path)
        return {
            ok: false,
            message: `document relation "${relation.relation_id}" requires BASE and HEAD of the same path`,
            rule_id: relation.relation_id, path, base_value: undefined, head_value: undefined,
            expected_relation: "strictly_greater", comparator,
        };
    const base = readFact(facts, baseRef), head = readFact(facts, headRef);
    const baseValue = base.ok ? base.value : undefined, headValue = head.ok ? head.value : undefined;
    const diagnostic = {
        rule_id: relation.relation_id,
        path,
        base_value: baseValue,
        head_value: headValue,
        expected_relation: "strictly_greater",
        comparator,
    };
    if (!base.ok)
        return { ok: false, message: `document relation "${relation.relation_id}" could not read BASE: ${base.error.message}`, ...diagnostic, data: { base, head } };
    if (!head.ok)
        return { ok: false, message: `document relation "${relation.relation_id}" could not read HEAD: ${head.error.message}`, ...diagnostic, data: { base, head } };
    if (comparator !== "semver")
        return { ok: false, message: `document relation "${relation.relation_id}" has unsupported comparator`, ...diagnostic, data: { base, head } };
    if (typeof base.value !== "string" || typeof head.value !== "string")
        return { ok: false, message: `document relation "${relation.relation_id}" requires string operands`, ...diagnostic, data: { base, head } };
    const baseTuple = parseSemverCore(base.value), headTuple = parseSemverCore(head.value);
    if (!baseTuple)
        return { ok: false, message: `document relation "${relation.relation_id}" has malformed BASE semver`, ...diagnostic, data: { base, head } };
    if (!headTuple)
        return { ok: false, message: `document relation "${relation.relation_id}" has malformed HEAD semver`, ...diagnostic, data: { base, head } };
    const ok = tupleGreater(headTuple, baseTuple);
    return { ok, message: ok ? undefined : `document relation "${relation.relation_id}" expected HEAD > BASE`, ...diagnostic, data: { base, head } };
}
function scalarEqual(facts, relation) {
    const left = factOperand(facts, relation, "left"), right = factOperand(facts, relation, "right");
    const data = { kind: relation.primitive, left, right };
    if (!left.ok || !right.ok)
        return { ok: false, message: `document relation "${relation.relation_id}" could not read scalar operands`, data };
    const ok = left.value === right.value;
    return { ok, message: ok ? undefined : `document relation "${relation.relation_id}" scalar values differ`, data };
}
function scalarEqualsLiteral(facts, relation) {
    const source = factOperand(facts, relation, "source"), expected = relation.parameters.value;
    const data = { kind: relation.primitive, source, expected };
    if (!source.ok)
        return { ok: false, message: `document relation "${relation.relation_id}" could not read scalar operand`, data };
    const ok = source.value === expected;
    return { ok, message: ok ? undefined : `document relation "${relation.relation_id}" scalar value does not match literal`, data };
}
function numericBound(facts, relation) {
    const source = factOperand(facts, relation, "source");
    const min = relation.parameters.min, max = relation.parameters.max;
    const sourceValues = source.ok && Array.isArray(source.value) ? source.value : undefined;
    const data = {
        kind: relation.primitive,
        operands: relation.operands,
        source,
        ...(sourceValues ? { source_values: sourceValues } : {}),
        min,
        max,
    };
    if (!source.ok)
        return { ok: false, message: `relation "${relation.relation_id}" could not read bounded operand`, data };
    const actual = typeof source.value === "number" && Number.isFinite(source.value)
        ? source.value
        : Array.isArray(source.value)
            ? source.value.length
            : null;
    if (actual === null) {
        return { ok: false, message: `relation "${relation.relation_id}" requires a finite number or set operand`, data };
    }
    if (min !== undefined && (typeof min !== "number" || !Number.isFinite(min))) {
        return { ok: false, message: `relation "${relation.relation_id}" has invalid minimum bound`, data };
    }
    if (max !== undefined && (typeof max !== "number" || !Number.isFinite(max))) {
        return { ok: false, message: `relation "${relation.relation_id}" has invalid maximum bound`, data };
    }
    if (min === undefined && max === undefined) {
        return { ok: false, message: `relation "${relation.relation_id}" requires min or max`, data };
    }
    const ok = (min === undefined || actual >= min) && (max === undefined || actual <= max);
    return {
        ok,
        message: ok ? undefined : `relation "${relation.relation_id}" is outside numeric bound`,
        actual,
        limit: max,
        min,
        max,
        data: { ...data, actual },
    };
}
function setPresenceImplies(facts, relation) {
    const left = factOperand(facts, relation, "left"), right = factOperand(facts, relation, "right");
    const data = { kind: relation.primitive, operands: relation.operands, left, right };
    if (!left.ok || !right.ok)
        return { ok: false, message: `relation "${relation.relation_id}" could not read set operands`, data };
    if (!Array.isArray(left.value) || !Array.isArray(right.value)) {
        return { ok: false, message: `relation "${relation.relation_id}" requires set operands`, data };
    }
    const ok = implies(left.value.length, right.value.length);
    return { ok, message: ok ? undefined : `relation "${relation.relation_id}" has missing evidence when trigger set is non-empty`, data };
}
function setAllOrNone(facts, relation) {
    const source = factOperand(facts, relation, "source");
    const universe = relation.parameters.universe;
    const data = { kind: relation.primitive, source, universe };
    if (!source.ok)
        return { ok: false, message: `relation "${relation.relation_id}" could not read selected set`, data };
    if (!Array.isArray(source.value) || !Array.isArray(universe) || universe.some((item) => typeof item !== "string")) {
        return { ok: false, message: `relation "${relation.relation_id}" requires selected and universe sets`, data };
    }
    const selected = source.value;
    const normalizedUniverse = [...new Set(universe)].sort();
    const selectedSet = new Set(selected);
    const missing = normalizedUniverse.filter((item) => !selectedSet.has(item));
    const extra = selected.filter((item) => !normalizedUniverse.includes(item));
    const ok = selected.length === 0 || (missing.length === 0 && extra.length === 0);
    return {
        ok,
        group_id: relation.parameters.group_id,
        changed: selected,
        missing,
        message: ok ? undefined : `relation "${relation.relation_id}" requires all members to be selected together`,
        data: { ...data, selected, missing, extra },
    };
}
function referencedPathsExist(facts, relation) {
    const source = factOperand(facts, relation, "source");
    if (!source.ok)
        return { ok: false, message: `document relation "${relation.relation_id}" could not read repository path references`, data: { kind: relation.primitive, source } };
    if (!Array.isArray(source.value))
        return { ok: false, message: `document relation "${relation.relation_id}" did not produce a repository path set`, data: { kind: relation.primitive, source } };
    const referencedPaths = source.value;
    if (facts.trackedFiles === undefined)
        return {
            ok: false,
            message: `document relation "${relation.relation_id}" cannot verify references without tracked repository facts`,
            data: { kind: relation.primitive, source, referenced_paths: referencedPaths, missing_paths: [], tracked_repository_available: false },
        };
    const tracked = new Set(facts.trackedFiles);
    const missingPaths = referencedPaths.filter((path) => !tracked.has(path)).sort();
    return { ok: missingPaths.length === 0, message: missingPaths.length ? `document relation "${relation.relation_id}" references missing repository paths` : undefined, data: { kind: relation.primitive, source, referenced_paths: referencedPaths, missing_paths: missingPaths } };
}
function setRelation(facts, relation, comparison) {
    const left = factOperand(facts, relation, "left"), right = factOperand(facts, relation, "right");
    if (!left.ok || !right.ok)
        return { ok: false, message: `document relation "${relation.relation_id}" could not read string-set operands`, data: { kind: relation.primitive, left, right } };
    if (!Array.isArray(left.value) || !Array.isArray(right.value))
        return { ok: false, message: `document relation "${relation.relation_id}" did not produce string sets`, data: { kind: relation.primitive, left, right } };
    const compared = compareSets(left.value, right.value, comparison);
    return {
        ok: compared.ok,
        message: compared.ok ? undefined : `document relation "${relation.relation_id}" failed ${relation.primitive}`,
        data: { kind: relation.primitive, left, right, missing_values: compared.missing, extra_values: compared.extra },
    };
}
function pointerTargetError(error, pointer) {
    if (error instanceof DocumentFactFailure)
        return { code: error.code, pointer: error.pointer, ...(error.segment === undefined ? {} : { segment: error.segment }), message: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return { code: "document_read_error", pointer, message: String(message || "document read failed").replace(/\s+/g, " ").trim() };
}
function readReferencedPointerTarget(facts, target, pointer) {
    const reader = facts.documents;
    if (!reader || !target.path)
        return { ok: false, error: { code: "document_read_error", pointer, message: "document reader or target document is unavailable" } };
    try {
        const document = target.format === "yaml" ? reader.yaml(target.path) : target.format === "json" ? reader.json(target.path) : (() => { throw new DocumentFactFailure("unsupported_document_type", `unsupported document type for "${target.path}"`, pointer); })();
        resolveJsonPointer(document, pointer);
        return { ok: true, document: target.document, path: target.path, pointer };
    }
    catch (error) {
        return { ok: false, error: pointerTargetError(error, pointer) };
    }
}
function referencedPointerExists(facts, relation) {
    const source = factOperand(facts, relation, "source");
    if (!source.ok || typeof source.value !== "string")
        return { ok: false, message: `document relation "${relation.relation_id}" could not read JSON Pointer source`, data: { kind: relation.primitive, source } };
    const target = readReferencedPointerTarget(facts, documentTarget(relation, "target_document"), source.value);
    return { ok: target.ok, message: target.ok ? undefined : `document relation "${relation.relation_id}" references a missing target pointer`, data: { kind: relation.primitive, source, target } };
}
const DESCRIPTORS = [
    {
        kind: "scalar_strictly_greater",
        public: true,
        operands: ["left", "right"],
        phase: "transaction",
        evaluate: scalarStrictlyGreater,
        strictness: "incomparable",
        identity: ["id"],
    },
    {
        kind: "scalar_equal",
        public: true,
        operands: ["left", "right"],
        phase: "state",
        evaluate: scalarEqual,
        strictness: "incomparable",
        identity: ["id"],
    },
    {
        kind: "scalar_equals_literal",
        public: true,
        operands: ["source"],
        phase: "state",
        evaluate: scalarEqualsLiteral,
        strictness: "incomparable",
        identity: ["id"],
        literal: { source: "source", value: "value" },
    },
    {
        kind: "referenced_paths_exist",
        public: true,
        operands: ["source"],
        phase: "state",
        evaluate: referencedPathsExist,
        strictness: "incomparable",
        identity: ["id"],
        evidenceSource: "repository_paths_exist",
    },
    {
        kind: "set_equal",
        public: true,
        operands: ["left", "right"],
        phase: "state",
        evaluate: (facts, relation) => setRelation(facts, relation, "equal"),
        strictness: "incomparable",
        identity: ["id"],
        setComparison: "equal",
    },
    {
        kind: "set_subset",
        public: true,
        operands: ["left", "right"],
        phase: "state",
        evaluate: (facts, relation) => setRelation(facts, relation, "left_subset"),
        strictness: "incomparable",
        identity: ["id"],
        setComparison: "left_subset",
    },
    {
        kind: "referenced_pointer_exists",
        public: true,
        operands: ["source", "target_document"],
        documentOperands: ["target_document"],
        phase: "state",
        evaluate: referencedPointerExists,
        strictness: "incomparable",
        identity: ["id"],
    },
    {
        kind: "numeric_bound",
        public: false,
        operands: ["source"],
        phase: "transaction",
        evaluate: numericBound,
        strictness: "incomparable",
        identity: ["id"],
    },
    {
        kind: "set_presence_implies",
        public: false,
        operands: ["left", "right"],
        phase: "transaction",
        evaluate: setPresenceImplies,
        strictness: "incomparable",
        identity: ["id"],
    },
    {
        kind: "set_all_or_none",
        public: false,
        operands: ["source"],
        phase: "transaction",
        evaluate: setAllOrNone,
        strictness: "incomparable",
        identity: ["id"],
    },
];
const DESCRIPTOR_BY_KIND = new Map(DESCRIPTORS.map((descriptor) => [descriptor.kind, descriptor]));
export function relationDescriptors() {
    return DESCRIPTORS;
}
export function relationDescriptor(kind) {
    const descriptor = DESCRIPTOR_BY_KIND.get(kind);
    if (!descriptor)
        throw new Error(`unknown relation "${kind}"`);
    return descriptor;
}
export function relationDescriptorForSetComparison(comparison) {
    const matches = DESCRIPTORS.filter((descriptor) => descriptor.setComparison === comparison);
    if (matches.length !== 1)
        throw new Error(`expected exactly one relation for set comparison "${comparison}", found ${matches.length}`);
    return matches[0];
}
export function evaluatePrimitiveRelation(facts, relation) {
    return relationDescriptor(relation.primitive).evaluate(facts, relation);
}
