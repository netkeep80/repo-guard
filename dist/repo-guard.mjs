#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractLinkedIssueReferences } from "./change-intent.mjs";
const __dirname = dirname(fileURLToPath(import.meta.url)), packageRoot = resolve(__dirname, "..");
const valueOptions = (...names) => Object.fromEntries(names.map((name) => [name, true]));
const COMMAND_SPECS = {
    validate: { options: {}, positionals: 1, run: async (roots, args) => (await import("./validate.mjs")).runValidate(roots, args) },
    "check-diff": { options: valueOptions("--base", "--head", "--change-intent", "--format"), positionals: 0, run: async (roots, args) => (await import("./check-diff.mjs")).runCheckDiff(roots, args) },
    "check-pr": { options: valueOptions("--format"), positionals: 0, run: async (roots, args) => (await import("./github-pr.mjs")).runCheckPR(roots, args) },
    "trusted-service": { options: {}, positionals: 0, run: async (roots, args) => runTrustedService(roots, args) },
    init: { options: { ...valueOptions("--preset", "--mode", "--action-ref"), "--help": false }, positionals: 0, run: async (roots, args) => (await import("./init.mjs")).runInit(roots, args) },
    doctor: { options: valueOptions("--format"), positionals: 0, run: async (roots) => ((await import("./doctor.mjs")).runDoctor(roots).fails > 0 ? 1 : 0) },
};
export const COMMANDS = Object.freeze(Object.keys(COMMAND_SPECS));
const USAGE = `Usage: repo-guard [--repo-root <path>] [--enforcement <advisory|blocking>] [${COMMANDS.join("|")}] [options]`;
export function resolveRoots(args) {
    let repoRoot = process.cwd(), enforcementMode = null;
    const filtered = [];
    for (let i = 0; i < args.length; i++) {
        const option = args[i];
        if (!["--repo-root", "--enforcement"].includes(option)) {
            filtered.push(option);
            continue;
        }
        const next = args[++i];
        if (!next || next.startsWith("-"))
            throw new Error(`${option} requires ${option === "--repo-root" ? "a path" : "a mode"} argument\n${USAGE}`);
        if (option === "--repo-root")
            repoRoot = resolve(next);
        else
            enforcementMode = next;
    }
    return { packageRoot, repoRoot, enforcementMode, args: filtered };
}
function parseCommand(args) {
    const remaining = [...args], first = remaining[0], command = COMMAND_SPECS[first] ? remaining.shift() : "validate", spec = COMMAND_SPECS[command];
    if (first?.startsWith("-") && command === "validate")
        throw new Error(`Unknown option: ${first}\n${USAGE}`);
    let positionals = 0;
    for (let i = 0; i < remaining.length; i++) {
        const token = remaining[i];
        if (!token.startsWith("-")) {
            positionals++;
            continue;
        }
        if (!Object.hasOwn(spec.options, token))
            throw new Error(`Unknown option for ${command}: ${token}\n${USAGE}`);
        if (!spec.options[token])
            continue;
        const value = remaining[++i];
        if (!value || value.startsWith("-"))
            throw new Error(`${token} requires a value\n${USAGE}`);
    }
    if (positionals > spec.positionals)
        throw new Error(`Unexpected argument for ${command}\n${USAGE}`);
    return { command, args: remaining };
}
function sameEntrypointPath(left, right) { try {
    return realpathSync(left) === realpathSync(right);
}
catch {
    return resolve(left) === resolve(right);
} }
async function dispatch(roots) { const parsed = parseCommand(roots.args); return COMMAND_SPECS[parsed.command].run(roots, parsed.args); }
export async function runCli(args = process.argv.slice(2)) { try {
    return await dispatch(resolveRoots([...args]));
}
catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
} }
const isMain = process.argv[1] && sameEntrypointPath(process.argv[1], resolve(__dirname, "repo-guard.mjs"));
if (isMain)
    process.exit(await runCli());
