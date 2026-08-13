import { parseJson } from "../document-facts.mjs";
import { uniqueSorted } from "../utils/collections.mjs";
import { matchesAny } from "../utils/path-patterns.mjs";
import { readRepositoryTextFile } from "../utils/repository-files.mjs";
function candidateAnchorFiles(options) {
    const changed = (options.changedFiles || []).filter((file) => file.status !== "deleted").map((file) => file.path);
    return uniqueSorted([...(options.trackedFiles || []), ...changed].filter(Boolean));
}
function buildLineStarts(content) {
    const starts = [0];
    for (let i = 0; i < content.length; i++)
        if (content[i] === "\n")
            starts.push(i + 1);
    return starts;
}
function positionAt(starts, index) {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (starts[mid] <= index)
            low = mid + 1;
        else
            high = mid - 1;
    }
    const lineIndex = Math.max(0, high);
    return { line: lineIndex + 1, column: index - starts[lineIndex] + 1 };
}
function makeRegex(pattern) {
    const compiled = new RegExp(pattern);
    let flags = compiled.flags;
    for (const flag of ["g", "d"])
        if (!flags.includes(flag))
            flags += flag;
    return new RegExp(compiled.source, flags);
}
function extractRegexAnchors(anchorType, source, file, content) {
    const instances = [];
    const starts = buildLineStarts(content);
    for (const match of content.matchAll(makeRegex(source.pattern))) {
        let captureGroup = null;
        for (let i = 1; i < match.length; i++)
            if (match[i] !== undefined) {
                captureGroup = i;
                break;
            }
        const value = captureGroup ? match[captureGroup] : match[0];
        const index = captureGroup && match.indices?.[captureGroup] ? match.indices[captureGroup][0] : match.index;
        const position = positionAt(starts, index);
        const instance = { anchorType, value: String(value), file, sourceKind: "regex", ...position, raw: match[0] };
        if (captureGroup)
            instance.captureGroup = captureGroup;
        instances.push(instance);
    }
    return instances;
}
function extractJsonFieldAnchor(anchorType, source, file, content) {
    let data;
    try {
        data = parseJson(content);
    }
    catch (error) {
        throw new Error(`invalid JSON: ${error.message}`);
    }
    if (data === null || Array.isArray(data) || typeof data !== "object")
        throw new Error("json_field extractor requires a top-level JSON object");
    if (!Object.hasOwn(data, source.field))
        throw new Error(`field "${source.field}" not found`);
    const value = data[source.field];
    if (value === null || typeof value === "object")
        throw new Error(`field "${source.field}" must be a string, number, or boolean`);
    return [{ anchorType, value: String(value), file, sourceKind: "json_field", raw: String(value) }];
}
function compareInstances(a, b) {
    return a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0) || (a.column || 0) - (b.column || 0) ||
        a.anchorType.localeCompare(b.anchorType) || a.value.localeCompare(b.value);
}
export function extractAnchors(policy, options = {}) {
    const anchorTypes = policy.anchors?.types || {};
    const files = candidateAnchorFiles(options);
    const instances = [];
    const errors = [];
    const text = (file) => options.documents?.text(file) ?? readRepositoryTextFile(file, options);
    for (const [anchorType, config] of Object.entries(anchorTypes)) {
        for (const [sourceIndex, source] of (config.sources || []).entries()) {
            for (const file of files.filter((path) => matchesAny(path, [source.glob]))) {
                try {
                    const content = text(file);
                    if (source.kind === "regex")
                        instances.push(...extractRegexAnchors(anchorType, source, file, content));
                    else if (source.kind === "json_field")
                        instances.push(...extractJsonFieldAnchor(anchorType, source, file, content));
                    else
                        throw new Error(`unsupported anchor source kind "${source.kind}"`);
                }
                catch (error) {
                    errors.push({ anchorType, sourceKind: source.kind, sourceIndex, file, message: error.message });
                }
            }
        }
    }
    instances.sort(compareInstances);
    errors.sort((a, b) => (a.file || "").localeCompare(b.file || "") || a.anchorType.localeCompare(b.anchorType) || a.sourceIndex - b.sourceIndex || a.message.localeCompare(b.message));
    const byType = Object.fromEntries(Object.keys(anchorTypes).sort().map((type) => [type, []]));
    for (const instance of instances)
        (byType[instance.anchorType] ||= []).push(instance);
    return { instances, byType, errors };
}
export function formatAnchorExtractionError(error) {
    return `[${error.anchorType} ${error.sourceKind} source ${error.sourceIndex}] ${error.file ? `${error.file}: ` : ""}${error.message}`;
}
export function checkAnchorExtraction(anchorExtraction) {
    const errors = anchorExtraction?.errors || [];
    return { ok: errors.length === 0, message: errors.length ? "anchor extraction failed" : undefined, errors: errors.map(formatAnchorExtractionError) };
}
