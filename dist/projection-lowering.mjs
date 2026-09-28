import { normalizeProjectionBuildRecord, normalizeProjectionModel, } from "./projection-model.mjs";
function contentIdentity(path) {
    return {
        source: "repository",
        selector: {
            kind: "content_identity",
            path,
            snapshot: "state",
            algorithm: "sha256",
        },
        type: "scalar",
    };
}
function scalarIdentityRelation(relationId, path, expectedDigest, metadata) {
    return {
        relation_id: relationId,
        primitive: "scalar_equals_literal",
        operands: {
            source: contentIdentity(path),
        },
        parameters: {
            value: expectedDigest,
            ...metadata,
        },
    };
}
function buildRecordFor(modelValue, buildValue) {
    const model = normalizeProjectionModel(modelValue);
    const build = normalizeProjectionBuildRecord(buildValue, model);
    return { model, build };
}
export function lowerProjectionVerification(modelValue, buildValue) {
    const { model, build } = buildRecordFor(modelValue, buildValue);
    const identities = new Map(build.source_identities.map((identity) => [identity.source_id, identity]));
    const relations = model.sources.map((source) => {
        const identity = identities.get(source.id);
        if (!identity) {
            throw new Error(`ProjectionBuildRecord missing normalized source identity "${source.id}"`);
        }
        return scalarIdentityRelation(`${model.id}:source:${source.id}`, source.path, identity.digest, {
            projection_id: model.id,
            projection_role: "source",
            source_id: source.id,
        });
    });
    if (model.target.ownership === "hybrid") {
        throw new Error(`ProjectionModel "${model.id}" hybrid target requires an address-local identity fact; whole-file content_identity is not valid for HYBRID ownership`);
    }
    relations.push(scalarIdentityRelation(`${model.id}:target`, model.target.path, build.output_identity.digest, {
        projection_id: model.id,
        projection_role: "target",
    }));
    return relations;
}
