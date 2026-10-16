import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeDocumentFact, parseJson, parseYaml } from "./document-facts.mjs";
import { compareSets } from "./checks/relation-kernel.mjs";
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
function uniqueStrings(value, label) {
    const values = array(value, label).map((item, index) => nonEmptyString(item, `${label}[${index}]`));
    const unique = new Set(values);
    if (unique.size !== values.length)
        fail(label, "must not contain duplicates");
    return [...unique].sort();
}
export function evaluateVNextJustificationClosure(input) {
    const trustedRootIds = uniqueStrings(input?.trustedRootIds, "VNextJustification.trustedRootIds");
    if (!Array.isArray(input?.requirements))
        fail("VNextJustification.requirements", "must be an array");
    const trackedFiles = normalizeDocumentFact(input?.trackedFiles, "repository_path_set", "VNextJustification.trackedFiles");
    const requirements = input.requirements.map((raw, index) => {
        const label = `VNextJustification.requirements[${index}]`;
        const value = object(raw, label);
        exactFields(value, ["id", "derives_from", "artifacts"], label);
        const id = nonEmptyString(value.id, `${label}.id`);
        const derivesFrom = value.derives_from === undefined ? [] : uniqueStrings(value.derives_from, `${label}.derives_from`);
        const artifacts = value.artifacts === undefined ? [] : array(value.artifacts, `${label}.artifacts`).map((rawArtifact, artifactIndex) => {
            const artifactLabel = `${label}.artifacts[${artifactIndex}]`;
            const artifact = object(rawArtifact, artifactLabel);
            exactFields(artifact, ["path", "relations"], artifactLabel);
            const path = repositoryPath(artifact.path, `${artifactLabel}.path`);
            const relations = array(artifact.relations, `${artifactLabel}.relations`).map((rawRelation, relationIndex) => relationKind(rawRelation, `${artifactLabel}.relations[${relationIndex}]`));
            if (!relations.length)
                fail(`${artifactLabel}.relations`, "must contain at least one relation");
            if (new Set(relations).size !== relations.length)
                fail(`${artifactLabel}.relations`, "must not contain duplicates");
            return { path, relations: [...relations].sort() };
        });
        const artifactPaths = artifacts.map((artifact) => artifact.path);
        if (new Set(artifactPaths).size !== artifactPaths.length)
            fail(`${label}.artifacts`, "must not contain duplicate paths");
        return { id, derivesFrom, artifacts };
    });
    const byId = new Map();
    for (const requirement of requirements) {
        if (byId.has(requirement.id))
            fail("VNextJustification.requirements", `duplicate requirement id "${requirement.id}"`);
        byId.set(requirement.id, requirement);
    }
    const reasons = [];
    const children = new Map();
    const dependents = new Map();
    for (const requirement of requirements) {
        for (const parent of requirement.derivesFrom) {
            if (!byId.has(parent)) {
                reasons.push(`unknown_requirement_parent:${requirement.id}:${parent}`);
                continue;
            }
            const childList = children.get(parent) || [];
            childList.push(requirement.id);
            children.set(parent, childList);
            const reverse = dependents.get(parent) || new Set();
            reverse.add(requirement.id);
            dependents.set(parent, reverse);
        }
    }
    for (const values of children.values())
        values.sort();
    const reachable = new Set();
    const explanations = new Map();
    const queue = [];
    for (const root of trustedRootIds) {
        if (!byId.has(root)) {
            reasons.push(`trusted_root_missing:${root}`);
            continue;
        }
        if (!reachable.has(root)) {
            reachable.add(root);
            explanations.set(root, [root]);
            queue.push(root);
        }
    }
    queue.sort();
    while (queue.length) {
        const parent = queue.shift();
        for (const child of children.get(parent) || []) {
            if (reachable.has(child))
                continue;
            reachable.add(child);
            explanations.set(child, [...(explanations.get(parent) || [parent]), child]);
            queue.push(child);
        }
        queue.sort();
    }
    const allRequirementIds = [...byId.keys()].sort();
    const reachableRequirements = [...reachable].sort();
    const requirementComparison = compareSets(allRequirementIds, reachableRequirements, "equal");
    const orphanRequirements = [...requirementComparison.missing].sort();
    for (const id of orphanRequirements)
        reasons.push(`orphan_requirement:${id}`);
    const justified = new Set();
    const artifactExplanations = new Map();
    for (const requirementId of reachableRequirements) {
        const requirement = byId.get(requirementId);
        for (const artifact of requirement.artifacts) {
            if (!artifact.relations.includes("requires"))
                continue;
            justified.add(artifact.path);
            const paths = artifactExplanations.get(artifact.path) || [];
            paths.push([...(explanations.get(requirementId) || [requirementId]), `requires:${artifact.path}`]);
            artifactExplanations.set(artifact.path, paths);
        }
    }
    const justifiedArtifacts = [...justified].sort();
    const artifactComparison = compareSets(trackedFiles, justifiedArtifacts, "equal");
    const orphanTrackedArtifacts = [...artifactComparison.missing].sort();
    const missingRequiredArtifacts = [...artifactComparison.extra].sort();
    for (const path of orphanTrackedArtifacts)
        reasons.push(`orphan_tracked_artifact:${path}`);
    for (const path of missingRequiredArtifacts)
        reasons.push(`required_artifact_not_tracked:${path}`);
    const requirementExplanations = Object.fromEntries([...explanations.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const artifactExplanationObject = Object.fromEntries([...artifactExplanations.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, paths]) => [path, paths.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
    const requirementDependents = Object.fromEntries([...dependents.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, values]) => [id, [...values].sort()]));
    const uniqueReasons = [...new Set(reasons)].sort();
    return {
        ok: uniqueReasons.length === 0,
        reasons: uniqueReasons,
        reachableRequirements,
        orphanRequirements,
        justifiedArtifacts,
        orphanTrackedArtifacts,
        missingRequiredArtifacts,
        requirementExplanations,
        artifactExplanations: artifactExplanationObject,
        requirementDependents,
    };
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
    const governed = Array.isArray(policy?.paths?.governance_paths) ? policy.paths.governance_paths : [];
    if (!closed && !governed.length)
        return [];
    const sources = closed ? policy?.anchors?.types?.requirement_artifact_path?.sources || [] : policy?.anchors?.types?.requirement_id?.sources || [];
    return normalizeAuthorityScope(sources.flatMap((source) => {
        if (typeof source.glob !== "string")
            return [];
        if (closed && source.kind === "structured_pointer" && source.pointer === "/artifacts" && source.item_field === "path"
            && (source.format === "json" || source.format === "yaml"))
            return [{ glob: source.glob, format: source.format }];
        if (!closed && source.kind === "structured_pointer" && source.pointer === "/id" && source.format === "yaml")
            return [{ glob: source.glob, format: "yaml" }];
        if (!closed && source.kind === "json_field" && source.field === "id")
            return [{ glob: source.glob, format: "json" }];
        return [];
    }));
}
export function buildRequirementAuthorityFromSnapshot(input) {
    const scope = requirementAuthorityScopeFromPolicy(input.policy);
    if (!scope.length)
        return null;
    const closed = input.policy?.document_relations?.rules?.some((rule) => rule.id === "requirements-strict:closed-repository") === true;
    const patterns = input.policy?.paths?.governance_paths;
    const governed = (Array.isArray(patterns) ? patterns : []).filter((value) => typeof value === "string").map((pattern) => pattern.endsWith("/") ? `${pattern}**` : pattern);
    const sources = [];
    for (const pathValue of [...new Set(input.trackedFiles)].sort()) {
        const path = repositoryPath(pathValue, "RequirementAuthority.trackedFiles");
        if (!closed && !matchesAny(path, governed))
            continue;
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
/**
 * A derived BASE-authorized trace transition, never an external GovernanceGrant.
 * Normative fields and existing artifact metadata must be identical.
 */
export function checkRoutineRequirementTransition(input) {
    const reasons = [];
    const delta = compareRequirementRelationGraphs(input.base, input.head);
    const basePaths = input.base.authority_manifest.map((entry) => entry.path);
    const headPaths = input.head.authority_manifest.map((entry) => entry.path);
    if (input.base.authority_scope_sha256 !== input.head.authority_scope_sha256)
        reasons.push("routine_authority_scope_changed");
    if (!isDeepStrictEqual(basePaths, headPaths))
        reasons.push("routine_requirement_sources_changed");
    if (!delta.add.length || delta.remove.length)
        reasons.push("routine_requires_additive_relation_delta");
    const changed = new Map(input.changedFiles.map((file) => [file.path, file]));
    const tracked = new Set(input.headTrackedFiles);
    const expand = (patterns) => patterns.map((pattern) => pattern.endsWith("/") ? `${pattern}**` : pattern);
    const governance = expand(input.governancePaths), forbidden = expand(input.forbiddenPaths);
    const typed = new Set(delta.add.filter((edge) => ["implements", "verifies", "documents"].includes(edge.relation)).map((edge) => edge.object));
    if (!typed.size)
        reasons.push("routine_requires_typed_evidence");
    const grouped = new Map();
    for (const edge of delta.add) {
        const kinds = grouped.get(edge.object) || new Set();
        kinds.add(edge.relation);
        grouped.set(edge.object, kinds);
        const file = changed.get(edge.object);
        if (!file || file.status === "deleted" || file.previousPath || !tracked.has(edge.object)) {
            reasons.push(`routine_target_not_exact_changed_file:${edge.object}`);
        }
        if (edge.relation === "immutable" || matchesAny(edge.object, governance) || matchesAny(edge.object, forbidden)) {
            reasons.push(`routine_target_protected:${edge.object}`);
        }
    }
    if (input.closedRepository)
        for (const [path, kinds] of grouped) {
            if (![...kinds].some((kind) => kind === "implements" || kind === "verifies" || kind === "documents")) {
                reasons.push(`routine_untyped_closed_repository_justification:${path}`);
            }
        }
    for (const path of basePaths) {
        const rawBase = input.readFileAtRef(input.base.revision, path);
        const rawHead = input.readFileAtRef(input.head.revision, path);
        const format = input.base.authority_manifest.find((entry) => entry.path === path).format;
        if (typeof rawBase !== "string" || typeof rawHead !== "string") {
            reasons.push(`routine_requirement_snapshot_unavailable:${path}`);
            continue;
        }
        const before = object(parseSource({ path, format, content: rawBase }), `${path}:base`);
        const after = object(parseSource({ path, format, content: rawHead }), `${path}:head`);
        const normative = (root) => Object.fromEntries(Object.entries(root).filter(([key]) => key !== "artifacts"));
        if (!isDeepStrictEqual(normative(before), normative(after))) {
            reasons.push(`routine_normative_semantics_changed:${path}`);
        }
        const metadata = (root) => new Map((root.artifacts === undefined ? [] : array(root.artifacts, `${path}#/artifacts`)).map((value, index) => {
            const artifact = object(value, `${path}#/artifacts/${index}`);
            const name = repositoryPath(artifact.path, `${path}#/artifacts/${index}/path`);
            return [name, Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "relations"))];
        }));
        const oldMetadata = metadata(before), newMetadata = metadata(after);
        for (const [artifactPath, oldValue] of oldMetadata) {
            if (newMetadata.has(artifactPath) && !isDeepStrictEqual(oldValue, newMetadata.get(artifactPath))) {
                reasons.push(`routine_artifact_authority_changed:${artifactPath}`);
            }
        }
        for (const [artifactPath, current] of newMetadata) {
            if (!oldMetadata.has(artifactPath) && ["governance", "requirement", "immutable", "authority", "contract"].includes(String(current.role ?? "").toLowerCase())) {
                reasons.push(`routine_new_protected_artifact_role:${artifactPath}`);
            }
        }
    }
    const requirementPaths = basePaths.filter((path) => changed.has(path));
    if (!requirementPaths.length)
        reasons.push("routine_requirement_diff_missing");
    return { ok: reasons.length === 0, reasons, requirement_paths: reasons.length === 0 ? requirementPaths : [] };
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
