import { parseDocument } from "yaml";
import { selectPaths } from "./diff/classification.mjs";
import { readRepositoryTextFile } from "./utils/repository-files.mjs";
import { uniqueSorted } from "./utils/collections.mjs";
import { matchesAny, normalizePathEntry } from "./utils/path-patterns.mjs";
export class DocumentFactFailure extends Error {
    code;
    pointer;
    segment;
    constructor(code, message, pointer = "", segment) {
        super(message);
        this.name = "DocumentFactFailure";
        this.code = code;
        this.pointer = pointer;
        this.segment = segment;
    }
}
function collapseMessage(message) {
    return String(message || "").replace(/\s+/g, " ").trim();
}
function failDocumentFact(code, message, pointer = "", segment) {
    throw new DocumentFactFailure(code, message, pointer, segment);
}
function documentFactError(error, pointer) {
    if (error instanceof DocumentFactFailure) {
        return { code: error.code, pointer: error.pointer, ...(error.segment === undefined ? {} : { segment: error.segment }), message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { code: "document_read_error", pointer, message: collapseMessage(message) || "document read failed" };
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
        failDocumentFact("malformed_pointer", `invalid json_pointer "${pointer}"`, pointer);
    return raw.replace(/~1/g, "/").replace(/~0/g, "~");
}
export function resolveJsonPointer(data, pointer) {
    if (pointer === "")
        return data;
    if (typeof pointer !== "string" || !pointer.startsWith("/")) {
        const rendered = typeof pointer === "string" ? pointer : String(pointer ?? "");
        failDocumentFact("malformed_pointer", `invalid json_pointer "${rendered}"`, rendered);
    }
    let current = data;
    for (const raw of pointer.slice(1).split("/")) {
        const part = decodeJsonPointerSegment(raw, pointer);
        if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) {
            failDocumentFact("missing_pointer_segment", `json_pointer "${pointer}" does not exist`, pointer, part);
        }
        current = current[part];
    }
    return current;
}
export function projectDocumentValue(data, pointer, projection = "value") {
    const selected = resolveJsonPointer(data, pointer);
    if (projection === "value")
        return selected;
    if (projection === "array_items") {
        if (!Array.isArray(selected)) {
            failDocumentFact("projection_type_mismatch", `document projection "array_items" requires an array at json_pointer "${pointer}"`, pointer);
        }
        return [...selected];
    }
    if (projection === "object_values") {
        if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
            failDocumentFact("projection_type_mismatch", `document projection "object_values" requires an object at json_pointer "${pointer}"`, pointer);
        }
        return Object.values(selected);
    }
    if (projection === "object_keys") {
        if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
            failDocumentFact("projection_type_mismatch", `document projection "object_keys" requires an object at json_pointer "${pointer}"`, pointer);
        }
        return Object.keys(selected);
    }
    const exhaustive = projection;
    return failDocumentFact("projection_type_mismatch", `unsupported document projection "${String(exhaustive)}"`, pointer);
}
function normalizeRepositoryPathFact(value, pointer = "") {
    if (typeof value !== "string")
        failDocumentFact("fact_type_mismatch", "document fact repository_path requires a string", pointer);
    const normalized = normalizePathEntry(value);
    const parts = normalized.split("/");
    if (!normalized
        || normalized.includes("\\")
        || normalized.startsWith("/")
        || /^[A-Za-z]:/.test(normalized)
        || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
        || parts.some((part) => !part || part === "." || part === "..")) {
        failDocumentFact("invalid_repository_path", `invalid repository_path "${value}"`, pointer);
    }
    return normalized;
}
function normalizeStringSet(value, itemType, pointer = "") {
    if (!Array.isArray(value)) {
        failDocumentFact("fact_type_mismatch", `document fact ${itemType === "string" ? "string_set" : "repository_path_set"} requires a collection`, pointer);
    }
    const normalized = value.map((item) => {
        if (itemType === "repository_path")
            return normalizeRepositoryPathFact(item, pointer);
        if (typeof item !== "string")
            failDocumentFact("fact_type_mismatch", "document fact string_set requires string items", pointer);
        return item;
    });
    return uniqueSorted(normalized);
}
export function normalizeDocumentFact(value, type, pointer = "") {
    if (type === "scalar") {
        if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
            return value;
        return failDocumentFact("fact_type_mismatch", "document fact scalar requires a JSON scalar", pointer);
    }
    if (type === "string") {
        if (typeof value === "string")
            return value;
        return failDocumentFact("fact_type_mismatch", "document fact string requires a string", pointer);
    }
    if (type === "boolean") {
        if (typeof value === "boolean")
            return value;
        return failDocumentFact("fact_type_mismatch", "document fact boolean requires a boolean", pointer);
    }
    if (type === "string_set")
        return normalizeStringSet(value, "string", pointer);
    if (type === "repository_path")
        return normalizeRepositoryPathFact(value, pointer);
    if (type === "repository_path_set")
        return normalizeStringSet(value, "repository_path", pointer);
    const exhaustive = type;
    return failDocumentFact("fact_type_mismatch", `unsupported document fact type "${String(exhaustive)}"`, pointer);
}
function factPointer(ref) {
    return ref.source === "document" || ref.source === "change_intent" ? ref.selector.pointer : "";
}
function documentSelector(ref) {
    if (ref.source !== "document")
        failDocumentFact("document_read_error", "document fact requires document source");
    return ref.selector;
}
function structuredFactSource(reader, selector) {
    const path = normalizeRepositoryPathFact(selector.path, selector.pointer);
    if (selector.format === "json")
        return reader.json(path);
    if (selector.format === "yaml")
        return reader.yaml(path);
    if (selector.format === "plain_text") {
        if (selector.pointer !== "" || (selector.projection !== undefined && selector.projection !== "value")) {
            return failDocumentFact("projection_type_mismatch", "plain_text fact requires the root value selector", selector.pointer);
        }
        return reader.text(path).trim();
    }
    const exhaustive = selector.format;
    return failDocumentFact("unsupported_document_type", `unsupported document type for "${String(exhaustive)}"`, selector.pointer);
}
function snapshotFactSource(context, selector) {
    const label = selector.snapshot === "base" ? "BASE" : "HEAD";
    const revision = selector.snapshot === "base" ? context.baseRef : context.headRef;
    const path = normalizeRepositoryPathFact(selector.path, selector.pointer);
    if (!revision)
        return failDocumentFact("document_read_error", `missing ${label} ref`, selector.pointer);
    const useCache = Boolean(context.snapshotDocuments && context.repositoryIdentity);
    if (!useCache && !context.readFileAtRef)
        return failDocumentFact("document_read_error", `snapshot reader unavailable for ${label}`, selector.pointer);
    const identity = useCache ? { repository: context.repositoryIdentity, sha: revision } : null;
    let raw;
    try {
        raw = identity ? context.snapshotDocuments.read(identity, path) : context.readFileAtRef(revision, path);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failDocumentFact("document_read_error", `${label} read failed: ${collapseMessage(message)}`, selector.pointer);
    }
    if (raw === null || raw === undefined)
        return failDocumentFact("document_read_error", `missing ${label} file`, selector.pointer);
    if (selector.format === "plain_text") {
        if (selector.pointer !== "" || (selector.projection !== undefined && selector.projection !== "value")) {
            return failDocumentFact("projection_type_mismatch", "plain_text fact requires the root value selector", selector.pointer);
        }
        return String(raw).trim();
    }
    if (selector.format === "json")
        return identity ? context.snapshotDocuments.parsed(identity, path, "json") : parseJson(String(raw));
    if (selector.format === "yaml")
        return identity ? context.snapshotDocuments.parsed(identity, path, "yaml") : parseYaml(String(raw));
    const exhaustive = selector.format;
    return failDocumentFact("unsupported_document_type", `unsupported document type for "${String(exhaustive)}"`, selector.pointer);
}
function matchesPathScope(path, patterns, excludePaths) {
    return (!patterns?.length || matchesAny(path, patterns)) && !(excludePaths?.length && matchesAny(path, excludePaths));
}
function diffFactSource(context, selector) {
    const files = context.diff?.files?.checked;
    if (!Array.isArray(files))
        return failDocumentFact("document_read_error", "diff facts are unavailable");
    if (selector.kind === "metric") {
        const candidates = files.filter((file) => matchesPathScope(file.path, selector.patterns, selector.exclude_paths));
        if (selector.metric === "new_files")
            return candidates.filter((file) => file.status === "added").length;
        if (selector.metric === "new_docs")
            return candidates.filter((file) => file.status === "added" && /\.md$/i.test(file.path)).length;
        if (selector.metric === "net_files") {
            return candidates.reduce((sum, file) => sum + (file.status === "added" ? 1 : file.status === "deleted" ? -1 : 0), 0);
        }
        return candidates.reduce((sum, file) => sum + (file.addedLines?.length || 0) - (file.deletedLines?.length || 0), 0);
    }
    const patterns = [...selector.patterns];
    const excluded = new Set(selector.exclude_statuses || []);
    const candidates = files.filter((file) => !excluded.has(file.status));
    if (!selector.include_previous_paths) {
        return selector.mode === "outside"
            ? uniqueSorted(candidates.filter((file) => !matchesAny(file.path, patterns)).map((file) => file.path))
            : selectPaths(candidates, patterns);
    }
    const candidatePaths = uniqueSorted(candidates.flatMap((file) => file.previousPath ? [file.path, file.previousPath] : [file.path]));
    return selector.mode === "outside"
        ? uniqueSorted(candidatePaths.filter((path) => !matchesAny(path, patterns)))
        : uniqueSorted(candidatePaths.filter((path) => matchesAny(path, patterns)));
}
function anchorFactInstance(instance) {
    if (typeof instance.value !== "string")
        failDocumentFact("fact_type_mismatch", "repository anchor fact requires string values");
    if (typeof instance.file !== "string")
        failDocumentFact("fact_type_mismatch", "repository anchor fact requires source files");
    return {
        value: instance.value,
        file: instance.file,
        ...(typeof instance.line === "number" ? { line: instance.line } : {}),
        ...(typeof instance.column === "number" ? { column: instance.column } : {}),
    };
}
function compareAnchorFactInstances(left, right) {
    return left.file.localeCompare(right.file)
        || (left.line || 0) - (right.line || 0)
        || (left.column || 0) - (right.column || 0)
        || left.value.localeCompare(right.value);
}
function countTextLines(content) {
    if (!content.length)
        return 0;
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = (normalized.match(/\n/g) || []).length + 1;
    return normalized.endsWith("\n") ? lines - 1 : lines;
}
function currentRepositoryPaths(context) {
    const changedCurrent = (context.diff?.files?.checked || []).filter((file) => file.status !== "deleted").map((file) => file.path);
    return uniqueSorted([...(context.trackedFiles || []), ...changedCurrent].map(normalizePathEntry).filter(Boolean));
}
function changedRepositoryPaths(context) {
    return uniqueSorted((context.diff?.files?.checked || []).filter((file) => file.status !== "deleted").map((file) => normalizePathEntry(file.path)).filter(Boolean));
}
function repositoryPathMetric(context, selector) {
    const universe = selector.population === "tracked" ? currentRepositoryPaths(context) : changedRepositoryPaths(context);
    const matchedPaths = universe.filter((path) => matchesPathScope(path, selector.patterns, selector.exclude_paths));
    const measurements = matchedPaths.map((path) => {
        if (selector.metric === "files")
            return { path, value: 1 };
        if (!context.readFile)
            return failDocumentFact("document_read_error", `repository reader unavailable for "${path}"`);
        let raw;
        try {
            raw = context.readFile(path);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return failDocumentFact("document_read_error", `repository read failed for "${path}": ${collapseMessage(message)}`);
        }
        if (raw === null || raw === undefined)
            return failDocumentFact("document_read_error", `repository file "${path}" is unavailable`);
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf-8");
        return { path, value: selector.metric === "bytes" ? bytes.length : countTextLines(bytes.toString("utf-8")) };
    });
    const values = measurements.map((item) => item.value);
    const value = selector.aggregate === "max" ? (values.length ? Math.max(...values) : 0) : values.reduce((sum, item) => sum + item, 0);
    return {
        ok: true,
        value,
        provenance: { kind: "path_metric", matched_paths: matchedPaths, measurements, aggregate: selector.aggregate, value },
    };
}
function repositoryFact(context, ref) {
    if (ref.selector.kind === "path_metric")
        return repositoryPathMetric(context, ref.selector);
    const byType = context.anchors?.byType;
    if (!byType)
        return failDocumentFact("document_read_error", "repository anchor facts are unavailable");
    const instances = (byType[ref.selector.anchor_type] || []).map(anchorFactInstance).sort(compareAnchorFactInstances);
    return {
        ok: true,
        value: normalizeDocumentFact(instances.map((instance) => instance.value), ref.type),
        provenance: { kind: "anchor_instances", anchor_type: ref.selector.anchor_type, instances },
    };
}
function changeIntentFactSource(context, ref) {
    const projection = ref.selector.projection ?? "value";
    try {
        return projectDocumentValue(context.changeIntent ?? {}, ref.selector.pointer, projection);
    }
    catch (error) {
        if (error instanceof DocumentFactFailure && error.code === "missing_pointer_segment" && projection !== "value")
            return [];
        throw error;
    }
}
export function readFact(context, ref) {
    const pointer = factPointer(ref);
    try {
        if (ref.source === "diff") {
            return { ok: true, value: normalizeDocumentFact(diffFactSource(context, ref.selector), ref.type, pointer) };
        }
        if (ref.source === "repository")
            return repositoryFact(context, ref);
        if (ref.source === "change_intent") {
            return { ok: true, value: normalizeDocumentFact(changeIntentFactSource(context, ref), ref.type, pointer) };
        }
        const selector = documentSelector(ref);
        const source = selector.snapshot === "state"
            ? context.documents ? structuredFactSource(context.documents, selector) : failDocumentFact("document_read_error", "document reader is unavailable", selector.pointer)
            : selector.snapshot === "base" || selector.snapshot === "head"
                ? snapshotFactSource(context, selector)
                : failDocumentFact("document_read_error", `unsupported fact snapshot "${String(selector.snapshot)}"`, selector.pointer);
        const projected = selector.format === "plain_text" ? source : projectDocumentValue(source, selector.pointer, selector.projection ?? "value");
        return { ok: true, value: normalizeDocumentFact(projected, ref.type, selector.pointer) };
    }
    catch (error) {
        return { ok: false, error: documentFactError(error, pointer) };
    }
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
function failMarkdownStructure(message) {
    throw new Error(`markdown structural model: ${message}`);
}
function assertSafeMarkdownId(value, name) {
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) {
        failMarkdownStructure(`${name} must be a stable ASCII identifier: ${value}`);
    }
}
function indexedMarkdownLines(source, markdown) {
    const result = [];
    let offset = 0;
    for (let index = 0; index < markdown.lines.length; index++) {
        const newline = source.indexOf("\n", offset);
        const rawEnd = newline < 0 ? source.length : newline;
        const contentEnd = rawEnd > offset && source[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
        const end = newline < 0 ? source.length : newline + 1;
        result.push({ line: index + 1, start: offset, end, text: source.slice(offset, contentEnd) });
        offset = end;
    }
    return result;
}
function markdownStructure(source) {
    const markdown = parseMarkdown(source);
    if (markdown.errors.length) {
        failMarkdownStructure(markdown.errors.map((error) => error.message).join("; "));
    }
    const lines = indexedMarkdownLines(source, markdown);
    const visibleLines = new Set(markdown.proseLines.map((line) => line.line));
    const anchors = [];
    const seen = new Set();
    const anchorPattern = /<a\s+id=["']([^"']+)["']\s*><\/a>/gi;
    for (const line of lines) {
        if (!visibleLines.has(line.line))
            continue;
        for (const match of line.text.matchAll(anchorPattern)) {
            const anchorId = match[1];
            assertSafeMarkdownId(anchorId, "anchorId");
            if (seen.has(anchorId))
                failMarkdownStructure(`anchor is duplicated: ${anchorId}`);
            seen.add(anchorId);
            anchors.push({ anchorId, line: line.line, start: line.start });
        }
    }
    return { source, markdown, lines, visibleLines, anchors };
}
function headingPathAt(markdown, targetLine) {
    const stack = [];
    for (const heading of markdown.headings) {
        if (heading.line > targetLine)
            break;
        while (stack.length && stack[stack.length - 1].level >= heading.level)
            stack.pop();
        stack.push(heading);
    }
    return [...stack];
}
function anchorIn(context, anchorId) {
    assertSafeMarkdownId(anchorId, "anchorId");
    const anchor = context.anchors.find((candidate) => candidate.anchorId === anchorId);
    if (!anchor)
        failMarkdownStructure(`anchor not found: ${anchorId}`);
    return {
        anchorId,
        line: anchor.line,
        offset: anchor.start,
        headingPath: headingPathAt(context.markdown, anchor.line),
    };
}
function headingAfterAnchor(context, anchorLine) {
    const headings = new Map(context.markdown.headings.map((heading) => [heading.line, heading]));
    for (const prose of context.markdown.proseLines) {
        if (prose.line <= anchorLine)
            continue;
        const trimmed = prose.text.trim();
        if (!trimmed || /^<!--.*-->$/.test(trimmed))
            continue;
        return headings.get(prose.line) ?? null;
    }
    return null;
}
function lineAt(context, line) {
    const indexed = context.lines[line - 1];
    if (!indexed)
        failMarkdownStructure(`line ${line} is unavailable`);
    return indexed;
}
function nodeIn(context, anchorId) {
    const anchor = anchorIn(context, anchorId);
    const heading = headingAfterAnchor(context, anchor.line);
    if (!heading)
        return null;
    const nextHeading = context.markdown.headings.find((candidate) => candidate.line > heading.line && candidate.level <= heading.level);
    let end = context.source.length;
    if (nextHeading) {
        const owningAnchors = context.anchors.filter((candidate) => {
            if (candidate.line >= nextHeading.line)
                return false;
            return headingAfterAnchor(context, candidate.line)?.line === nextHeading.line;
        });
        if (owningAnchors.length > 1) {
            failMarkdownStructure(`heading at line ${nextHeading.line} has multiple node anchors`);
        }
        end = owningAnchors[0]?.start ?? lineAt(context, nextHeading.line).start;
    }
    return {
        anchorId,
        anchorLine: anchor.line,
        headingLine: heading.line,
        heading,
        headingPath: headingPathAt(context.markdown, heading.line),
        start: anchor.offset,
        end,
        subtree: context.source.slice(anchor.offset, end),
    };
}
export function resolveMarkdownAnchor(source, anchorId) {
    return anchorIn(markdownStructure(source), anchorId);
}
export function listMarkdownAnchorIds(source) {
    return markdownStructure(source).anchors.map((anchor) => anchor.anchorId);
}
export function readMarkdownNode(source, anchorId) {
    const node = nodeIn(markdownStructure(source), anchorId);
    if (!node)
        failMarkdownStructure(`${anchorId}: anchor is not a canonical tree node`);
    return node;
}
export function listMarkdownChildren(source, parentAnchorId) {
    const context = markdownStructure(source);
    const parent = nodeIn(context, parentAnchorId);
    if (!parent)
        failMarkdownStructure(`${parentAnchorId}: anchor is not a canonical tree node`);
    return context.anchors
        .map((anchor) => nodeIn(context, anchor.anchorId))
        .filter((node) => node !== null
        && node.anchorId !== parent.anchorId
        && node.start > parent.start
        && node.start < parent.end
        && node.heading.level === parent.heading.level + 1)
        .sort((left, right) => left.start - right.start);
}
function validateMarkdownChild(child) {
    assertSafeMarkdownId(child.anchorId, "child.anchorId");
    if (!child.title.trim() || /[\r\n]/.test(child.title)) {
        failMarkdownStructure("child title must be one non-empty line");
    }
    const payload = child.payload ?? "";
    if (/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/m.test(payload) || /<a\s+id=["']/i.test(payload)) {
        failMarkdownStructure("child payload cannot contain headings or stable anchors");
    }
}
function markdownNewline(source) {
    return source.includes("\r\n") ? "\r\n" : "\n";
}
export function insertMarkdownChild(args) {
    const { source, mode, parentAnchorId, child } = args;
    if (mode === "source")
        failMarkdownStructure(`${parentAnchorId}: SOURCE document is read-only`);
    if (mode === "generated")
        failMarkdownStructure(`${parentAnchorId}: whole-file GENERATED mode is not supported`);
    validateMarkdownChild(child);
    const context = markdownStructure(source);
    if (context.anchors.some((anchor) => anchor.anchorId === child.anchorId)) {
        failMarkdownStructure(`anchor is duplicated: ${child.anchorId}`);
    }
    const parent = nodeIn(context, parentAnchorId);
    if (!parent)
        failMarkdownStructure(`${parentAnchorId}: anchor is not a canonical tree node`);
    if (parent.heading.level >= 6) {
        failMarkdownStructure(`${parentAnchorId}: heading level 6 cannot have a Markdown child`);
    }
    const newline = markdownNewline(source);
    const payload = child.payload?.trimEnd();
    const block = [
        `<a id="${child.anchorId}"></a>`,
        `${"#".repeat(parent.heading.level + 1)} ${child.title.trim()}`,
        ...(payload ? [payload] : []),
    ].join(newline);
    const prefix = parent.end > 0 && !source.slice(0, parent.end).endsWith("\n") ? newline : "";
    const inserted = `${prefix}${block}${newline}${newline}`;
    const updated = source.slice(0, parent.end) + inserted + source.slice(parent.end);
    if (updated.slice(0, parent.end) !== source.slice(0, parent.end)
        || updated.slice(parent.end + inserted.length) !== source.slice(parent.end)) {
        failMarkdownStructure("insert child modified bytes outside insertion point");
    }
    const updatedContext = markdownStructure(updated);
    for (const anchor of context.anchors)
        anchorIn(updatedContext, anchor.anchorId);
    const created = nodeIn(updatedContext, child.anchorId);
    if (!created || created.heading.level !== parent.heading.level + 1) {
        failMarkdownStructure("inserted child has invalid heading level");
    }
    return updated;
}
function validateOwnedBlockSpec(block) {
    assertSafeMarkdownId(block.blockId, "blockId");
    if (!block.beginMarker || !block.endMarker || block.beginMarker === block.endMarker) {
        failMarkdownStructure(`${block.blockId}: owned block markers must be distinct non-empty tokens`);
    }
    if (/[\r\n]/.test(block.beginMarker) || /[\r\n]/.test(block.endMarker)) {
        failMarkdownStructure(`${block.blockId}: owned block markers must be single-line tokens`);
    }
}
export function readOwnedMarkdownBlock(source, block) {
    validateOwnedBlockSpec(block);
    const context = markdownStructure(source);
    const begin = block.beginMarker.trim();
    const end = block.endMarker.trim();
    const starts = context.lines.filter((line) => context.visibleLines.has(line.line) && line.text.trim() === begin);
    const ends = context.lines.filter((line) => context.visibleLines.has(line.line) && line.text.trim() === end);
    if (!starts.length && !ends.length)
        return null;
    if (starts.length !== 1 || ends.length !== 1) {
        failMarkdownStructure(`${block.blockId}: malformed owned block start=${starts.length} end=${ends.length}`);
    }
    if (ends[0].line <= starts[0].line) {
        failMarkdownStructure(`${block.blockId}: owned block end must follow begin marker`);
    }
    return {
        blockId: block.blockId,
        start: starts[0].start,
        end: ends[0].end,
        content: source.slice(starts[0].start, ends[0].end),
    };
}
export function replaceOwnedMarkdownBlock(args) {
    const { source, mode, anchorId, block, generatedContent } = args;
    if (mode === "source")
        failMarkdownStructure(`${anchorId}: SOURCE document is read-only`);
    if (mode === "generated")
        failMarkdownStructure(`${anchorId}: whole-file GENERATED mode is not supported`);
    validateOwnedBlockSpec(block);
    const context = markdownStructure(source);
    const anchor = anchorIn(context, anchorId);
    const newline = markdownNewline(source);
    const generated = generatedContent.trimEnd();
    const wrapped = [block.beginMarker, generated, block.endMarker].join(newline);
    const existing = readOwnedMarkdownBlock(source, block);
    if (!existing) {
        const anchorLine = lineAt(context, anchor.line);
        const needsLeadingNewline = anchorLine.end === source.length && !source.endsWith("\n");
        const inserted = `${needsLeadingNewline ? newline : ""}${wrapped}${newline}`;
        const insertAt = anchorLine.end;
        const updated = source.slice(0, insertAt) + inserted + source.slice(insertAt);
        const created = readOwnedMarkdownBlock(updated, block);
        if (!created)
            failMarkdownStructure(`${block.blockId}: inserted owned block cannot be resolved`);
        return updated;
    }
    if (existing.start < anchor.offset) {
        failMarkdownStructure(`${block.blockId}: owned block precedes its anchor ${anchorId}`);
    }
    const replacement = wrapped + (existing.content.endsWith("\n") ? newline : "");
    const updated = source.slice(0, existing.start) + replacement + source.slice(existing.end);
    const beforeOutside = source.slice(0, existing.start) + source.slice(existing.end);
    const afterOutside = updated.slice(0, existing.start) + updated.slice(existing.start + replacement.length);
    if (beforeOutside !== afterOutside) {
        failMarkdownStructure(`${block.blockId}: bytes outside owned block changed`);
    }
    return updated;
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
