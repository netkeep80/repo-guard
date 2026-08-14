import { normalizeDocumentFact } from "../document-facts.mjs";
const RANKS = {
    enforcement: { advisory: 0, blocking: 1 },
    count: { changed_only: 0, all_tracked: 1 },
};
const array = (value) => Array.isArray(value) ? value : [];
const compare = (relation, value, metadata = {}) => ({ relation, value, ...metadata });
const scalar = (relation, value, metadata) => compare(relation, value, metadata);
const set = (relation, value, metadata) => compare(relation, array(value), metadata);
const exact = (value, metadata) => compare("equal_or_incomparable", value, metadata);
const entity = (metadata) => compare("required_entity", true, metadata);
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function canonicalDocumentPath(value) {
    try {
        return normalizeDocumentFact(value, "repository_path");
    }
    catch {
        return typeof value === "string" ? value : String(value ?? "");
    }
}
function compileDocumentSelector(selectorValue, documents) {
    const selector = object(selectorValue), name = typeof selector.document === "string" ? selector.document : "", definition = documents[name] || {};
    return {
        document: name,
        path: canonicalDocumentPath(definition.path),
        format: definition.format,
        pointer: typeof selector.pointer === "string" ? selector.pointer : "",
        type: selector.type,
    };
}
export function compileConstraintProgram(policy = {}, changeIntent = null) {
    const program = [], diff = policy.diff_rules || {}, budgets = changeIntent?.budgets || {};
    const add = (key, runtime = null, strictness = null) => program.push({ key, runtime, strictness });
    add("paths:forbidden", { kind: "forbid_paths", name: "forbidden-paths", patterns: policy.paths?.forbidden || [] }, set("superset_stricter", policy.paths?.forbidden, { pointer: "/paths/forbidden", weakenKind: "forbidden_path_removed", itemField: "pattern", message: (item) => `paths.forbidden removed: ${item}` }));
    for (const [field, metric, name] of [
        ["max_new_docs", "new_docs", "canonical-docs-budget"], ["max_new_files", "new_files", "max-new-files"], ["max_net_added_lines", "net_added_lines", "max-net-added-lines"],
    ]) {
        const value = diff[field];
        add(`diff:${field}`, { kind: "max_metric", name, metric, max: budgets[field] ?? value }, typeof value === "number" ? scalar("lower_stricter", value, {
            pointer: `/diff_rules/${field}`, weakenKind: "diff_rule_budget_increased", removeKind: "diff_rule_budget_removed", field,
            message: (before, after) => `diff_rules.${field}: ${before} -> ${after}`, removeMessage: `diff_rules.${field} removed (was ${value})`,
        }) : null);
    }
    for (const [key, field, relation, kind, message] of [
        ["paths:governance", "governance_paths", "superset_stricter", "governance_path_removed", (item) => `paths.governance_paths removed: ${item}`],
        ["paths:operational", "operational_paths", "subset_stricter", "operational_path_added", (item) => `paths.operational_paths added exclusion: ${item}`],
        ["paths:canonical_docs", "canonical_docs", "subset_stricter", "canonical_doc_added", (item) => `paths.canonical_docs added exemption: ${item}`],
    ])
        add(key, null, set(relation, policy.paths?.[field], { pointer: `/paths/${field}`, weakenKind: kind, itemField: "pattern", message }));
    const mode = policy.enforcement?.mode;
    if (mode)
        add("enforcement", null, scalar("higher_stricter", RANKS.enforcement[mode], {
            raw: mode, pointer: "/enforcement/mode", weakenKind: "enforcement_weakened", removeKind: "enforcement_removed",
            message: (before, after) => `enforcement.mode: ${before} -> ${after}`, removeMessage: `enforcement.mode removed (was ${mode})`,
        }));
    for (const rule of array(policy.size_rules)) {
        const owner = `size:${rule.id}`, pointer = `/size_rules/${rule.id}`;
        add(owner, null, entity({ owner, pointer, removeKind: "size_rule_removed", rule_id: rule.id,
            removeBefore: { present: true, glob: rule.glob, max: rule.max }, removeAfter: { present: false }, removeMessage: `size_rules entry "${rule.id}" removed (glob: ${rule.glob ?? "?"}, max: ${rule.max ?? "?"})` }));
        add(`${owner}:shape`, null, exact({ scope: rule.scope, metric: rule.metric, glob: rule.glob, applies_to_change_types: rule.applies_to_change_types }, { owner, pointer, incomparableMessage: `size_rules[${rule.id}] changed selector/scope semantics` }));
        add(`${owner}:max`, null, scalar("lower_stricter", rule.max, { owner, pointer: `${pointer}/max`, weakenKind: "size_rule_max_increased", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].max: ${a} -> ${b}` }));
        add(`${owner}:level`, null, scalar("higher_stricter", RANKS.enforcement[rule.level || "blocking"], { owner, raw: rule.level || "blocking", pointer: `${pointer}/level`, weakenKind: "size_rule_level_weakened", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].level: ${a} -> ${b}` }));
        add(`${owner}:count`, null, scalar("higher_stricter", RANKS.count[rule.count || "all_tracked"], { owner, raw: rule.count || "all_tracked", pointer: `${pointer}/count`, weakenKind: "size_rule_count_weakened", rule_id: rule.id, message: (a, b) => `size_rules[${rule.id}].count: ${a} -> ${b}` }));
        add(`${owner}:ignore`, null, set("subset_stricter", rule.ignore, { owner, pointer: `${pointer}/ignore`, weakenKind: "size_rule_ignore_added", itemField: "pattern", message: (item) => `size_rules[${rule.id}].ignore added: ${item}` }));
        if (rule.max_growth !== undefined)
            add(`${owner}:max_growth`, null, scalar("lower_stricter", rule.max_growth, {
                owner, pointer: `${pointer}/max_growth`, weakenKind: "size_rule_max_growth_increased", removeKind: "size_rule_max_growth_removed", rule_id: rule.id,
                message: (a, b) => `size_rules[${rule.id}].max_growth: ${a} -> ${b}`, removeMessage: `size_rules[${rule.id}].max_growth removed (was ${rule.max_growth})`,
            }));
    }
    for (const workflow of array(policy.integration?.workflows)) {
        const owner = `workflow:${workflow.id}`, pointer = `/integration/workflows/${workflow.id}`;
        add(owner, null, entity({ owner, pointer, removeKind: "integration_workflow_removed", workflow_id: workflow.id,
            removeBefore: { present: true, role: workflow.role, path: workflow.path }, removeAfter: { present: false }, removeMessage: `integration.workflows entry "${workflow.id}" removed` }));
        const { enforcement, ...otherExpect } = workflow.expect || {};
        add(`${owner}:shape`, null, exact({ kind: workflow.kind, path: workflow.path, role: workflow.role, profiles: workflow.profiles, expect: otherExpect }, { owner, pointer, incomparableMessage: `integration.workflows[${workflow.id}] changed non-monotonic wiring semantics` }));
        if (enforcement)
            add(`${owner}:enforcement`, null, scalar("higher_stricter", RANKS.enforcement[enforcement], {
                owner, raw: enforcement, pointer: `${pointer}/expect/enforcement`, weakenKind: "integration_workflow_expectation_weakened", removeKind: "integration_workflow_expectation_removed", workflow_id: workflow.id,
                message: (a, b) => `integration.workflows[${workflow.id}].expect.enforcement: ${a} -> ${b}`, removeMessage: `integration.workflows[${workflow.id}].expect.enforcement removed (was ${enforcement})`,
            }));
    }
    const documentRelations = policy.document_relations, documents = documentRelations?.documents || {};
    for (const rule of array(documentRelations?.rules)) {
        const id = String(rule.id ?? ""), owner = `document-relation:${id}`, pointer = `/document_relations/rules/${id}`;
        const runtimeBase = { name: owner, relation_id: id };
        let runtime = null, shape = { kind: rule.kind };
        if (rule.kind === "scalar_equal") {
            const left = compileDocumentSelector(rule.left, documents), right = compileDocumentSelector(rule.right, documents);
            runtime = { ...runtimeBase, kind: "document_scalar_equal", left, right };
            shape = { kind: rule.kind, left, right };
        }
        else if (rule.kind === "scalar_equals_literal") {
            const source = compileDocumentSelector(rule.source, documents);
            runtime = { ...runtimeBase, kind: "document_scalar_equals_literal", source, value: rule.value };
            shape = { kind: rule.kind, source, value: rule.value };
        }
        add(owner, runtime, entity({ owner, pointer, removeKind: "document_relation_removed", rule_id: id,
            removeBefore: shape, removeAfter: { present: false }, removeMessage: `document_relations rule "${id}" removed` }));
        add(`${owner}:shape`, null, exact(shape, { owner, pointer, rule_id: id, incomparableMessage: `document_relations rule "${id}" changed semantics` }));
    }
    if (array(policy.size_rules).length)
        add("runtime:size-rules", { kind: "size_rules", name: "size-rules", rules: policy.size_rules });
    if (array(policy.registry_rules).length)
        add("runtime:registry-rules", { kind: "registry_rules", name: "registry-rules", rules: policy.registry_rules });
    if (array(policy.trace_rules).length)
        add("runtime:trace-rules", { kind: "trace_rules", name: "trace-rules" });
    if (policy.change_profiles)
        add("runtime:change-profile", { kind: "change_profile", name: "change-profiles" });
    if (policy.integration)
        add("runtime:integration", { kind: "integration", name: "integration" });
    add("surface-debt", { kind: "surface_debt", name: "surface-debt", debt: changeIntent?.surface_debt });
    array(policy.cochange_rules).forEach((rule, index) => add(`cochange:${index}`, { kind: "implies_nonempty", name: "cochange", ...rule }));
    if (changeIntent) {
        add("change-intent:scope", { kind: "scope_paths", name: "change-intent-scope", patterns: changeIntent.scope });
        add("change-intent:must-touch", { kind: "require_paths", name: "must-touch", patterns: changeIntent.must_touch });
        add("change-intent:must-not-touch", { kind: "forbid_paths", name: "must-not-touch", patterns: changeIntent.must_not_touch, changeIntent: true });
    }
    return program;
}
export const runtimeConstraints = (program) => program.flatMap((entry) => entry.runtime ? [{ key: entry.key, ...entry.runtime }] : []);
const comparisonConstraints = (policy) => compileConstraintProgram(policy).flatMap((entry) => entry.strictness ? [{ key: entry.key, ...entry.strictness }] : []);
function canonical(value) { if (Array.isArray(value))
    return value.map(canonical); if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const clone = (value) => value === undefined ? undefined : structuredClone(value);
function unknownProjection(policy = {}) {
    const copy = clone(policy) || {};
    delete copy.enforcement;
    delete copy.diff_rules;
    delete copy.size_rules;
    delete copy.document_relations;
    if (copy.paths) {
        for (const field of ["forbidden", "governance_paths", "operational_paths", "canonical_docs"])
            delete copy.paths[field];
        if (!Object.keys(copy.paths).length)
            delete copy.paths;
    }
    if (copy.integration) {
        delete copy.integration.workflows;
        if (!Object.keys(copy.integration).length)
            delete copy.integration;
    }
    return copy;
}
const relaxation = (entry, before, after = null, kind = entry.weakenKind, message = null, extra = {}) => ({
    kind, ...(entry.rule_id ? { rule_id: entry.rule_id } : {}), ...(entry.field ? { field: entry.field } : {}), ...(entry.workflow_id ? { workflow_id: entry.workflow_id } : {}), pointer: entry.pointer, before, after,
    message: message || entry.message?.(before, after) || entry.removeMessage, ...extra,
});
const incomparable = (entry, before, after) => ({ kind: "policy_incomparable", pointer: entry.pointer, before, after, message: entry.incomparableMessage || `policy constraint ${entry.key} changed with no proven monotonic ordering` });
export function compareConstraintPrograms(basePolicy, headPolicy) {
    if (!basePolicy || !headPolicy)
        return { relation: "equal", relaxations: [], incomparable: [] };
    const base = comparisonConstraints(basePolicy), head = new Map(comparisonConstraints(headPolicy).map((item) => [item.key, item]));
    const relaxations = [], incomparableChanges = [], removedOwners = new Set();
    let tightened = false, changed = false;
    for (const entry of base) {
        if (entry.owner && removedOwners.has(entry.owner))
            continue;
        const next = head.get(entry.key);
        if (!next) {
            if (entry.removeKind) {
                relaxations.push(relaxation(entry, entry.removeBefore ?? entry.raw ?? entry.value, entry.removeAfter ?? null, entry.removeKind, entry.removeMessage));
                changed = true;
                if (entry.relation === "required_entity")
                    removedOwners.add(entry.key);
            }
            continue;
        }
        if (entry.relation === "lower_stricter" || entry.relation === "higher_stricter") {
            const weaker = entry.relation === "lower_stricter" ? next.value > entry.value : next.value < entry.value;
            const stricter = entry.relation === "lower_stricter" ? next.value < entry.value : next.value > entry.value;
            if (weaker)
                relaxations.push(relaxation(entry, entry.raw ?? entry.value, next.raw ?? next.value));
            tightened ||= stricter;
            changed ||= next.value !== entry.value;
        }
        else if (["superset_stricter", "subset_stricter"].includes(entry.relation)) {
            const before = new Set(entry.value), after = new Set(next.value), removed = entry.value.filter((item) => !after.has(item)), added = next.value.filter((item) => !before.has(item));
            const weaker = entry.relation === "superset_stricter" ? removed : added;
            for (const item of weaker)
                relaxations.push(relaxation(entry, item, null, entry.weakenKind, entry.message(item), { [entry.itemField]: item }));
            tightened ||= (entry.relation === "superset_stricter" ? added : removed).length > 0;
            changed ||= removed.length > 0 || added.length > 0;
        }
        else if (entry.relation === "equal_or_incomparable" && !same(entry.value, next.value)) {
            incomparableChanges.push(incomparable(entry, entry.value, next.value));
            changed = true;
        }
    }
    const baseKeys = new Set(base.map((entry) => entry.key));
    for (const item of head.values())
        if (!baseKeys.has(item.key)) {
            changed = true;
            if (["required_entity", "lower_stricter", "higher_stricter"].includes(item.relation))
                tightened = true;
            else if (item.relation === "subset_stricter" && item.value.length)
                for (const added of item.value)
                    incomparableChanges.push(incomparable(item, [], [added]));
            else if (item.relation === "equal_or_incomparable" && !item.owner)
                incomparableChanges.push(incomparable(item, null, item.value));
        }
    const beforeUnknown = unknownProjection(basePolicy), afterUnknown = unknownProjection(headPolicy);
    if (!same(beforeUnknown, afterUnknown)) {
        incomparableChanges.push({ kind: "policy_incomparable", pointer: "/", before: beforeUnknown, after: afterUnknown, message: "policy sections outside the Constraint Program changed and require explicit governance review" });
        changed = true;
    }
    const relation = relaxations.length ? "weaker" : incomparableChanges.length ? "incomparable" : tightened || changed ? "stricter" : "equal";
    return { relation, relaxations, incomparable: incomparableChanges };
}
