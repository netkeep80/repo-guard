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
        let result;
        try {
            result = await deps.evaluate(target, before.key);
        }
        catch {
            return "pending";
        }
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
    const response = await fetch(config.api + path, { ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) });
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
    const evaluatorRoot = resolve(process.env.RG_EVALUATOR_ROOT || packageRoot);
    const actual = execFileSync("git", ["-C", evaluatorRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (actual !== evaluator)
        throw new Error(`evaluator checkout ${actual} != ${evaluator}`);
    if (execFileSync("git", ["-C", evaluatorRoot, "status", "--porcelain=v1", "--untracked-files=no"], { encoding: "utf8" }).trim())
        throw new Error("evaluator checkout has tracked modifications");
    const port = Number(process.env.RG_SERVICE_PORT || "8787"), interval = Number(process.env.RG_RECONCILE_MS || "60000");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(interval) || interval < 1000)
        throw new Error("invalid service port/reconcile interval");
    return { appId, key, webhookSecret, evaluator, evaluatorRoot, state: resolve(process.env.RG_SERVICE_STATE_PATH || ".repo-guard-service-state.json"), work: resolve(process.env.RG_SERVICE_WORKSPACE_ROOT || tmpdir()), api: (process.env.RG_GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, ""), host: process.env.RG_SERVICE_HOST || "0.0.0.0", port, interval };
}
function fileState(path) {
    const read = () => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { format: "repo-guard/authority-state-v1", records: {} };
    const write = (state) => { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(state) + "\n", { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, path); };
    return {
        get(target) { return read().records[targetId(target)] ?? null; },
        put(record) { const state = read(); state.records[targetId(record.key)] = record; write(state); },
        remove(target) { const state = read(); delete state.records[targetId(target)]; write(state); },
        list() { return Object.values(read().records).map((record) => ({ installationId: record.key.installationId, repositoryId: record.key.repositoryId, repository: record.key.repository, pr: record.key.pr })); },
    };
}
async function observeAuthority(config, target) {
    const token = await installationToken(config, target.installationId, target.repositoryId);
    const pr = await api(config, `/repos/${target.repository}/pulls/${target.pr}`, token);
    if (positive(pr?.base?.repo?.id, "repository id") !== target.repositoryId || exactRepo(pr?.base?.repo?.full_name) !== target.repository)
        throw new Error("repository identity mismatch");
    const body = typeof pr?.body === "string" ? pr.body : "";
    const issues = [];
    const refs = extractLinkedIssueReferences(body, target.repository).filter((ref) => ref.repository.toLowerCase() === target.repository.toLowerCase());
    for (const ref of refs.length === 1 ? refs : []) {
        const issue = await api(config, `/repos/${target.repository}/issues/${ref.number}`, token);
        const login = typeof issue?.user?.login === "string" ? issue.user.login : null;
        let permission = null;
        if (login && issue?.user?.type !== "Bot")
            try {
                permission = (await api(config, `/repos/${target.repository}/collaborators/${encodeURIComponent(login)}/permission`, token))?.permission ?? null;
            }
            catch { }
        issues.push({ number: ref.number, body: issue?.body ?? "", login, type: issue?.user?.type ?? null, association: issue?.author_association ?? null, permission });
    }
    const base = exactSha(pr?.base?.sha, "BASE"), head = exactSha(pr?.head?.sha, "HEAD");
    return { active: pr?.state === "open" && pr?.draft !== true && pr?.base?.ref === pr?.base?.repo?.default_branch, key: { installationId: target.installationId, repositoryId: target.repositoryId, repository: target.repository, pr: target.pr, authorityBase: base, base, head, evaluator: config.evaluator, authorityDigest: createHash("sha256").update(JSON.stringify({ body, issues })).digest("hex") } };
}
async function publishAuthority(config, target, head, state) {
    const token = await installationToken(config, target.installationId, target.repositoryId, true);
    await api(config, `/repos/${target.repository}/statuses/${exactSha(head, "status HEAD")}`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, context: AUTHORITY_CONTEXT, description: state === "pending" ? "repo-guard reevaluation required" : state === "success" ? "repo-guard approved this exact transition" : "repo-guard rejected this exact transition" }) });
}
async function evaluateAuthority(config, target, key) {
    mkdirSync(config.work, { recursive: true });
    const root = mkdtempSync(join(config.work, "rg-service-")), runner = mkdtempSync(join(config.work, "rg-runner-"));
    const token = await installationToken(config, target.installationId, target.repositoryId), env = gitEnv(token);
    const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
    try {
        const pr = await api(config, `/repos/${target.repository}/pulls/${target.pr}`, token), baseRef = String(pr?.base?.ref || "");
        execFileSync("git", ["check-ref-format", "--branch", baseRef], { stdio: "pipe" });
        git("init", "-q");
        git("remote", "add", "origin", `https://github.com/${target.repository}.git`);
        git("fetch", "--no-tags", "--prune", "origin", `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`, `+refs/pull/${target.pr}/head:refs/remotes/pull/${target.pr}/head`, `+refs/pull/${target.pr}/merge:refs/remotes/pull/${target.pr}/merge`);
        const merge = git("rev-parse", `refs/remotes/pull/${target.pr}/merge`);
        if (git("rev-parse", `refs/remotes/origin/${baseRef}`) !== key.base || git("rev-parse", `refs/remotes/pull/${target.pr}/head`) !== key.head || git("rev-parse", `${merge}^1`) !== key.base || git("rev-parse", `${merge}^2`) !== key.head)
            throw new Error("fetched transition changed");
        git("checkout", "-q", "--detach", key.base);
        const eventPath = join(runner, "event.json");
        writeFileSync(eventPath, JSON.stringify({ pull_request: { number: target.pr, base: { sha: key.base, ref: baseRef }, head: { sha: key.head }, body: pr?.body ?? "" }, repository: { full_name: target.repository } }));
        const execution = spawnSync(process.execPath, [resolve(config.evaluatorRoot, "dist/repo-guard.mjs"), "--repo-root", root, "--enforcement", "blocking", "check-pr", "--format", "json"], { cwd: root, encoding: "utf8", env: { ...env, GH_TOKEN: token, GITHUB_REPOSITORY: target.repository, GITHUB_EVENT_NAME: "repo_guard_service", GITHUB_WORKFLOW_REF: "", GITHUB_WORKFLOW_SHA: "", RG_EVENT_PATH: eventPath, RUNNER_TEMP: runner, RG_AUTHENTICATED_PROVIDER_BUNDLE: "", RG_AUTHORITY_PROVIDER: JSON.stringify({ format: AUTHORITY_FORMAT, appId: config.appId, installationId: target.installationId, repositoryId: target.repositoryId, evaluatorSha: config.evaluator }) } });
        let report = null;
        try {
            report = JSON.parse(execution.stdout || "");
        }
        catch { }
        if (!report || !Number.isInteger(report.exitCode) || report.result === "error")
            throw new Error("native evaluator did not produce a policy verdict");
        if (execution.status === 0 && report.exitCode === 0 && ["passed", "passed_with_warnings"].includes(report.result))
            return "success";
        if (report.result === "failed")
            return "failure";
        throw new Error("native evaluator result is inconsistent");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(runner, { recursive: true, force: true });
    }
}
async function page(config, path, token, extract) {
    const values = [];
    for (let n = 1; n <= 10; n++) {
        const part = extract(await api(config, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${n}`, token));
        values.push(...part);
        if (part.length < 100)
            break;
    }
    return values;
}
async function repositoryTargets(config, installationId, repositoryId, repository, linkedIssue) {
    const token = await installationToken(config, installationId, repositoryId);
    const pulls = await page(config, `/repos/${repository}/pulls?state=open`, token, (value) => Array.isArray(value) ? value : []);
    return pulls
        .filter((pr) => pr?.draft !== true && pr?.base?.repo?.id === repositoryId && pr?.base?.repo?.full_name === repository && pr?.base?.ref === pr?.base?.repo?.default_branch)
        .filter((pr) => !linkedIssue || extractLinkedIssueReferences(pr?.body ?? "", repository).some((ref) => ref.repository.toLowerCase() === repository.toLowerCase() && ref.number === linkedIssue))
        .map((pr) => ({ installationId, repositoryId, repository, pr: positive(pr.number, "PR") }));
}
export async function runTrustedService(roots, args = []) {
    if (args.length)
        throw new Error("trusted-service accepts no arguments");
    const config = loadAuthorityConfig(roots.packageRoot), state = fileState(config.state), queues = new Map();
    const deps = { observe: (target) => observeAuthority(config, target), publish: (target, head, status) => publishAuthority(config, target, head, status), evaluate: (target, key) => evaluateAuthority(config, target, key), get: state.get, put: state.put, remove: state.remove };
    const enqueue = (target) => { const id = targetId(target), prior = queues.get(id) ?? Promise.resolve(); const next = prior.catch(() => undefined).then(() => reconcileAuthorityTarget(target, deps)).then(() => undefined).catch((error) => console.error(`trusted-service ${id}: ${error.message}`)).finally(() => { if (queues.get(id) === next)
        queues.delete(id); }); queues.set(id, next); };
    const reconcileKnown = async () => { try {
        for (const target of state.list())
            enqueue(target);
    }
    catch (error) {
        console.error(`trusted-service reconcile: ${error.message}`);
    } };
    const enqueueRepository = async (installationId, repositoryId, repository, linkedIssue) => {
        for (const target of await repositoryTargets(config, installationId, repositoryId, repository, linkedIssue))
            enqueue(target);
    };
    const server = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/healthz") {
            response.writeHead(200).end("ok\n");
            return;
        }
        if (request.method !== "POST" || request.url !== "/webhook") {
            response.writeHead(404).end();
            return;
        }
        const chunks = [];
        let size = 0;
        request.on("data", (chunk) => { size += chunk.length; if (size > 1024 * 1024)
            request.destroy();
        else
            chunks.push(chunk); });
        request.on("error", () => { if (!response.headersSent)
            response.writeHead(400).end(); });
        request.on("end", () => {
            const body = Buffer.concat(chunks), signature = Array.isArray(request.headers["x-hub-signature-256"]) ? request.headers["x-hub-signature-256"][0] : request.headers["x-hub-signature-256"];
            if (!verifyAuthorityWebhook(config.webhookSecret, body, signature)) {
                response.writeHead(401).end();
                return;
            }
            let payload;
            try {
                payload = JSON.parse(body.toString("utf8"));
            }
            catch {
                response.writeHead(400).end();
                return;
            }
            const event = Array.isArray(request.headers["x-github-event"]) ? request.headers["x-github-event"][0] : request.headers["x-github-event"];
            try {
                if (event === "pull_request" && ["opened", "edited", "synchronize", "reopened", "ready_for_review"].includes(payload?.action) && payload?.pull_request?.number)
                    enqueue({ installationId: positive(payload?.installation?.id, "installation"), repositoryId: positive(payload?.repository?.id, "repository"), repository: exactRepo(payload?.repository?.full_name), pr: positive(payload.pull_request.number, "PR") });
                else if (event === "issues" && payload?.action === "edited" && payload?.changes?.body && payload?.issue?.number)
                    void enqueueRepository(positive(payload?.installation?.id, "installation"), positive(payload?.repository?.id, "repository"), exactRepo(payload?.repository?.full_name), positive(payload.issue.number, "issue")).catch((error) => console.error(error.message));
                else if (event === "installation" && payload?.action === "created")
                    for (const repository of payload?.repositories ?? [])
                        void enqueueRepository(positive(payload?.installation?.id, "installation"), positive(repository?.id, "repository"), exactRepo(repository?.full_name)).catch((error) => console.error(error.message));
                else if (event === "installation_repositories")
                    for (const repository of payload?.repositories_added ?? [])
                        void enqueueRepository(positive(payload?.installation?.id, "installation"), positive(repository?.id, "repository"), exactRepo(repository?.full_name)).catch((error) => console.error(error.message));
            }
            catch (error) {
                console.error(`trusted-service webhook: ${error.message}`);
            }
            response.writeHead(202).end();
        });
    });
    server.listen(config.port, config.host);
    setInterval(() => void reconcileKnown(), config.interval).unref();
    await reconcileKnown();
    console.log(`repo-guard trusted-service ${config.host}:${config.port}; gate=${AUTHORITY_CONTEXT}; evaluator=${config.evaluator}`);
    return await new Promise((resolveResult) => { const stop = () => server.close(() => resolveResult(0)); process.once("SIGINT", stop); process.once("SIGTERM", stop); });
}
