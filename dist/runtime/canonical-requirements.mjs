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
