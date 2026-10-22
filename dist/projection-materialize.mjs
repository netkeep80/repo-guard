// @ts-nocheck
// #800: deterministic, fail-closed local materialization over accepted Projection ownership.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { runGit, listTrackedEntriesAtRef, readFileAtRef } from "./git.mjs";
import { parseProjectionCheckState, evaluateProjectionCheck } from "./projection-check.mjs";
import { replaceOwnedMarkdownBlock, readOwnedMarkdownBlock } from "./markdown-structure.mjs";
import { loadNativeRequirements, strictCanonicalJson } from "./runtime/canonical-requirements.mjs";
const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
function deny(reason) { throw new Error("projection_build_red: " + reason); }
function exact(root, revision) {
    if (!hex40.test(revision || ""))
        deny("base/head must be exact commit SHAs");
    const found = runGit(["rev-parse", "--verify", revision + "^{commit}"], { cwd: root }).trim();
    if (found !== revision)
        deny("exact commit not available: " + revision);
    return revision;
}
function key(target) {
    if (target.ownership === "generated")
        return JSON.stringify({ kind: "whole_file", path: target.path });
    const locator = target.locator;
    if (!locator || locator.kind !== "markdown_owned_block")
        deny("writable region requires a durable owned-block locator");
    return JSON.stringify({ kind: "markdown_owned_block", path: target.path,
        anchor_id: locator.anchor_id, block_id: locator.block_id });
}
function safeRelative(path) {
    if (typeof path !== "string" || path === "" || path.split("/")[0]?.toLowerCase() === ".git" || path.includes("\\") ||
        isAbsolute(path) || path.startsWith("/") || path.split("/").some((p) => p === "." || p === ".." || !p)) {
        deny("unsafe materialization path: " + String(path));
    }
    return path;
}
function byteText(bytes, label) {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        deny("non-UTF8 content cannot be mutated safely: " + label);
    }
}
function blockSpec(model) {
    const locator = model.target.locator;
    if (!locator || locator.kind !== "markdown_owned_block")
        deny("invalid HYBRID locator");
    return { blockId: locator.block_id, beginMarker: locator.begin_marker, endMarker: locator.end_marker };
}
function currentOutput(content, model) {
    if (content === null)
        return null;
    if (model.target.ownership === "generated")
        return content;
    const block = readOwnedMarkdownBlock(content, blockSpec(model));
    return block ? block.content : null;
}
function localRepository(root) {
    let remote = "";
    try {
        remote = runGit(["config", "--get", "remote.origin.url"], { cwd: root }).trim();
    }
    catch { }
    const match = remote.match(/(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
    return match?.[1] || "local/repository";
}
function validateLocalPath(root, path, before, after, expected) {
    safeRelative(path);
    const absolute = resolve(root, path);
    if (absolute === root || !absolute.startsWith(root + sep))
        deny("path escapes repository: " + path);
    // Inspect every ancestor; never follow a symlink to a target or its parent.
    let cursor = root;
    const parts = path.split("/");
    let prefix = "";
    for (const part of parts.slice(0, -1)) {
        prefix = prefix ? prefix + "/" + part : part;
        for (const entry of [before.get(prefix), after.get(prefix)]) {
            if (entry && (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) {
                deny("unsupported symlink/submodule ancestor in exact Git tree: " + path);
            }
        }
        cursor = join(cursor, part);
        if (!existsSync(cursor))
            continue;
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            deny("unsafe parent tree entry: " + path);
    }
    const atHead = after.get(path);
    const atBase = before.get(path);
    for (const entry of [atHead, atBase]) {
        if (entry && (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) {
            deny("non-regular Git tree entry: " + path);
        }
    }
    if (atHead && atBase && atHead.mode !== atBase.mode)
        deny("changed file mode: " + path);
    const present = existsSync(absolute) || (() => {
        try {
            lstatSync(absolute);
            return true;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return false;
            throw error;
        }
    })();
    if (present) {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink() || !stat.isFile())
            deny("non-regular working-tree entry: " + path);
        if (atHead && (((stat.mode & 0o111) !== 0) !== (atHead.mode === "100755"))) {
            deny("changed working-tree file mode: " + path);
        }
    }
    const observed = present ? byteText(readFileSync(absolute), path) : null;
    if (observed !== expected.before && observed !== expected.after) {
        deny("working-tree content differs from exact HEAD and deterministic planned output: " + path);
    }
    // A tracked source cannot disappear except by a planned delete; an untracked obstacle
    // cannot masquerade as an exact HEAD output.
    if (atHead && observed === null && expected.after !== null)
        deny("tracked output absent: " + path);
    if (!atHead && observed !== null && observed !== expected.after)
        deny("unexpected untracked target: " + path);
    return { absolute, observed, mode: atHead?.mode || atBase?.mode || "100644" };
}
function nativeIndex(root, revision, entries) {
    const paths = [...entries.keys()].filter((p) => /^requirements\/.*\.rg\.(yaml|json)$/.test(p));
    const native = loadNativeRequirements({
        repository: localRepository(root), revision, paths,
        readFile: (_sha, path) => readFileAtRef(revision, path, root),
    });
    if (!native.ok)
        deny("invalid canonical Requirement index: " + native.errors.map((e) => e.code).join(","));
    return native;
}
function priorOrphanIntegrity(model, current, accepted) {
    const observed = currentOutput(current, model);
    if (observed === null || !accepted || !hex64.test(accepted.build.output_identity.digest)) {
        deny("orphan does not have exact accepted BASE build evidence: " + model.id);
    }
    if (sha(observed) !== accepted.build.output_identity.digest) {
        deny("orphan output changed after BASE publication: " + model.id);
    }
    return observed;
}
function removeOwned(content, model) {
    if (model.target.ownership === "generated")
        return null;
    const block = readOwnedMarkdownBlock(content, blockSpec(model));
    if (!block)
        deny("missing orphan block: " + model.id);
    // Do not remove authored newline characters outside the exact marker interval.
    return content.slice(0, block.start) + content.slice(block.end);
}
function replaceOwned(content, model, generated) {
    if (typeof content !== "string")
        deny("HYBRID file must already exist: " + model.target.path);
    return replaceOwnedMarkdownBlock({
        source: content, mode: "hybrid", anchorId: model.target.locator.anchor_id,
        block: blockSpec(model), generatedContent: generated,
    });
}
function stagesFor(input) {
    const root = resolve(input.repoRoot);
    const base = exact(root, input.base);
    const head = exact(root, input.head);
    if (runGit(["rev-parse", "--verify", "HEAD"], { cwd: root }).trim() !== head) {
        deny("working copy must be checked out at exact HEAD");
    }
    const baseTree = new Map(listTrackedEntriesAtRef(base, root).map((e) => [e.path, e]));
    const headTree = new Map(listTrackedEntriesAtRef(head, root).map((e) => [e.path, e]));
    const statePath = ".repo-guard/projections.json";
    const rawBase = baseTree.has(statePath) ? readFileAtRef(base, statePath, root) : null;
    const rawHead = headTree.has(statePath) ? readFileAtRef(head, statePath, root) : null;
    const prior = parseProjectionCheckState(rawBase);
    const current = parseProjectionCheckState(rawHead);
    const view = (path) => headTree.has(path) ? readFileAtRef(head, path, root) : null;
    const report = evaluateProjectionCheck({
        baseRaw: rawBase, headRaw: rawHead, readHead: view,
        facts: { readFile: view, diff: { files: { checked: [] } } },
    });
    if (report.ownership.conflicts.length ||
        report.diagnostics.some((d) => d.code.startsWith("projection_source_reclassification"))) {
        deny("ownership/reclassification conflict: " +
            report.diagnostics.filter((d) => d.code.startsWith("projection_ownership") ||
                d.code.startsWith("projection_source_reclassification")).map((d) => d.code).join(","));
    }
    const live = current.entries.filter((e) => e.state === "live");
    const retained = current.entries.filter((e) => e.state === "retained");
    const supplied = input.outputs;
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
        deny("outputs must be an object");
    const ids = new Set(live.map((e) => e.model.id));
    for (const id of Object.keys(supplied))
        if (!ids.has(id))
            deny("unowned generated output: " + id);
    for (const id of ids)
        if (typeof supplied[id] !== "string")
            deny("missing rendered bytes: " + id);
    const updated = new Map();
    function stage(path) {
        safeRelative(path);
        if (!updated.has(path))
            updated.set(path, {
                before: view(path),
                after: view(path),
            });
        return updated.get(path);
    }
    for (const item of [...live].sort((a, b) => a.model.id.localeCompare(b.model.id, "en"))) {
        const p = item.model.target.path;
        const target = stage(p);
        const generated = supplied[item.model.id];
        target.after = item.model.target.ownership === "generated"
            ? generated : replaceOwned(target.after, item.model, generated);
        const published = currentOutput(target.after, item.model);
        if (published === null || sha(published) !== item.build.output_identity.digest) {
            deny("rendered bytes do not match versioned BuildRecord output identity: " + item.model.id);
        }
    }
    const oldLive = prior.entries.filter((e) => e.state === "live");
    const orphanKeys = new Set(report.ownership.orphan);
    const native = nativeIndex(root, head, headTree);
    for (const item of oldLive) {
        const model = item.model;
        const p = model.target.path;
        if (!orphanKeys.has(key(model.target)))
            continue;
        const change = stage(p);
        priorOrphanIntegrity(model, change.after, item);
        change.after = removeOwned(change.after, model);
    }
    if (orphanKeys.size > 0 &&
        oldLive.filter((item) => orphanKeys.has(key(item.model.target))).length !== orphanKeys.size) {
        deny("orphan lacks one exact BASE live writer");
    }
    // Validate the entire prospective output snapshot before touching the filesystem.
    const prospective = (path) => updated.has(path) ? updated.get(path).after : view(path);
    const afterReport = evaluateProjectionCheck({
        baseRaw: rawBase, headRaw: rawHead, readHead: prospective,
        facts: { readFile: prospective, diff: { files: { checked: [] } } },
        resolveRequirement: (id) => native.index[id] ? {
            digest: native.index[id].semantic.digest,
            path: native.index[id].source.path,
        } : null,
    });
    if (!afterReport.ok || afterReport.analyses.some((a) => a.freshness !== "CURRENT")) {
        deny("prospective output would not pass read-only ProjectionCheck: " +
            afterReport.diagnostics.map((d) => d.code).join(","));
    }
    const ready = [...updated.entries()].sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([path, values]) => ({ path, ...values }));
    const candidates = ready.map((item) => ({
        ...item, ...validateLocalPath(root, item.path, baseTree, headTree, item),
    }));
    return { root, base, head, candidates };
}
export function runProjectionBuild(roots, args) {
    function opt(name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; }
    const base = opt("--base"), head = opt("--head"), outputsPath = opt("--outputs");
    if (!base || !head || !outputsPath)
        deny("build requires --base, --head and --outputs");
    const outputs = strictCanonicalJson(readFileSync(resolve(roots.repoRoot, outputsPath), "utf8"));
    const plan = stagesFor({ repoRoot: roots.repoRoot, base, head, outputs });
    const applied = [];
    const createdDirs = [];
    try {
        for (const item of plan.candidates) {
            if (item.observed === item.after)
                continue;
            // Revalidate destination immediately before mutation; no symlink dereference.
            if (item.observed !== null) {
                const stat = lstatSync(item.absolute);
                if (stat.isSymbolicLink() || !stat.isFile())
                    deny("target type changed during apply: " + item.path);
                if (byteText(readFileSync(item.absolute), item.path) !== item.observed) {
                    deny("target content changed during apply: " + item.path);
                }
            }
            else if (existsSync(item.absolute))
                deny("target appeared during apply: " + item.path);
            if (item.after === null) {
                unlinkSync(item.absolute);
            }
            else {
                let parent = dirname(item.absolute);
                const missing = [];
                while (!existsSync(parent) && parent.startsWith(plan.root + sep)) {
                    missing.push(parent);
                    parent = dirname(parent);
                }
                for (const dir of missing.reverse()) {
                    mkdirSync(dir);
                    createdDirs.push(dir);
                }
                const temp = item.absolute + ".repo-guard-build-" + process.pid + "-" + applied.length;
                try {
                    writeFileSync(temp, item.after, { flag: "wx", mode: item.mode === "100755" ? 0o755 : 0o644 });
                    chmodSync(temp, item.mode === "100755" ? 0o755 : 0o644);
                    renameSync(temp, item.absolute);
                }
                finally {
                    rmSync(temp, { force: true });
                }
            }
            applied.push(item);
        }
    }
    catch (error) {
        // Best-effort exception rollback; no output is touched on validation RED.
        for (const item of applied.reverse()) {
            if (item.before === null)
                rmSync(item.absolute, { force: true });
            else {
                writeFileSync(item.absolute, item.before);
                chmodSync(item.absolute, item.mode === "100755" ? 0o755 : 0o644);
            }
        }
        for (const dir of createdDirs.reverse()) {
            try {
                rmdirSync(dir);
            }
            catch { }
        }
        throw error;
    }
    console.log(JSON.stringify({ ok: true, base: plan.base, head: plan.head,
        updated: applied.map((item) => item.path), idempotent: applied.length === 0 }));
    return 0;
}
