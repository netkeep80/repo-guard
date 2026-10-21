import { createHash } from "node:crypto";
import { normalizeDocumentFact } from "./document-facts.mjs";
import { normalizeSubjectRef } from "./runtime/subject-relations.mjs";
function fail(label, message) {
    throw new Error(`${label}: ${message}`);
}
function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail(label, "must be an object");
    }
    return value;
}
function fields(value, allowed, label) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allowedSet.has(key))
            fail(label, `unknown field "${key}" not allowed`);
    }
}
function stringValue(value, label) {
    if (typeof value !== "string" || !value.trim())
        return fail(label, "must be a non-empty string");
    return value.trim();
}
function identifier(value, label) {
    const normalized = stringValue(value, label);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
        return fail(label, `invalid identifier "${normalized}"`);
    }
    return normalized;
}
function anchorIdentifier(value, label) {
    const normalized = stringValue(value, label);
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(normalized)) {
        return fail(label, `invalid Markdown anchor "${normalized}"`);
    }
    return normalized;
}
function repositoryPath(value, label) {
    try {
        return normalizeDocumentFact(value, "repository_path", label);
    }
    catch (error) {
        return fail(label, error instanceof Error ? error.message : String(error));
    }
}
function sha256Digest(value, label) {
    const normalized = stringValue(value, label).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized))
        return fail(label, "must be a sha256 digest");
    return normalized;
}
function sha256Algorithm(value, label) {
    if (value !== "sha256")
        return fail(label, 'algorithm must be "sha256"');
    return "sha256";
}
function array(value, label) {
    if (!Array.isArray(value))
        return fail(label, "must be an array");
    return value;
}
function normalizeSource(value, index) {
    const label = `ProjectionModel.sources[${index}]`;
    const input = object(value, label);
    if (input.kind === "repository_content") {
        fields(input, ["id", "kind", "path", "algorithm"], label);
        return {
            id: identifier(input.id, `${label}.id`),
            kind: "repository_content",
            path: repositoryPath(input.path, `${label}.path`),
            algorithm: sha256Algorithm(input.algorithm, `${label}.algorithm`),
        };
    }
    if (input.kind === "repository_subject") {
        fields(input, ["id", "kind", "subject", "representation", "algorithm"], label);
        let subject;
        try {
            subject = normalizeSubjectRef(input.subject);
        }
        catch (error) {
            fail(`${label}.subject`, error instanceof Error ? error.message : String(error));
        }
        let representation;
        if (input.representation === undefined) {
            if (subject.kind !== "resource") {
                fail(`${label}.representation`, "Requirement/Relation subjects require an exact repository Resource representation");
            }
            representation = subject;
        }
        else {
            let normalized;
            try {
                normalized = normalizeSubjectRef(input.representation);
            }
            catch (error) {
                fail(`${label}.representation`, error instanceof Error ? error.message : String(error));
            }
            if (normalized.kind !== "resource") {
                fail(`${label}.representation`, "must be a repository Resource SubjectRef");
            }
            representation = normalized;
            if (subject.kind === "resource"
                && JSON.stringify(subject) !== JSON.stringify(representation)) {
                fail(`${label}.representation`, "Resource SubjectRef representation must be the same exact resource locator");
            }
        }
        return {
            id: identifier(input.id, `${label}.id`),
            kind: "repository_subject",
            subject,
            representation,
            algorithm: sha256Algorithm(input.algorithm, `${label}.algorithm`),
        };
    }
    fail(`${label}.kind`, 'must be "repository_content" or "repository_subject"');
}
function normalizeTarget(value) {
    const label = "ProjectionModel.target";
    const input = object(value, label);
    fields(input, ["path", "ownership", "locator"], label);
    const path = repositoryPath(input.path, `${label}.path`);
    if (input.ownership !== "hybrid" && input.ownership !== "generated") {
        fail(`${label}.ownership`, 'must be "hybrid" or "generated"');
    }
    if (input.ownership === "generated") {
        if (input.locator !== undefined)
            fail(label, "generated target must not define a locator");
        return { path, ownership: "generated" };
    }
    if (input.locator === undefined)
        fail(label, "hybrid target requires a locator");
    const locator = object(input.locator, `${label}.locator`);
    if (locator.kind === "markdown_anchor") {
        fields(locator, ["kind", "anchor_id"], `${label}.locator`);
        return {
            path,
            ownership: "hybrid",
            locator: {
                kind: "markdown_anchor",
                anchor_id: anchorIdentifier(locator.anchor_id, `${label}.locator.anchor_id`),
            },
        };
    }
    if (locator.kind !== "markdown_owned_block") {
        fail(`${label}.locator.kind`, 'must be "markdown_anchor" or "markdown_owned_block"');
    }
    fields(locator, ["kind", "anchor_id", "block_id", "begin_marker", "end_marker"], `${label}.locator`);
    const blockId = anchorIdentifier(locator.block_id, `${label}.locator.block_id`);
    const beginMarker = stringValue(locator.begin_marker, `${label}.locator.begin_marker`);
    const endMarker = stringValue(locator.end_marker, `${label}.locator.end_marker`);
    if (/[\r\n]/.test(beginMarker) || /[\r\n]/.test(endMarker)) {
        fail(`${label}.locator`, "owned block markers must be single-line tokens");
    }
    if (beginMarker === endMarker) {
        fail(`${label}.locator`, "owned block markers must be distinct");
    }
    return {
        path,
        ownership: "hybrid",
        locator: {
            kind: "markdown_owned_block",
            anchor_id: anchorIdentifier(locator.anchor_id, `${label}.locator.anchor_id`),
            block_id: blockId,
            begin_marker: beginMarker,
            end_marker: endMarker,
        },
    };
}
function normalizeGenerator(value) {
    const label = "ProjectionModel.generator";
    const input = object(value, label);
    fields(input, ["contract_id"], label);
    return { contract_id: identifier(input.contract_id, `${label}.contract_id`) };
}
function normalizeRequiredEvidence(value) {
    const values = array(value, "ProjectionModel.required_evidence")
        .map((item, index) => identifier(item, `ProjectionModel.required_evidence[${index}]`))
        .sort();
    return [...new Set(values)];
}
export function normalizeProjectionModel(value) {
    const input = object(value, "ProjectionModel");
    fields(input, ["schema", "id", "sources", "target", "generator", "required_evidence"], "ProjectionModel");
    if (input.schema !== "repo-guard/projection-model/v0") {
        fail("ProjectionModel.schema", 'must be "repo-guard/projection-model/v0"');
    }
    const sources = array(input.sources, "ProjectionModel.sources")
        .map(normalizeSource)
        .sort((left, right) => left.id.localeCompare(right.id));
    if (!sources.length)
        fail("ProjectionModel.sources", "must contain at least one source dependency");
    const seen = new Set();
    for (const source of sources) {
        if (seen.has(source.id))
            fail("ProjectionModel.sources", `duplicate source id "${source.id}"`);
        seen.add(source.id);
    }
    return {
        schema: "repo-guard/projection-model/v0",
        id: identifier(input.id, "ProjectionModel.id"),
        sources,
        target: normalizeTarget(input.target),
        generator: normalizeGenerator(input.generator),
        required_evidence: normalizeRequiredEvidence(input.required_evidence),
    };
}
export function projectionModelIdentity(value) {
    const normalized = normalizeProjectionModel(value);
    return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}
