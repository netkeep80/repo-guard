import { createHash } from "node:crypto";
import { normalizeDocumentFact, parseJson, parseYaml } from "./document-facts.mjs";
import { matchesAny } from "./utils/path-patterns.mjs";
export const REQUIREMENT_RELATION_KINDS = [
    "requires",
    "implements",
    "verifies",
    "documents",
    "immutable",
];
const RELATION_KINDS = new Set(REQUIREMENT_RELATION_KINDS);
const EXACT_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
function fail(label, message) {
    throw new Error(`${label}: ${message}`);
}
function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fail(label, "must be an object");
    return value;
}
function exactFields(value, allowed, label) {
    const set = new Set(allowed);
    for (const field of Object.keys(value))
        if (!set.has(field))
            fail(label, `unknown field "${field}" not allowed`);
}
function array(value, label) {
    if (!Array.isArray(value))
        return fail(label, "must be an array");
    return value;
}
function nonEmptyString(value, label) {
    if (typeof value !== "string" || !value.trim())
        return fail(label, "must be a non-empty string");
    return value.trim();
}
function repositoryPath(value, label) {
    try {
        return normalizeDocumentFact(value, "repository_path", label);
    }
    catch (error) {
        return fail(label, error instanceof Error ? error.message : String(error));
    }
}
function exactRevision(value, label) {
    const revision = nonEmptyString(value, label).toLowerCase();
    if (!EXACT_COMMIT_SHA.test(revision))
        return fail(label, "must be an exact 40-hex commit SHA");
    return revision;
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function sha256Value(value, label) {
    const digest = nonEmptyString(value, label).toLowerCase();
    if (!SHA256.test(digest))
        return fail(label, "must be a 64-hex sha256 digest");
    return digest;
}
function relationKind(value, label) {
    const relation = nonEmptyString(value, label);
    if (!RELATION_KINDS.has(relation))
        return fail(label, `unknown relation "${relation}"`);
    return relation;
}
function relationIdentity(value) {
    return { subject: value.subject, relation: value.relation, object: value.object };
}
function identityKey(value) {
    return JSON.stringify([value.subject, value.relation, value.object]);
}
function compareIdentities(left, right) {
    return identityKey(left).localeCompare(identityKey(right));
}
function canonicalIdentities(values) {
    return [...values].map((value) => ({ ...value })).sort(compareIdentities);
}
function normalizeAuthorityScope(values) {
    const byGlob = new Map();
    for (const [index, value] of (values || []).entries()) {
        const glob = nonEmptyString(value?.glob, `RequirementAuthority.scope[${index}].glob`);
        const format = value?.format;
        if (format !== "json" && format !== "yaml")
            fail(`RequirementAuthority.scope[${index}].format`, "must be json or yaml");
        const previous = byGlob.get(glob);
        if (previous && previous !== format)
            fail(`RequirementAuthority.scope[${index}]`, `glob "${glob}" has conflicting formats`);
        byGlob.set(glob, format);
    }
    return [...byGlob.entries()].map(([glob, format]) => ({ glob, format })).sort((left, right) => left.glob.localeCompare(right.glob) || left.format.localeCompare(right.format));
}
function parseSource(source) {
    if (source.format === "json")
        return parseJson(source.content);
    if (source.format === "yaml")
        return parseYaml(source.content);
    const exhaustive = source.format;
    return fail(source.path, `unsupported format "${String(exhaustive)}"`);
}
function normalizeSourceRelations(source, snapshot, revision) {
    const root = object(parseSource(source), source.path);
    const subject = nonEmptyString(root.id, `${source.path}#/id`);
    const artifacts = root.artifacts === undefined ? [] : array(root.artifacts, `${source.path}#/artifacts`);
    const seenPaths = new Set();
    const relations = [];
    for (const [artifactIndex, artifactValue] of artifacts.entries()) {
        const artifactPointer = `/artifacts/${artifactIndex}`;
        const artifact = object(artifactValue, `${source.path}#${artifactPointer}`);
        exactFields(artifact, ["path", "relations", "role"], `${source.path}#${artifactPointer}`);
        const path = repositoryPath(artifact.path, `${source.path}#${artifactPointer}/path`);
        if (seenPaths.has(path))
            fail(`${source.path}#${artifactPointer}/path`, `duplicate artifact path "${path}"`);
        seenPaths.add(path);
        if (artifact.relations === undefined) {
            relations.push({
                subject,
                relation: "requires",
                object: path,
                provenance: {
                    source_path: source.path,
                    subject_pointer: "/id",
                    artifact_pointer: `${artifactPointer}/path`,
                    relation_pointer: `${artifactPointer}/path`,
                    relation_origin: "legacy_artifact_presence",
                    snapshot,
                    revision,
                },
            });
            continue;
        }
        const rawRelations = array(artifact.relations, `${source.path}#${artifactPointer}/relations`);
        if (!rawRelations.length)
            fail(`${source.path}#${artifactPointer}/relations`, "must contain at least one relation");
        const seenRelations = new Set();
        for (const [relationIndex, relationValue] of rawRelations.entries()) {
            const relationPointer = `${artifactPointer}/relations/${relationIndex}`;
            const relation = relationKind(relationValue, `${source.path}#${relationPointer}`);
            if (seenRelations.has(relation))
                fail(`${source.path}#${relationPointer}`, `duplicate relation "${relation}"`);
            seenRelations.add(relation);
            relations.push({
                subject,
                relation,
                object: path,
                provenance: {
                    source_path: source.path,
                    subject_pointer: "/id",
                    artifact_pointer: `${artifactPointer}/path`,
                    relation_pointer: relationPointer,
                    relation_origin: "explicit",
                    snapshot,
                    revision,
                },
            });
        }
        if (!seenRelations.has("requires")) {
            fail(`${source.path}#${artifactPointer}/relations`, `artifact "${path}" must explicitly include "requires"`);
        }
    }
    return { subject, relations };
}
export function normalizeRequirementAuthority(input) {
    const snapshot = input?.snapshot;
    if (snapshot !== "base" && snapshot !== "head")
        fail("RequirementAuthority.snapshot", "must be base or head");
    const revision = exactRevision(input?.revision, "RequirementAuthority.revision");
    const scope = normalizeAuthorityScope(input?.scope);
    if (!Array.isArray(input?.sources))
        fail("RequirementAuthority.sources", "must be an array");
    const sources = input.sources.map((value, index) => {
        const label = `RequirementAuthority.sources[${index}]`;
        const path = repositoryPath(value.path, `${label}.path`);
        if (value.format !== "json" && value.format !== "yaml")
            fail(`${label}.format`, "must be json or yaml");
        if (typeof value.content !== "string")
            fail(`${label}.content`, "must be UTF-8 text");
        return { path, format: value.format, content: value.content };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const seenSourcePaths = new Set();
    const seenSubjects = new Map();
    const relations = [];
    const manifest = [];
    for (const source of sources) {
        if (seenSourcePaths.has(source.path))
            fail(source.path, "duplicate authority source path");
        seenSourcePaths.add(source.path);
        const normalized = normalizeSourceRelations(source, snapshot, revision);
        const previous = seenSubjects.get(normalized.subject);
        if (previous)
            fail(source.path, `duplicate requirement id "${normalized.subject}" also declared by "${previous}"`);
        seenSubjects.set(normalized.subject, source.path);
        relations.push(...normalized.relations);
        manifest.push({ path: source.path, format: source.format, sha256: sha256(source.content) });
    }
    relations.sort((left, right) => compareIdentities(relationIdentity(left), relationIdentity(right)));
    const identities = relations.map(relationIdentity);
    const authorityScopeSha256 = sha256(JSON.stringify(scope));
    return {
        snapshot,
        revision,
        authority_scope: scope,
        authority_scope_sha256: authorityScopeSha256,
        authority_manifest: manifest,
        authority_sha256: sha256(JSON.stringify({ scope, manifest })),
        graph_sha256: sha256(JSON.stringify(identities)),
        relations,
    };
}
export function requirementAuthorityScopeFromPolicy(policy) {
    const closed = policy?.document_relations?.rules?.some((rule) => rule.id === "requirements-strict:closed-repository" && rule.kind === "set_equal") === true;
    if (!closed)
        return [];
    const sources = policy?.anchors?.types?.requirement_artifact_path?.sources || [];
    return normalizeAuthorityScope(sources.flatMap((source) => {
        if (source.kind !== "structured_pointer" || source.pointer !== "/artifacts" || source.item_field !== "path")
            return [];
        if ((source.format !== "json" && source.format !== "yaml") || typeof source.glob !== "string")
            return [];
        return [{ glob: source.glob, format: source.format }];
    }));
}
export function buildRequirementAuthorityFromSnapshot(input) {
    const scope = requirementAuthorityScopeFromPolicy(input.policy);
    if (!scope.length)
        return null;
    const sources = [];
    for (const pathValue of [...new Set(input.trackedFiles)].sort()) {
        const path = repositoryPath(pathValue, "RequirementAuthority.trackedFiles");
        const matching = scope.filter((entry) => matchesAny(path, [entry.glob]));
        if (!matching.length)
            continue;
        const formats = [...new Set(matching.map((entry) => entry.format))];
        if (formats.length !== 1)
            fail(path, "matches requirement authority globs with conflicting formats");
        const raw = input.readFileAtRef(input.revision, path);
        if (raw === null || raw === undefined)
            fail(path, `${input.snapshot.toUpperCase()} requirement authority source is unavailable`);
        sources.push({ path, format: formats[0], content: String(raw) });
    }
    return normalizeRequirementAuthority({ snapshot: input.snapshot, revision: input.revision, scope, sources });
}
function uniqueSortedStrings(values) {
    return [...new Set(values)].sort();
}
export function projectRequirementTransactionEvidence(input) {
    const changedIdentityPaths = new Set();
    const changedHeadPaths = new Set();
    for (const file of input.changedFiles) {
        changedIdentityPaths.add(file.path);
        if (file.previousPath)
            changedIdentityPaths.add(file.previousPath);
        if (file.status !== "deleted")
            changedHeadPaths.add(file.path);
    }
    const implementationRelations = [...input.base.relations, ...input.head.relations].filter((relation) => relation.relation === "implements"
        && relation.object.startsWith("src/")
        && changedIdentityPaths.has(relation.object));
    const verificationRelations = input.head.relations.filter((relation) => relation.relation === "verifies"
        && relation.object.startsWith("tests/")
        && changedHeadPaths.has(relation.object));
    const implementationRequirements = uniqueSortedStrings(implementationRelations.map((relation) => relation.subject));
    const verificationRequirements = uniqueSortedStrings(verificationRelations.map((relation) => relation.subject));
    const verificationSet = new Set(verificationRequirements);
    return {
        changed_implementation_paths: uniqueSortedStrings(implementationRelations.map((relation) => relation.object)),
        changed_verification_paths: uniqueSortedStrings(verificationRelations.map((relation) => relation.object)),
        implementation_requirements: implementationRequirements,
        verification_requirements: verificationRequirements,
        overlap_requirements: implementationRequirements.filter((subject) => verificationSet.has(subject)),
    };
}
export function compareRequirementRelationGraphs(base, head) {
    const baseMap = new Map(base.relations.map((relation) => [identityKey(relationIdentity(relation)), relationIdentity(relation)]));
    const headMap = new Map(head.relations.map((relation) => [identityKey(relationIdentity(relation)), relationIdentity(relation)]));
    return {
        add: canonicalIdentities([...headMap.entries()].filter(([key]) => !baseMap.has(key)).map(([, value]) => value)),
        remove: canonicalIdentities([...baseMap.entries()].filter(([key]) => !headMap.has(key)).map(([, value]) => value)),
    };
}
function normalizeGrantIdentity(value, label) {
    const input = object(value, label);
    exactFields(input, ["subject", "relation", "object"], label);
    return {
        subject: nonEmptyString(input.subject, `${label}.subject`),
        relation: relationKind(input.relation, `${label}.relation`),
        object: repositoryPath(input.object, `${label}.object`),
    };
}
function normalizeGrantIdentities(value, label) {
    if (value === undefined)
        return [];
    const normalized = array(value, label).map((item, index) => normalizeGrantIdentity(item, `${label}[${index}]`)).sort(compareIdentities);
    const seen = new Set();
    for (const item of normalized) {
        const key = identityKey(item);
        if (seen.has(key))
            fail(label, `duplicate relation tuple ${key}`);
        seen.add(key);
    }
    return normalized;
}
export function normalizeRequirementTransitionGrant(value) {
    const input = object(value, "RequirementTransitionGrant");
    exactFields(input, ["base_authority_sha256", "expected_head_authority_sha256", "add", "remove"], "RequirementTransitionGrant");
    return {
        base_authority_sha256: sha256Value(input.base_authority_sha256, "RequirementTransitionGrant.base_authority_sha256"),
        expected_head_authority_sha256: sha256Value(input.expected_head_authority_sha256, "RequirementTransitionGrant.expected_head_authority_sha256"),
        add: normalizeGrantIdentities(input.add, "RequirementTransitionGrant.add"),
        remove: normalizeGrantIdentities(input.remove, "RequirementTransitionGrant.remove"),
    };
}
function sameIdentities(left, right) {
    return JSON.stringify(canonicalIdentities(left)) === JSON.stringify(canonicalIdentities(right));
}
export function checkRequirementTransition(input) {
    const actual = compareRequirementRelationGraphs(input.base, input.head);
    const authorityScopeChanged = input.base.authority_scope_sha256 !== input.head.authority_scope_sha256;
    const required = authorityScopeChanged || actual.add.length > 0 || actual.remove.length > 0;
    const reasons = [];
    if (!required) {
        if (input.grant !== undefined && input.grant !== null)
            reasons.push("requirement_transition_grant_without_relation_delta");
        return {
            ok: reasons.length === 0,
            required: false,
            authorized: false,
            reasons,
            actual_delta: actual,
            base_authority_sha256: input.base.authority_sha256,
            head_authority_sha256: input.head.authority_sha256,
            authority_scope_changed: authorityScopeChanged,
        };
    }
    let grant = null;
    if (input.grant === undefined || input.grant === null)
        reasons.push("requirement_transition_grant_missing");
    else {
        try {
            grant = normalizeRequirementTransitionGrant(input.grant);
        }
        catch (error) {
            reasons.push(`requirement_transition_grant_invalid:${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const trusted = input.trustedAuthorizer?.trusted === true && input.trustedAuthorizer?.source === "repository_permission";
    if (!trusted)
        reasons.push("requirement_transition_authorizer_untrusted");
    if (grant) {
        if (grant.base_authority_sha256 !== input.base.authority_sha256)
            reasons.push("requirement_transition_base_authority_mismatch");
        if (grant.expected_head_authority_sha256 !== input.head.authority_sha256)
            reasons.push("requirement_transition_head_authority_mismatch");
        if (!sameIdentities(grant.add, actual.add))
            reasons.push("requirement_transition_added_relations_mismatch");
        if (!sameIdentities(grant.remove, actual.remove))
            reasons.push("requirement_transition_removed_relations_mismatch");
    }
    return {
        ok: reasons.length === 0,
        required: true,
        authorized: reasons.length === 0,
        reasons,
        actual_delta: actual,
        base_authority_sha256: input.base.authority_sha256,
        head_authority_sha256: input.head.authority_sha256,
        authority_scope_changed: authorityScopeChanged,
    };
}
