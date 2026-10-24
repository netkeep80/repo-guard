import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { normalizeDocumentFact, parseYaml, resolveJsonPointer } from "../document-facts.mjs";
const fail = (code, path, message, otherPath) => ({ code, path, message, ...(otherPath ? { otherPath } : {}) });
function canonical(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (Array.isArray(value))
        return value.map(canonical);
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    throw new Error("non-JSON or non-finite canonical Requirement semantic value");
}
export const canonicalSemanticDigest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export function strictCanonicalJson(raw) {
    // JSON.parse alone loses duplicate-key evidence. Preserve its exact value semantics.
    const parsed = JSON.parse(raw);
    const document = parseDocument(raw, { schema: "core", uniqueKeys: true, merge: false, prettyErrors: false });
    const diagnostics = [...document.errors, ...document.warnings];
    if (diagnostics.length) {
        const messages = diagnostics.map(e => e.message).sort();
        throw new Error(messages.some(x => /unique|duplicate|map keys/i.test(x))
            ? "duplicate JSON key: " + messages.join("; ")
            : "invalid canonical JSON: " + messages.join("; "));
    }
    return parsed;
}
function canonicalPath(path) {
    // Reuse existing repository path fact validation; reject aliases rather than silently normalize.
    if (typeof path !== "string" || path !== normalizeDocumentFact(path, "repository_path"))
        throw new Error("noncanonical repository path");
    if (!path.startsWith("requirements/") || !/\.(?:yaml|yml|json)$/.test(path))
        throw new Error("path is not a canonical Requirement source");
    return path;
}
function exactRevision(revision) {
    if (!/^[0-9a-f]{40}$/.test(revision))
        throw new Error("exact immutable revision must be 40 lowercase hex characters");
}
function validRepository(repository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
        throw new Error("invalid repository identity");
}
export function semanticRequirementSubject(repository, requirementId, semanticDigest) {
    validRepository(repository);
    if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(requirementId))
        throw new Error("malformed RequirementId");
    if (!/^[0-9a-f]{64}$/.test(semanticDigest))
        throw new Error("invalid semantic digest");
    return { kind: "semantic_requirement", repository, requirementId, digest: semanticDigest };
}
export function exactRepresentationSubject(repository, revision, path, pointer = "") {
    validRepository(repository);
    exactRevision(revision);
    const safePath = canonicalPath(path);
    if (pointer !== "") {
        if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer))
            throw new Error("malformed JSON Pointer");
    }
    return { kind: "exact_representation", repository, revision, path: safePath, pointer };
}
export function durablePointer(pointer) {
    // Numeric path segments are valid navigation, but not a durable key identity.
    return pointer === "" || pointer.split("/").slice(1).every(part => !/^(?:0|[1-9][0-9]*)$/.test(part));
}
function parseRequirement(raw, path) {
    const value = path.endsWith(".json") ? strictCanonicalJson(raw) : parseYaml(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("canonical Requirement source requires an object");
    return value;
}
export function loadCanonicalRequirements(input) {
    const errors = [];
    const items = [];
    let identityValid = true;
    try {
        validRepository(input.repository);
        exactRevision(input.revision);
    }
    catch (error) {
        identityValid = false;
        errors.push(fail("invalid_canonical_source", "", String(error.message)));
    }
    const sorted = [...input.paths].sort();
    for (const path of sorted) {
        let safePath;
        try {
            safePath = canonicalPath(path);
        }
        catch (error) {
            errors.push(fail("unsafe_path", String(path), error.message));
            continue;
        }
        if (!identityValid)
            continue;
        try {
            const content = input.readFile(input.revision, safePath);
            if (content === null || content === undefined)
                throw new Error("canonical source missing at exact snapshot");
            const value = parseRequirement(Buffer.isBuffer(content) ? content.toString("utf8") : content, safePath);
            const id = value.id;
            if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(id)) {
                errors.push(fail("malformed_requirement_id", safePath, "missing or malformed RequirementId"));
                continue;
            }
            items.push({
                id, value,
                semantic: semanticRequirementSubject(input.repository, id, canonicalSemanticDigest(value)),
                source: { kind: "requirement_source", path: safePath },
                representation: exactRepresentationSubject(input.repository, input.revision, safePath),
            });
        }
        catch (error) {
            const message = error.message;
            errors.push(fail(/duplicate JSON key|map keys must be unique/i.test(message) ? "duplicate_json_key" : "invalid_canonical_source", safePath, message));
        }
    }
    const index = Object.create(null);
    for (const item of items) {
        if (Object.hasOwn(index, item.id))
            errors.push(fail("duplicate_requirement_id", item.source.path, "duplicate RequirementId " + item.id, index[item.id].source.path));
        else
            index[item.id] = item;
    }
    errors.sort((a, b) => a.path.localeCompare(b.path, "en") || a.code.localeCompare(b.code, "en") || a.message.localeCompare(b.message, "en"));
    const requirements = items.sort((a, b) => a.id.localeCompare(b.id, "en") || a.source.path.localeCompare(b.source.path, "en"));
    return {
        ok: errors.length === 0, requirements, index, errors,
        resolveFragment(id, pointer, options = {}) {
            const source = index[id];
            if (errors.length || !source)
                return { ok: false, error: fail("missing_fragment", id, "Requirement unavailable in invalid or incomplete snapshot") };
            if (options.durable && !durablePointer(pointer))
                return { ok: false, error: fail("malformed_pointer", source.source.path, "positional pointer is not durable") };
            try {
                const value = resolveJsonPointer(source.value, pointer);
                return { ok: true, value, identity: exactRepresentationSubject(input.repository, input.revision, source.source.path, pointer) };
            }
            catch (error) {
                const message = error.message;
                return { ok: false, error: fail(/invalid json_pointer/i.test(message) ? "malformed_pointer" : "missing_fragment", source.source.path, message) };
            }
        }
    };
}
const nativePredicates = new Set([
    "derives_from", "requires", "implemented_by", "verified_by", "documents",
    "generates", "depends_on", "constrains", "supersedes",
]);
const nativeScopePredicates = new Set([
    "requires", "implemented_by", "verified_by", "documents", "constrains",
]);
class NativeContractFailure extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "NativeContractFailure";
        this.code = code;
    }
}
const nativeFailure = (code, message) => {
    throw new NativeContractFailure(code, message);
};
const nativeError = (code, path, message, otherPath) => ({ code, path, message, ...(otherPath ? { otherPath } : {}) });
function nativeObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
        nativeFailure("invalid_native_document", label + " must be an object");
    return value;
}
function nativeExactFields(value, allowed, label) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort();
    if (unknown.length)
        nativeFailure("unknown_field", label + " contains unknown field(s): " + unknown.join(", "));
}
function nativeRequirementId(value, label = "RequirementId") {
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(value))
        return nativeFailure("malformed_requirement_id", "invalid " + label);
    return value;
}
function nativePath(value, label) {
    if (typeof value !== "string")
        return nativeFailure("invalid_resource_ref", label + " path must be a string");
    const path = value;
    try {
        const normalized = normalizeDocumentFact(path, "repository_path");
        if (normalized !== path)
            return nativeFailure("invalid_resource_ref", label + " path is noncanonical");
        return normalized;
    }
    catch (error) {
        if (error instanceof NativeContractFailure)
            throw error;
        return nativeFailure("invalid_resource_ref", label + " path is invalid: " + error.message);
    }
}
function nativePointer(value, label) {
    if (value === undefined)
        return "";
    if (typeof value !== "string" || (value !== "" && (!value.startsWith("/") || /~(?:[^01]|$)/.test(value))))
        return nativeFailure("invalid_resource_ref", label + " pointer is malformed");
    const pointer = value;
    if (!durablePointer(pointer))
        return nativeFailure("invalid_resource_ref", label + " pointer is positional and not durable");
    return pointer;
}
function nativeResourceRef(value, label) {
    const input = nativeObject(value, label);
    const kind = input.kind;
    if (kind === "requirement") {
        nativeExactFields(input, ["kind", "id"], label);
        return { kind, id: nativeRequirementId(input.id, label + ".id") };
    }
    if (kind === "artifact") {
        nativeExactFields(input, ["kind", "path"], label);
        return { kind, path: nativePath(input.path, label) };
    }
    if (kind === "document") {
        nativeExactFields(input, ["kind", "path", "pointer"], label);
        return { kind, path: nativePath(input.path, label), pointer: nativePointer(input.pointer, label) };
    }
    if (kind === "external_document") {
        nativeExactFields(input, ["kind", "repository", "revision", "path", "pointer"], label);
        if (typeof input.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
            return nativeFailure("invalid_resource_ref", label + " repository is invalid");
        if (typeof input.revision !== "string" || !/^[0-9a-f]{40}$/.test(input.revision))
            return nativeFailure("floating_external_revision", label + " revision must be an exact immutable SHA");
        const repository = input.repository;
        const revision = input.revision;
        return {
            kind,
            repository,
            revision,
            path: nativePath(input.path, label),
            pointer: nativePointer(input.pointer, label),
        };
    }
    return nativeFailure("invalid_resource_ref", label + " has unknown ResourceRef kind");
}
function nativeRefKey(value) {
    return JSON.stringify(canonical(value));
}
function nativeRelationDomain(source, predicate, target) {
    const sourceRequirement = source.kind === "requirement";
    if (predicate === "generates") {
        if (source.kind !== "artifact" || target.kind !== "artifact")
            nativeFailure("invalid_relation", "generates requires explicit local ArtifactRef source and ArtifactRef target");
        return;
    }
    if (!sourceRequirement)
        nativeFailure("invalid_relation", predicate + " requires RequirementRef source");
    if (predicate === "derives_from" || predicate === "depends_on" || predicate === "supersedes") {
        if (target.kind !== "requirement")
            nativeFailure("invalid_relation", predicate + " requires RequirementRef target");
        return;
    }
    if (predicate === "implemented_by" || predicate === "verified_by" || predicate === "documents") {
        if (target.kind === "requirement")
            nativeFailure("invalid_relation", predicate + " requires non-Requirement Resource target");
    }
}
function nativeRelations(value, requirementId) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        return nativeFailure("invalid_relation", "relations must be an array");
    const declarations = value;
    const facts = [];
    const seen = new Set();
    for (let index = 0; index < declarations.length; index += 1) {
        const declaration = nativeObject(declarations[index], "relations[" + index + "]");
        nativeExactFields(declaration, ["source", "predicates", "target", "collection"], "relations[" + index + "]");
        if (declaration.collection !== undefined && typeof declaration.collection !== "boolean")
            return nativeFailure("invalid_relation", "relations[" + index + "].collection must be boolean");
        if (!Array.isArray(declaration.predicates) || declaration.predicates.length === 0)
            return nativeFailure("invalid_relation", "relations[" + index + "].predicates must be a non-empty array");
        const predicateValues = declaration.predicates;
        const predicates = [];
        const local = new Set();
        for (const raw of predicateValues) {
            if (typeof raw !== "string" || !nativePredicates.has(raw))
                return nativeFailure("unknown_predicate", "unknown native relation predicate " + String(raw));
            const predicate = raw;
            if (local.has(predicate))
                return nativeFailure("duplicate_relation", "duplicate predicate " + predicate + " in one relation declaration");
            local.add(predicate);
            predicates.push(predicate);
        }
        predicates.sort();
        const source = declaration.source === undefined
            ? { kind: "requirement", id: requirementId }
            : nativeResourceRef(declaration.source, "relations[" + index + "].source");
        const target = nativeResourceRef(declaration.target, "relations[" + index + "].target");
        const collection = declaration.collection === true;
        if (declaration.source !== undefined && predicates.some(predicate => predicate !== "generates"))
            nativeFailure("invalid_relation", "explicit relation source is only supported for generates in native v1");
        if (collection) {
            if (target.kind !== "artifact")
                nativeFailure("invalid_relation", "collection:true requires an exact local ArtifactRef target");
            if (predicates.some(predicate => !["requires", "implemented_by", "verified_by", "documents"].includes(predicate)))
                nativeFailure("invalid_relation", "collection:true requires a J1 direct Requirement-to-Artifact predicate");
        }
        for (const predicate of predicates) {
            nativeRelationDomain(source, predicate, target);
            const fact = { source, predicate, target, ...(collection ? { collection: true } : {}) };
            const key = nativeRefKey(source) + "\0" + predicate + "\0" + nativeRefKey(target);
            if (seen.has(key))
                nativeFailure("duplicate_relation", "duplicate normalized Relation fact");
            seen.add(key);
            facts.push(fact);
        }
    }
    return facts.sort((a, b) => a.predicate.localeCompare(b.predicate, "en") ||
        nativeRefKey(a.source).localeCompare(nativeRefKey(b.source), "en") ||
        nativeRefKey(a.target).localeCompare(nativeRefKey(b.target), "en"));
}
function nativeLifecycle(value) {
    if (value === undefined)
        return { accepted: false, current: false, published: false };
    const input = nativeObject(value, "lifecycle");
    nativeExactFields(input, ["accepted", "current", "published"], "lifecycle");
    for (const key of ["accepted", "current", "published"])
        if (input[key] !== undefined && typeof input[key] !== "boolean")
            nativeFailure("invalid_native_document", "lifecycle." + key + " must be boolean");
    return {
        accepted: input.accepted === true,
        current: input.current === true,
        published: input.published === true,
    };
}
function nativeConstraintScope(value, label) {
    const input = nativeObject(value, label);
    nativeExactFields(input, ["relations", "include_generated"], label);
    if (!Array.isArray(input.relations) || input.relations.length === 0)
        return nativeFailure("invalid_constraint", label + ".relations must be a non-empty array");
    const relationValues = input.relations;
    const relations = [];
    const seen = new Set();
    for (const raw of relationValues) {
        if (typeof raw !== "string" || !nativePredicates.has(raw))
            return nativeFailure("unknown_predicate", "unknown Constraint scope predicate " + String(raw));
        const predicate = raw;
        if (!nativeScopePredicates.has(predicate))
            return nativeFailure("invalid_constraint", "predicate " + predicate + " cannot seed Requirement-derived Constraint scope");
        if (seen.has(predicate))
            return nativeFailure("invalid_constraint", "duplicate Constraint scope predicate " + predicate);
        seen.add(predicate);
        relations.push(predicate);
    }
    if (input.include_generated !== undefined && typeof input.include_generated !== "boolean")
        nativeFailure("invalid_constraint", label + ".include_generated must be boolean");
    return { relations: relations.sort(), include_generated: input.include_generated === true };
}
function nativeConstraintMetric(value, label) {
    const input = nativeObject(value, label);
    nativeExactFields(input, ["key", "max"], label);
    if (typeof input.key !== "string" || input.key.length === 0)
        nativeFailure("invalid_constraint", label + ".key must be a non-empty string");
    if (typeof input.max !== "number" || !Number.isFinite(input.max) || input.max < 0)
        nativeFailure("invalid_constraint", label + ".max must be a finite non-negative number");
    return { key: input.key, max: input.max };
}
function nativeConstraintEvidence(value, label) {
    const input = nativeObject(value, label);
    nativeExactFields(input, ["class", "key", "verifier"], label);
    if (input.class !== "execution" && input.class !== "domain")
        nativeFailure("invalid_constraint", label + ".class must be execution or domain");
    if (typeof input.key !== "string" || input.key.length === 0)
        nativeFailure("invalid_constraint", label + ".key must be a non-empty string");
    const verifier = input.verifier === undefined ? undefined : nativeResourceRef(input.verifier, label + ".verifier");
    const evidenceClass = input.class;
    const key = input.key;
    if (evidenceClass === "execution" && (!verifier || verifier.kind !== "artifact"))
        return nativeFailure("invalid_constraint", label + " execution evidence requires an ArtifactRef verifier");
    if (verifier && verifier.kind !== "artifact")
        return nativeFailure("invalid_constraint", label + " verifier must be an ArtifactRef in native v1");
    return { class: evidenceClass, key, ...(verifier ? { verifier } : {}) };
}
function nativeConstraints(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        return nativeFailure("invalid_constraint", "constraints must be an array");
    const values = value;
    const constraints = [];
    const ids = new Set();
    for (let index = 0; index < values.length; index += 1) {
        const label = "constraints[" + index + "]";
        const input = nativeObject(values[index], label);
        nativeExactFields(input, ["id", "activation", "scope", "metric", "evidence"], label);
        if (typeof input.id !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(input.id))
            nativeFailure("invalid_constraint", label + ".id is invalid");
        const id = input.id;
        if (ids.has(id))
            return nativeFailure("duplicate_constraint_id", "duplicate Constraint id " + id);
        ids.add(id);
        const rawActivation = input.activation === undefined ? "scoped_change" : input.activation;
        if (rawActivation !== "scoped_change" && rawActivation !== "requirement_cause")
            return nativeFailure("invalid_constraint", label + ".activation is invalid");
        const activation = rawActivation;
        const scope = nativeConstraintScope(input.scope, label + ".scope");
        const metric = input.metric === undefined ? undefined : nativeConstraintMetric(input.metric, label + ".metric");
        const evidence = input.evidence === undefined ? undefined : nativeConstraintEvidence(input.evidence, label + ".evidence");
        if (!metric && !evidence)
            nativeFailure("invalid_constraint", label + " requires metric or evidence");
        constraints.push({
            id,
            activation,
            scope,
            ...(metric ? { metric } : {}),
            ...(evidence ? { evidence } : {}),
        });
    }
    return constraints.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
function nativeRequirementSourcePath(path) {
    if (!/\.rg\.(?:yaml|json)$/.test(path))
        nativeFailure("invalid_native_document", "path is not a native Requirement source");
    const normalized = nativePath(path, "native Requirement source");
    if (!normalized.startsWith("requirements/"))
        nativeFailure("invalid_native_document", "native Requirement source must be under requirements/");
    return normalized;
}
function parseNativeRequirement(raw, path) {
    const value = path.endsWith(".json") ? strictCanonicalJson(raw) : parseYaml(raw);
    return nativeObject(value, "native Requirement");
}
export function loadNativeRequirements(input) {
    const errors = [];
    const items = [];
    let identityValid = true;
    try {
        validRepository(input.repository);
        exactRevision(input.revision);
    }
    catch (error) {
        identityValid = false;
        errors.push(nativeError("invalid_native_document", "", error.message));
    }
    const candidatePaths = [...input.paths].filter(path => /\.rg\.(?:yaml|json)$/.test(path)).sort();
    for (const candidatePath of candidatePaths) {
        let path = String(candidatePath);
        try {
            path = nativeRequirementSourcePath(path);
            if (!identityValid)
                continue;
            const content = input.readFile(input.revision, path);
            if (content === null || content === undefined)
                nativeFailure("invalid_native_document", "native source missing at exact snapshot");
            const exactContent = content;
            const raw = Buffer.isBuffer(exactContent) ? exactContent.toString("utf8") : exactContent;
            const value = parseNativeRequirement(raw, path);
            nativeExactFields(value, ["format", "id", "normative", "lifecycle", "relations", "constraints"], "native Requirement");
            if (value.format !== "repo-guard/requirement-v1")
                nativeFailure("invalid_native_document", "format must be repo-guard/requirement-v1");
            const id = nativeRequirementId(value.id);
            if (!Object.hasOwn(value, "normative"))
                nativeFailure("invalid_native_document", "native Requirement requires normative");
            const normative = canonical(value.normative);
            const lifecycle = nativeLifecycle(value.lifecycle);
            const relations = nativeRelations(value.relations, id);
            const constraints = nativeConstraints(value.constraints);
            items.push({
                id,
                normative,
                semantic: semanticRequirementSubject(input.repository, id, canonicalSemanticDigest(normative)),
                source: { kind: "requirement_source", path },
                representation: exactRepresentationSubject(input.repository, input.revision, path),
                lifecycle,
                relations,
                constraints,
            });
        }
        catch (error) {
            const message = error.message;
            if (error instanceof NativeContractFailure)
                errors.push(nativeError(error.code, path, message));
            else if (/duplicate JSON key|map keys must be unique/i.test(message))
                errors.push(nativeError("duplicate_key", path, message));
            else
                errors.push(nativeError("invalid_native_document", path, message));
        }
    }
    const index = Object.create(null);
    for (const item of items) {
        if (Object.hasOwn(index, item.id))
            errors.push(nativeError("duplicate_requirement_id", item.source.path, "duplicate RequirementId " + item.id, index[item.id].source.path));
        else
            index[item.id] = item;
    }
    errors.sort((a, b) => a.path.localeCompare(b.path, "en") ||
        a.code.localeCompare(b.code, "en") ||
        a.message.localeCompare(b.message, "en"));
    const requirements = items.sort((a, b) => a.id.localeCompare(b.id, "en") ||
        a.source.path.localeCompare(b.source.path, "en"));
    return { ok: errors.length === 0, requirements, index, errors };
}
