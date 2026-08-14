import { parseDocument } from "yaml";
import { readRepositoryTextFile } from "./utils/repository-files.mjs";
import { uniqueSorted } from "./utils/collections.mjs";
import { normalizePathEntry } from "./utils/path-patterns.mjs";
function collapseMessage(message) {
    return String(message || "").replace(/\s+/g, " ").trim();
}
export function parseYaml(content) {
    const doc = parseDocument(content, { prettyErrors: false });
    if (doc.errors.length)
        throw new Error(`invalid YAML: ${doc.errors.map((e) => collapseMessage(e.message)).join("; ")}`);
    return doc.toJSON();
}
export function parseJson(content) {
    return JSON.parse(content);
}
function decodeJsonPointerSegment(raw, pointer) {
    if (/~(?:[^01]|$)/.test(raw))
        throw new Error(`invalid json_pointer "${pointer}"`);
    return raw.replace(/~1/g, "/").replace(/~0/g, "~");
}
export function resolveJsonPointer(data, pointer) {
    if (pointer === "")
        return data;
    if (typeof pointer !== "string" || !pointer.startsWith("/"))
        throw new Error(`invalid json_pointer "${pointer}"`);
    let current = data;
    for (const raw of pointer.slice(1).split("/")) {
        const part = decodeJsonPointerSegment(raw, pointer);
        if (current === null || typeof current !== "object" || !Object.hasOwn(current, part))
            throw new Error(`json_pointer "${pointer}" does not exist`);
        current = current[part];
    }
    return current;
}
export function projectDocumentValue(data, pointer, projection = "value") {
    const selected = resolveJsonPointer(data, pointer);
    if (projection === "value")
        return selected;
    if (projection === "array_items") {
        if (!Array.isArray(selected))
            throw new Error(`document projection "array_items" requires an array at json_pointer "${pointer}"`);
        return [...selected];
    }
    if (projection === "object_values") {
        if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
            throw new Error(`document projection "object_values" requires an object at json_pointer "${pointer}"`);
        }
        return Object.values(selected);
    }
    const exhaustive = projection;
    throw new Error(`unsupported document projection "${exhaustive}"`);
}
function normalizeRepositoryPathFact(value) {
    if (typeof value !== "string")
        throw new Error("document fact repository_path requires a string");
    const normalized = normalizePathEntry(value);
    const parts = normalized.split("/");
    if (!normalized
        || normalized.includes("\\")
        || normalized.startsWith("/")
        || /^[A-Za-z]:/.test(normalized)
        || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
        || parts.some((part) => !part || part === "." || part === "..")) {
        throw new Error(`invalid repository_path "${value}"`);
    }
    return normalized;
}
function normalizeStringSet(value, itemType) {
    if (!Array.isArray(value))
        throw new Error(`document fact ${itemType === "string" ? "string_set" : "repository_path_set"} requires a collection`);
    const normalized = value.map((item) => {
        if (itemType === "repository_path")
            return normalizeRepositoryPathFact(item);
        if (typeof item !== "string")
            throw new Error("document fact string_set requires string items");
        return item;
    });
    return uniqueSorted(normalized);
}
export function normalizeDocumentFact(value, type) {
    if (type === "scalar") {
        if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
            return value;
        throw new Error("document fact scalar requires a JSON scalar");
    }
    if (type === "string") {
        if (typeof value === "string")
            return value;
        throw new Error("document fact string requires a string");
    }
    if (type === "boolean") {
        if (typeof value === "boolean")
            return value;
        throw new Error("document fact boolean requires a boolean");
    }
    if (type === "string_set")
        return normalizeStringSet(value, "string");
    if (type === "repository_path")
        return normalizeRepositoryPathFact(value);
    if (type === "repository_path_set")
        return normalizeStringSet(value, "repository_path");
    const exhaustive = type;
    throw new Error(`unsupported document fact type "${exhaustive}"`);
}
export function stripMarkdownInline(line) {
    return line.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "");
}
export function parseMarkdown(content) {
    const lines = String(content || "").split(/\r?\n/);
    const headings = [];
    const codeBlocks = [];
    const proseLines = [];
    const links = [];
    const errors = [];
    let fence = null;
    for (const [offset, line] of lines.entries()) {
        const lineNumber = offset + 1;
        if (!fence) {
            const opening = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
            if (opening) {
                fence = {
                    indent: opening[1], marker: opening[2][0], length: opening[2].length,
                    infoString: opening[3].trim(), startLine: lineNumber, contentLines: [],
                };
                continue;
            }
            const heading = line.match(/^[ \t]{0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
            if (heading) {
                const text = heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
                if (text)
                    headings.push({ level: heading[1].length, text, line: lineNumber });
            }
            for (const match of line.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
                links.push({ target: match[1], line: lineNumber, column: match.index + 1 });
            }
            proseLines.push({ line: lineNumber, text: line });
            continue;
        }
        const closing = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
        if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
            const language = fence.infoString.split(/\s+/).filter(Boolean)[0] || "";
            codeBlocks.push({ language, infoString: fence.infoString, startLine: fence.startLine, endLine: lineNumber, content: fence.contentLines.join("\n") });
            fence = null;
        }
        else {
            fence.contentLines.push(fence.indent && line.startsWith(fence.indent) ? line.slice(fence.indent.length) : line);
        }
    }
    if (fence)
        errors.push({ message: `unclosed Markdown fence starting at line ${fence.startLine}` });
    return { lines, headings, codeBlocks, proseLines, links, errors };
}
export function markdownSection(markdown, section) {
    const heading = markdown.headings.find((item) => item.text.toLowerCase() === section.trim().toLowerCase());
    if (!heading)
        throw new Error(`markdown section "${section}" not found`);
    const end = markdown.headings.find((item) => item.line > heading.line && item.level <= heading.level)?.line || markdown.lines.length + 1;
    return {
        startLine: heading.line + 1, endLine: end - 1,
        lines: markdown.lines.slice(heading.line, end - 1),
        links: markdown.links.filter((link) => link.line > heading.line && link.line < end),
    };
}
export function createDocumentReader(options = {}) {
    const textCache = new Map();
    const parsed = { markdown: new Map(), json: new Map(), yaml: new Map() };
    const text = (path) => {
        if (!textCache.has(path))
            textCache.set(path, readRepositoryTextFile(path, options));
        return textCache.get(path);
    };
    const cached = (kind, path, parser) => {
        if (!parsed[kind].has(path))
            parsed[kind].set(path, parser(text(path)));
        return parsed[kind].get(path);
    };
    return {
        text,
        markdown: (path) => cached("markdown", path, parseMarkdown),
        json: (path) => cached("json", path, parseJson),
        yaml: (path) => cached("yaml", path, parseYaml),
    };
}
