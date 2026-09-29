import { readFact } from "./document-facts.mjs";
import { evaluatePrimitiveRelation } from "./checks/relation-kernel.mjs";
import { lowerProjectionVerification } from "./projection-lowering.mjs";
import { normalizeProjectionModel, } from "./projection-model.mjs";
function changedSourceFact(path) {
    return {
        source: "diff",
        selector: {
            kind: "changed_paths",
            patterns: [path],
            include_previous_paths: true,
        },
        type: "repository_path_set",
    };
}
function impactOf(model, facts) {
    const affectedSources = [];
    for (const source of model.sources) {
        const changed = readFact(facts, changedSourceFact(source.path));
        if (!changed.ok) {
            throw new Error(`Projection analysis impact unavailable for "${model.id}": ${changed.error.message}`);
        }
        if (Array.isArray(changed.value) && changed.value.length > 0) {
            affectedSources.push(source.id);
        }
    }
    return {
        impact: affectedSources.length ? "AFFECTED" : "UNAFFECTED",
        affected_sources: affectedSources,
    };
}
function relationRole(relation) {
    const role = relation.parameters.projection_role;
    return role === "source" || role === "target" ? role : null;
}
function sourceReadable(result) {
    return result.data?.source?.ok !== false;
}
export function analyzeProjection(modelValue, buildValue, facts) {
    let model;
    try {
        model = normalizeProjectionModel(modelValue);
    }
    catch {
        return {
            projection_id: null,
            freshness: "BROKEN",
            failed_relations: [],
            affected_sources: [],
        };
    }
    const impact = impactOf(model, facts);
    let relations;
    try {
        relations = lowerProjectionVerification(model, buildValue);
    }
    catch {
        return {
            projection_id: model.id,
            freshness: "BROKEN",
            ...impact,
            failed_relations: [],
        };
    }
    const failed = [];
    for (const relation of relations) {
        let evaluated;
        try {
            evaluated = evaluatePrimitiveRelation(facts, relation);
        }
        catch {
            failed.push({
                relation,
                result: { ok: false, data: { source: { ok: false } } },
            });
            continue;
        }
        const result = evaluated;
        if (!result?.ok)
            failed.push({ relation, result });
    }
    if (!failed.length) {
        return {
            projection_id: model.id,
            freshness: "CURRENT",
            ...impact,
            failed_relations: [],
        };
    }
    const broken = failed.some(({ relation, result }) => relationRole(relation) === "target" || !sourceReadable(result));
    return {
        projection_id: model.id,
        freshness: broken ? "BROKEN" : "STALE",
        ...impact,
        failed_relations: failed.map(({ relation }) => relation.relation_id),
    };
}