const AUTHORITY_CONTEXT = "trusted-enforcement";
const AUTHORITY_FORMAT = "repo-guard/github-app-authority-v1";
const SHA40 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = (value, label) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0)
        throw new Error(`${label} must be a positive integer`);
    return n;
};
const exactSha = (value, label) => {
    if (typeof value !== "string" || !SHA40.test(value))
        throw new Error(`${label} must be a 40-hex SHA`);
    return value;
};
const exactRepo = (value) => {
    if (typeof value !== "string" || !REPOSITORY.test(value))
        throw new Error("repository must be owner/name");
    return value;
};
const targetId = (target) => `${target.installationId}:${target.repositoryId}:${target.pr}`;
export function sameAuthorityEvaluationKey(a, b) {
    return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}
export async function reconcileAuthorityTarget(target, deps) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const before = await deps.observe(target);
        if (!before.active) {
            deps.remove(target);
            return "inactive";
        }
        const previous = deps.get(target);
        if (previous && previous.state !== "pending" && sameAuthorityEvaluationKey(previous.key, before.key))
            return "skipped";
        const alreadyPending = previous?.state === "pending" && sameAuthorityEvaluationKey(previous.key, before.key);
        if (!alreadyPending) {
            await deps.publish(target, before.key.head, "pending");
            deps.put({ key: before.key, state: "pending" });
        }
        let result = "failure";
        try {
            result = await deps.evaluate(target, before.key);
        }
        catch { }
        const after = await deps.observe(target);
        if (!after.active) {
            deps.remove(target);
            return "inactive";
        }
        if (!sameAuthorityEvaluationKey(before.key, after.key)) {
            await deps.publish(target, after.key.head, "pending");
            deps.put({ key: after.key, state: "pending" });
            continue;
        }
        await deps.publish(target, after.key.head, result);
        deps.put({ key: after.key, state: result });
        return result;
    }
    throw new Error("authority inputs did not stabilize");
}
export function verifyAuthorityWebhook(secret, body, signature) {
    if (!secret || !signature?.startsWith("sha256="))
        return false;
    const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const appJwt = (config) => {
    const now = Math.floor(Date.now() / 1000);
    const enc = (v) => Buffer.from(v).toString("base64url");
    const unsigned = `${enc(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${enc(JSON.stringify({ iat: now - 60, exp: now + 480, iss: config.appId }))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(config.key).toString("base64url")}`;
};
async function api(config, path, token, init = {}) {
    const response = await fetch(config.api + path, { ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(init.headers || {}) } });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`GitHub API ${response.status} ${path}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}
async function installationToken(config, installationId, repositoryId, write = false) {
    const body = { permissions: { contents: "read", pull_requests: "read", issues: "read", ...(write ? { statuses: "write" } : {}) } };
    if (repositoryId)
        body.repository_ids = [repositoryId];
    const result = await api(config, `/app/installations/${installationId}/access_tokens`, appJwt(config), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (typeof result?.token !== "string")
        throw new Error("installation token missing");
    return result.token;
}
const gitEnv = (token) => ({ ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`, GIT_TERMINAL_PROMPT: "0" });
function loadAuthorityConfig(packageRoot) {
    const need = (name) => { const v = process.env[name]?.trim(); if (!v)
        throw new Error(`${name} is required`); return v; };
    const appId = need("RG_GITHUB_APP_ID"), webhookSecret = need("RG_GITHUB_WEBHOOK_SECRET"), evaluator = exactSha(need("RG_EVALUATOR_SHA"), "RG_EVALUATOR_SHA");
    const keyPath = process.env.RG_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
    const key = process.env.RG_GITHUB_APP_PRIVATE_KEY || (keyPath ? readFileSync(keyPath, "utf8") : "");
    if (!key)
        throw new Error("RG_GITHUB_APP_PRIVATE_KEY or RG_GITHUB_APP_PRIVATE_KEY_FILE is required");
    const evaluatorRoot = 