function normalizeDetachedSourceIdentity(value, index) {
    const label = `ProjectionBuildRecord.source_identities[${index}]`;
    const input = object(value, label);
    fields(input, ["source_id", "algorithm", "digest"], label);
    return {
        source_id: identifier(input.source_id, `${label}.source_id`),
        algorithm: sha256Algorithm(input.algorithm, `${label}.algorithm`),
        digest: sha256Digest(input.digest, `${label}.digest`),
    };
}
function normalizeDetachedBuildGenerator(value) {
    const label = "ProjectionBuildRecord.generator";
    const input = object(value, label);
    fields(input, ["contract_id", "tool_identity"], label);
    return {
        contract_id: identifier(input.contract_id, `${label}.contract_id`),
        tool_identity: stringValue(input.tool_identity, `${label}.tool_identity`),
    };
}
function normalizeOutputIdentity(value) {
    const label = "ProjectionBuildRecord.output_identity";
    const input = object(value, label);
    fields(input, ["algorithm", "digest"], label);
    return {
        algorithm: sha256Algorithm(input.algorithm, `${label}.algorithm`),
        digest: sha256Digest(input.digest, `${label}.digest`),
    };
}
function normalizeDetachedEvidence(value) {
    return array(value, "ProjectionBuildRecord.evidence").map((item, index) => {
        const label = `ProjectionBuildRecord.evidence[${index}]`;
        const input = object(item, label);
        fields(input, ["class", "ref"], label);
        return {
            class: identifier(input.class, `${label}.class`),
            ref: stringValue(input.ref, `${label}.ref`),
        };
    }).sort((left, right) => left.class.localeCompare(right.class) || left.ref.localeCompare(right.ref));
}
export function normalizeProjectionBuildRecordDetached(value) {
    const input = object(value, "ProjectionBuildRecord");
    fields(input, [
        "schema",
        "projection_id",
        "model_identity",
        "source_identities",
        "generator",
        "configuration_digest",
        "output_identity",
        "evidence",
    ], "ProjectionBuildRecord");
    if (input.schema !== "repo-guard/projection-build-record/v0") {
        fail("ProjectionBuildRecord.schema", 'must be "repo-guard/projection-build-record/v0"');
    }
    const sourceIdentities = array(input.source_identities, "ProjectionBuildRecord.source_identities")
        .map(normalizeDetachedSourceIdentity)
        .sort((left, right) => left.source_id.localeCompare(right.source_id));
    const seen = new Set();
    for (const source of sourceIdentities) {
        if (seen.has(source.source_id)) {
            fail("ProjectionBuildRecord.source_identities", `duplicate source identity "${source.source_id}"`);
        }
        seen.add(source.source_id);
    }
    return {
        schema: "repo-guard/projection-build-record/v0",
        projection_id: identifier(input.projection_id, "ProjectionBuildRecord.projection_id"),
        model_identity: sha256Digest(input.model_identity, "ProjectionBuildRecord.model_identity"),
        source_identities: sourceIdentities,
        generator: normalizeDetachedBuildGenerator(input.generator),
        configuration_digest: sha256Digest(input.configuration_digest, "ProjectionBuildRecord.configuration_digest"),
        output_identity: normalizeOutputIdentity(input.output_identity),
        evidence: normalizeDetachedEvidence(input.evidence),
    };
}
export function normalizeProjectionBuildRecord(value, modelValue) {
    const model = normalizeProjectionModel(modelValue);
    const build = normalizeProjectionBuildRecordDetached(value);
    if (build.projection_id !== model.id) {
        fail("ProjectionBuildRecord.projection_id", `does not match ProjectionModel id "${model.id}"`);
    }
    const expectedModelIdentity = projectionModelIdentity(model);
    if (build.model_identity !== expectedModelIdentity) {
        fail("ProjectionBuildRecord.model_identity", "model identity does not match ProjectionModel");
    }
    const modelSources = new Map(model.sources.map((source) => [source.id, source]));
    const seen = new Set();
    for (const source of build.source_identities) {
        const modelSource = modelSources.get(source.source_id);
        if (!modelSource) {
            fail("ProjectionBuildRecord.source_identities", `unknown source identity "${source.source_id}"`);
        }
        if (source.algorithm !== modelSource.algorithm) {
            fail("ProjectionBuildRecord.source_identities", `algorithm differs from model source "${source.source_id}"`);
        }
        seen.add(source.source_id);
    }
    for (const source of model.sources) {
        if (!seen.has(source.id)) {
            fail("ProjectionBuildRecord.source_identities", `missing source identity "${source.id}"`);
        }
    }
    if (build.generator.contract_id !== model.generator.contract_id) {
        fail("ProjectionBuildRecord.generator", `generator contract "${build.generator.contract_id}" does not match ProjectionModel`);
    }
    const presentEvidence = new Set(build.evidence.map((item) => item.class));
    for (const requiredClass of model.required_evidence) {
        if (!presentEvidence.has(requiredClass)) {
            fail("ProjectionBuildRecord.evidence", `required evidence "${requiredClass}" is missing`);
        }
    }
    return build;
}
