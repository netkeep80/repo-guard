import { normalizeProjectionBuildRecord, normalizeProjectionModel, } from "./projection-model.mjs";
function contentIdentity(path, region) {
    return {
        source: "repository",
        selector: {
            kind: "content_identity",
            path,
            snapshot: "state",
            algorithm: "sha256",
            ...(region ? { region } : {}),
        },
        type: "scalar",
    };
}
function scalarIdentityRelation(relationId, fact, expectedDigest, metadata) {
    return {
        relation_id: relationId,
        primitive: "scalar_equals_literal",
        operands: {
            source: fact,
        },
        parameters: {
            value: expectedDigest,
            ...metadata,
        },
    };
}
function documentPointerRegion(path, pointer) {
    if (pointer === undefined)
        return undefined;
    const lower = path.toLowerCase();
    const format = lower.endsWith(".json")
        ? "json"
        : lower.endsWith(".yaml") || lower.endsWith(".yml")
            ? "yaml"
            : null;
    if (!format) {
        throw new Error(`Projection repository_subject pointer requires a JSON/YAML resource path: "${path}"`);
    }
    return { kind: "document_pointer", format, pointer };
}
export function projectionSourceContentFact(source) {
    if (source.kind === "repository_content")
        return contentIdentity(source.path);
    return contentIdentity(source.representation.path, documentPointerRegion(source.representation.path, source.representation.pointer));
}
export function projectionTargetContentFact(model) {
    let region;
    if (model.target.ownership === "hybrid") {
        if (model.target.locator?.kind !== "markdown_owned_block") {
            throw new Error(`ProjectionModel "${model.id}" hybrid target requires a markdown_owned_block locator for address-local identity`);
        }
        region = {
            kind: "markdown_owned_block",
            anchor_id: model.target.locator.anchor_id,
            block_id: model.target.locator.block_id,
            begin_marker: model.target.locator.begin_marker,
            end_marker: model.target.locator.end_marker,
        };
    }
    return contentIdentity(model.target.path, region);
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
        return scalarIdentityRelation(`${model.id}:source:${source.id}`, projectionSourceContentFact(source), identity.digest, {
            projection_id: model.id,
            projection_role: "source",
            source_id: source.id,
        });
    });
    relations.push(scalarIdentityRelation(`${model.id}:target`, projectionTargetContentFact(model), build.output_identity.digest, {
        projection_id: model.id,
        projection_role: "target",
    }));
    return relations;
}
