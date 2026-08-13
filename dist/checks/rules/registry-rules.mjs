import { createDocumentReader, markdownSection } from "../../document-facts.mjs";
import { compareSets } from "../relation-kernel.mjs";
import { formatList, uniqueSorted } from "../../utils/collections.mjs";
import { normalizePathEntry } from "../../utils/path-patterns.mjs";
const normalizeAll = (values) => uniqueSorted(values.map(normalizePathEntry).filter(Boolean));
function resolveJsonPointer(data, pointer) {
    if (pointer === "")
        return data;
    if (!pointer?.startsWith("/"))
        throw new Error(`invalid json_pointer "${pointer}"`);
    let current = data;
    for (const raw of pointer.slice(1).split("/")) {
        const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        if (current == null || !Object.hasOwn(current, part))
            throw new Error(`json_pointer "${pointer}" does not exist`);
        current = current[part];
    }
    return current;
}
function normalizeMarkdownLinkTarget(target, source) {
    const clean = normalizePathEntry(target.split("#")[0].split("?")[0]);
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("#"))
        return "";
    const sourceDir = source.file.includes("/") ? source.file.split("/").slice(0, -1).join("/") : "";
    const candidate = clean.startsWith("/") ? clean.slice(1) : normalizePathEntry(`${sourceDir}/${clean}`), parts = [];
    for (const part of candidate.split("/")) {
        if (!part || part === ".")
            continue;
        if (part === "..")
            parts.pop();
        else
            parts.push(part);
    }
    let result = parts.join("/");
    if (source.prefix) {
        const prefix = normalizePathEntry(source.prefix);
        if (!result.startsWith(prefix) && sourceDir && result.startsWith(`${sourceDir}/`))
            result = normalizePathEntry(`${prefix}${result.slice(sourceDir.length + 1)}`);
    }
    return result;
}
function readRegistrySource(source, documents) {
    if (source.type === "json_array") {
        const value = resolveJsonPointer(documents.json(source.file), source.json_pointer);
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
            throw new Error(`${source.file}${source.json_pointer} must be an array of strings`);
        return normalizeAll(value);
    }
    if (source.type === "markdown_section_links")
        return normalizeAll(markdownSection(documents.markdown(source.file), source.section).links.map((link) => normalizeMarkdownLinkTarget(link.target, source)).filter(Boolean));
    throw new Error(`unsupported registry source type "${source.type}"`);
}
export function checkRegistryRules(rules = [], options = {}) {
    if (!rules?.length)
        return { ok: true, results: [] };
    const documents = options.documents || createDocumentReader(options);
    const results = rules.map((rule) => {
        try {
            const leftEntries = readRegistrySource(rule.left, documents), rightEntries = readRegistrySource(rule.right, documents);
            const relation = rule.kind === "left_subset_of_right" ? "left_subset" : rule.kind === "right_subset_of_left" ? "right_subset" : "equal";
            const compared = compareSets(leftEntries, rightEntries, relation);
            return { ok: compared.ok, rule_id: rule.id, kind: rule.kind, left_entries: leftEntries, right_entries: rightEntries,
                missing_from_right: compared.missing, extra_in_right: compared.extra, message: compared.ok ? undefined : `registry rule "${rule.id}" failed ${rule.kind}` };
        }
        catch (error) {
            return { ok: false, rule_id: rule.id, kind: rule.kind, left_entries: [], right_entries: [], missing_from_right: [], extra_in_right: [], message: `registry rule "${rule.id}" could not be evaluated`, details: [error.message] };
        }
    });
    const failed = results.filter((result) => !result.ok);
    return { ok: !failed.length, results, failed_rules: failed.map((result) => result.rule_id), details: failed.flatMap((result) => [
            `[${result.rule_id}] ${result.message}`, `left entries: ${formatList(result.left_entries)}`, `right entries: ${formatList(result.right_entries)}`,
            `missing from right: ${formatList(result.missing_from_right)}`, `extra in right: ${formatList(result.extra_in_right)}`, ...(result.details || []),
        ]) };
}
