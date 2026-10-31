import { createHash } from "node:crypto";
const sha40 = /^[0-9a-f]{40}$/;
const repositoryIdentity = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function fail(message) {
    throw new Error("snapshot observation invalid: " + message);
}
function exactSha(value, label) {
    if (typeof value !== "string" || !sha40.test(value))
        fail(label + " must be a literal lowercase 40-hex SHA-1");
    return value;
}
function canonicalPath(value) {
    if (typeof value !== "string" || value.length === 0)
        fail("path must be a non-empty string");
    if (value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("\0") || /^[A-Za-z]:/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value))
        fail("path is not canonical: " + value);
    const parts = value.split("/");
    if (parts.some(part => part.length === 0 || part === "." || part === ".."))
        fail("path is not canonical: " + value);
    return value;
}
function resourceClass(entry) {
    if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755"))
        return "file";
    if (entry.type === "blob" && entry.mode === "120000")
        return "symlink";
    if (entry.type === "commit" && entry.mode === "160000")
        return "gitlink";
    return fail(`unsupported mode/type ${entry.mode}/${entry.type} at ${entry.path}`);
}
function gitObjectIdentity(kind, payload) {
    const header = Buffer.from(`${kind} ${payload.byteLength}\0`, "utf8");
    return createHash("sha1").update(header).update(payload).digest("hex");
}
function gitBlobIdentity(bytes) {
    return gitObjectIdentity("blob", bytes);
}
function insertEntry(root, entry) {
    const parts = entry.path.split("/");
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        if (node.leaves.has(part))
            fail("path alias conflicts with tracked file: " + entry.path);
        let child = node.trees.get(part);
        if (!child) {
            child = { leaves: new Map(), trees: new Map() };
            node.trees.set(part, child);
        }
        node = child;
    }
    const name = parts.at(-1);
    if (node.trees.has(name) || node.leaves.has(name))
        fail("duplicate or aliased tracked path: " + entry.path);
    node.leaves.set(name, entry);
}
function treeSortKey(name, tree) {
    return Buffer.concat([Buffer.from(name, "utf8"), Buffer.from([tree ? 0x2f : 0x00])]);
}
function treeIdentity(node) {
    const items = [];
    for (const [name, entry] of node.leaves)
        items.push({ name, mode: entry.mode, object: entry.object, tree: false });
    for (const [name, child] of node.trees)
        items.push({ name, mode: "40000", object: treeIdentity(child), tree: true });
    items.sort((a, b) => Buffer.compare(treeSortKey(a.name, a.tree), treeSortKey(b.name, b.tree)));
    const parts = [];
    for (const item of items) {
        parts.push(Buffer.from(`${item.mode} ${item.name}\0`, "utf8"));
        parts.push(Buffer.from(item.object, "hex"));
    }
    return gitObjectIdentity("tree", Buffer.concat(parts));
}
function validateEntries(entries, expectedTree) {
    if (!Array.isArray(entries))
        fail("entries must be an array");
    const normalized = [];
    const root = { leaves: new Map(), trees: new Map() };
    const seen = new Set();
    for (const raw of entries) {
        if (!raw || typeof raw !== "object")
            fail("entry must be an object");
        const path = canonicalPath(raw.path);
        if (seen.has(path))
            fail("duplicate tracked path: " + path);
        seen.add(path);
        const type = raw.type;
        if (type !== "blob" && type !== "commit")
            fail("invalid object type at " + path);
        const entry = {
            mode: typeof raw.mode === "string" ? raw.mode : fail("invalid mode at " + path),
            type,
            object: exactSha(raw.object, "object identity at " + path),
            path,
        };
        resourceClass(entry);
        normalized.push(entry);
        insertEntry(root, entry);
    }
    normalized.sort((a, b) => a.path.localeCompare(b.path, "en"));
    const observedTree = treeIdentity(root);
    if (observedTree !== expectedTree)
        fail(`tree identity mismatch: expected ${expectedTree}, observed ${observedTree}`);
    return normalized;
}
export function validateSnapshotObservation(repository, input) {
    if (!repositoryIdentity.test(repository))
        fail("repository identity is invalid");
    if (!input || typeof input !== "object")
        fail("snapshot must be an object");
    if (input.repository !== repository)
        fail("repository identity mismatch");
    const revision = exactSha(input.revision, "revision");
    const expectedTree = exactSha(input.treeIdentity, "tree identity");
    if (input.complete !== true)
        fail("snapshot is incomplete");
    if (typeof input.readBytes !== "function")
        fail("snapshot byte reader is missing");
    const entries = validateEntries(input.entries, expectedTree);
    const byPath = new Map(entries.map(entry => [entry.path, entry]));
    return {
        repository,
        revision,
        treeIdentity: expectedTree,
        complete: true,
        entries,
        readBytes: (path) => {
            const entry = byPath.get(canonicalPath(path));
            if (!entry)
                return null;
            if (entry.type !== "blob")
                return null;
            const raw = input.readBytes(path);
            if (raw === null || raw === undefined)
                fail("tracked blob bytes are unavailable: " + path);
            if (!(raw instanceof Uint8Array))
                fail("tracked blob bytes are invalid: " + path);
            const bytes = Buffer.from(raw);
            const observed = gitBlobIdentity(bytes);
            if (observed !== entry.object)
                fail(`blob identity mismatch at ${path}: expected ${entry.object}, observed ${observed}`);
            return bytes;
        },
    };
}
function strictBase64(value, path) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        fail("bytesBase64 must be a string at " + path);
    const bytes = Buffer.from(value, "base64");
    const canonical = bytes.toString("base64");
    if (canonical !== value)
        fail("bytesBase64 is not canonical at " + path);
    return bytes;
}
export function snapshotFromImmutableData(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        fail("immutable snapshot data must be an object");
    const value = input;
    if (!Array.isArray(value.entries))
        fail("immutable snapshot entries must be an array");
    const byteMap = new Map();
    const entries = value.entries.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            fail("immutable snapshot entry must be an object at index " + index);
        const item = raw;
        const path = canonicalPath(item.path);
        const type = item.type;
        if (type !== "blob" && type !== "commit")
            fail("invalid object type at " + path);
        const entry = {
            mode: typeof item.mode === "string" ? item.mode : fail("invalid mode at " + path),
            type,
            object: exactSha(item.object, "object identity at " + path),
            path,
        };
        const bytes = strictBase64(item.bytesBase64, path);
        if (bytes !== undefined) {
            if (type !== "blob")
                fail("non-blob entry cannot carry bytes: " + path);
            const observed = gitBlobIdentity(bytes);
            if (observed !== entry.object)
                fail(`blob identity mismatch at ${path}: expected ${entry.object}, observed ${observed}`);
            byteMap.set(path, bytes);
        }
        return entry;
    });
    const repository = typeof value.repository === "string" ? value.repository : fail("repository identity is missing");
    return validateSnapshotObservation(repository, {
        repository,
        revision: typeof value.revision === "string" ? value.revision : fail("revision is missing"),
        treeIdentity: typeof value.treeIdentity === "string" ? value.treeIdentity : fail("tree identity is missing"),
        complete: value.complete === true ? true : fail("snapshot is incomplete"),
        entries,
        readBytes: (path) => byteMap.get(path),
    });
}
export function normalizeSnapshotTransition(repository, baseInput, headInput) {
    const base = validateSnapshotObservation(repository, baseInput);
    const head = validateSnapshotObservation(repository, headInput);
    if (base.revision === head.revision && base.treeIdentity !== head.treeIdentity)
        fail(`same revision identity ${base.revision} has conflicting tree identities ${base.treeIdentity} and ${head.treeIdentity}`);
    const baseEntries = new Map(base.entries.map(entry => [entry.path, entry]));
    const headEntries = new Map(head.entries.map(entry => [entry.path, entry]));
    const paths = [...new Set([...baseEntries.keys(), ...headEntries.keys()])].sort((a, b) => a.localeCompare(b, "en"));
    const files = [];
    const resourceDeltas = [];
    for (const path of paths) {
        const before = baseEntries.get(path);
        const after = headEntries.get(path);
        if (!before) {
            files.push({ path, status: "added", addedLines: [], deletedLines: [] });
            resourceDeltas.push({ kind: "add", path });
            continue;
        }
        if (!after) {
            files.push({ path, status: "deleted", addedLines: [], deletedLines: [] });
            resourceDeltas.push({ kind: "delete", path });
            continue;
        }
        const beforeClass = resourceClass(before), afterClass = resourceClass(after);
        if (beforeClass !== afterClass) {
            files.push({ path, status: "modified", gitStatus: "T", addedLines: [], deletedLines: [] });
            resourceDeltas.push({ kind: "type_change", path, beforeType: beforeClass, afterType: afterClass });
            continue;
        }
        if (before.mode !== after.mode || before.object !== after.object) {
            files.push({ path, status: "modified", addedLines: [], deletedLines: [] });
            resourceDeltas.push({ kind: "modify", path });
        }
    }
    return { base, head, files, resourceDeltas };
}
