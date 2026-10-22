#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractLinkedIssueReferences } from "./change-intent.mjs";

interface CliRoots { packageRoot: string; repoRoot: string; enforcementMode: string | null; args: string[]; }
interface CommandSpec { options: Record<string, boolean>; positionals: number; run: (roots: CliRoots, args: string[]) => number | Promise<number>; }

const __dirname = dirname(fileURLToPath(import.meta.url)), packageRoot = resolve(__dirname, "..");
const valueOptions = (...names: string[]): Record<string, boolean> => Object.fromEntries(names.map((name) => [name, true]));
const COMMAND_SPECS: Record<string, CommandSpec> = {
  validate: { options: {}, positionals: 1, run: async (roots, args) => (await import("./validate.mjs")).runValidate(roots, args) },
  "check-diff": { options: valueOptions("--base", "--head", "--change-intent", "--format"), positionals: 0, run: async (roots, args) => (await import("./check-diff.mjs")).runCheckDiff(roots, args) },
  "check-pr": { options: valueOptions("--format"), positionals: 0, run: async (roots, args) => (await import("./github-pr.mjs")).runCheckPR(roots, args) },
  check: { options: valueOptions("--base", "--head", "--format"), positionals: 0, run: async (roots, args) => (await import("./local-compiler.mjs")).runLocalCheck(roots, args) },
  build: { options: valueOptions("--base", "--head", "--outputs"), positionals: 0, run: async (roots, args) => (await import("./projection-materialize.mjs")).runProjectionBuild(roots, args) },
  init: { options: { ...valueOptions("--preset", "--mode", "--action-ref"), "--help": false }, positionals: 0, run: async (roots, args) => (await import("./init.mjs")).runInit(roots, args) },
  doctor: { options: valueOptions("--format"), positionals: 0, run: async (roots) => ((await import("./doctor.mjs")).runDoctor(roots).fails > 0 ? 1 : 0) },
};

export const COMMANDS = Object.freeze(Object.keys(COMMAND_SPECS));
const USAGE = `Usage: repo-guard [--repo-root <path>] [--enforcement <advisory|blocking>] [${COMMANDS.join("|")}] [options]`;
export function resolveRoots(args: string[]): CliRoots {
  let repoRoot = process.cwd(), enforcementMode: string | null = null;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!["--repo-root", "--enforcement"].includes(option)) { filtered.push(option); continue; }
    const next = args[++i];
    if (!next || next.startsWith("-")) throw new Error(`${option} requires ${option === "--repo-root" ? "a path" : "a mode"} argument\n${USAGE}`);
    if (option === "--repo-root") repoRoot = resolve(next); else enforcementMode = next;
  }
  return { packageRoot, repoRoot, enforcementMode, args: filtered };
}
function parseCommand(args: string[]) {
  const remaining = [...args], first = remaining[0], command = COMMAND_SPECS[first as string] ? remaining.shift() as string : "validate", spec = COMMAND_SPECS[command];
  if (first?.startsWith("-") && command === "validate") throw new Error(`Unknown option: ${first}\n${USAGE}`);
  let positionals = 0;
  for (let i = 0; i < remaining.length; i++) {
    const token = remaining[i];
    if (!token.startsWith("-")) { positionals++; continue; }
    if (!Object.hasOwn(spec.options, token)) throw new Error(`Unknown option for ${command}: ${token}\n${USAGE}`);
    if (!spec.options[token]) continue;
    const value = remaining[++i];
    if (!value || value.startsWith("-")) throw new Error(`${token} requires a value\n${USAGE}`);
  }
  if (positionals > spec.positionals) throw new Error(`Unexpected argument for ${command}\n${USAGE}`);
  return { command, args: remaining };
}
function sameEntrypointPath(left: string, right: string) { try { return realpathSync(left) === realpathSync(right); } catch { return resolve(left) === resolve(right); } }
async function dispatch(roots: CliRoots) { const parsed = parseCommand(roots.args); return COMMAND_SPECS[parsed.command].run(roots, parsed.args); }
export async function runCli(args: string[] = process.argv.slice(2)) { try { return await dispatch(resolveRoots([...args])); } catch (error: unknown) { console.error(`ERROR: ${(error as Error).message}`); return 1; } }
const isMain = process.argv[1] && sameEntrypointPath(process.argv[1], resolve(__dirname, "repo-guard.mjs"));
if (isMain) process.exit(await runCli());

export interface AuthorityEvaluationKey {
  installationId: number; repositoryId: number; repository: string; pr: number;
  authorityBase: string; base: string; head: string; evaluator: string; authorityDigest: string;
}
export interface AuthorityTarget { installationId: number; repositoryId: number; repository: string; pr: number; }
export interface AuthorityObservation { active: boolean; key: AuthorityEvaluationKey; merge: string | null; }
export interface AuthorityRecord { key: AuthorityEvaluationKey; carrier: string | null; state: "pending" | "success" | "failure"; }
export interface AuthorityDependencies {
  observe(target: AuthorityTarget): Promise<AuthorityObservation>;
  publish(target: AuthorityTarget, sha: string, state: "pending" | "success" | "failure"): Promise<void>;
  evaluate(target: AuthorityTarget, key: AuthorityEvaluationKey, merge: string): Promise<"success" | "failure">;
  get(target: AuthorityTarget): AuthorityRecord | null;
  put(record: AuthorityRecord): void;
  remove(target: AuthorityTarget): void;
}

const AUTHORITY_CONTEXT = "trusted-enforcement";
const AUTHORITY_FORMAT = "repo-guard/github-app-authority-v1";
const SERVICE_GIT_TIMEOUT_MS = 30_000;
const SERVICE_EVALUATOR_TIMEOUT_MS = 120_000;
const SHA40 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = (value: unknown, label: string) => {
  const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`); return n;
};
const exactSha = (value: unknown, label: string) => {
  if (typeof value !== "string" || !SHA40.test(value)) throw new Error(`${label} must be a 40-hex SHA`); return value;
};
const exactRepo = (value: unknown) => {
  if (typeof value !== "string" || !REPOSITORY.test(value)) throw new Error("repository must be owner/name"); return value;
};
const targetId = (target: AuthorityTarget) => `${target.installationId}:${target.repositoryId}:${target.pr}`;
export function sameAuthorityEvaluationKey(a?: AuthorityEvaluationKey | null, b?: AuthorityEvaluationKey | null): boolean {
  return Boolean(a && b
    && a.repositoryId === b.repositoryId
    && a.authorityBase === b.authorityBase
    && a.base === b.base
    && a.head === b.head
    && a.evaluator === b.evaluator
    && a.authorityDigest === b.authorityDigest);
}
export async function reconcileAuthorityTarget(target: AuthorityTarget, deps: AuthorityDependencies): Promise<"inactive" | "skipped" | "pending" | "success" | "failure"> {
  const preservePending = async (observed: AuthorityObservation) => {
    const previous = deps.get(target);
    if (!previous || previous.key.head !== observed.key.head) await deps.publish(target, observed.key.head, "pending");
    const carrier = observed.merge ?? previous?.carrier ?? null;
    const alreadyPending = previous?.state === "pending"
      && sameAuthorityEvaluationKey(previous.key, observed.key)
      && previous.carrier === carrier;
    if (carrier && !alreadyPending) await deps.publish(target, carrier, "pending");
    deps.put({ key: observed.key, carrier, state: "pending" });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await deps.observe(target);
    if (!before.active) { await preservePending(before); return "inactive"; }
    const previous = deps.get(target);
    const sameKey = sameAuthorityEvaluationKey(previous?.key, before.key);
    const sameCarrier = previous?.carrier === before.merge;
    if (previous && previous.state !== "pending" && sameKey && sameCarrier) return "skipped";

    if (!previous || previous.key.head !== before.key.head) await deps.publish(target, before.key.head, "pending");
    if (!before.merge) {
      deps.put({ key: before.key, carrier: null, state: "pending" });
      return "pending";
    }

    const alreadyPending = previous?.state === "pending" && sameKey && sameCarrier;
    if (!alreadyPending) {
      await deps.publish(target, before.merge, "pending");
      deps.put({ key: before.key, carrier: before.merge, state: "pending" });
    }

    let result: "success" | "failure";
    try { result = await deps.evaluate(target, before.key, before.merge); }
    catch { return "pending"; }

    const after = await deps.observe(target);
    if (!after.active) { await preservePending(after); return "inactive"; }
    if (!sameAuthorityEvaluationKey(before.key, after.key) || before.merge !== after.merge) {
      await preservePending(after);
      continue;
    }

    await deps.publish(target, before.merge, result);
    deps.put({ key: after.key, carrier: before.merge, state: result });
    return result;
  }
  throw new Error("authority inputs did not stabilize");
}
export function verifyAuthorityWebhook(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

interface AuthorityConfig {
  appId: string; key: string; webhookSecret: string; evaluator: string; evaluatorRoot: string;
  state: string; work: string; api: string; host: string; port: number; interval: number;
}
const appJwt = (config: AuthorityConfig) => {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v: string) => Buffer.from(v).toString("base64url");
  const unsigned = `${enc(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${enc(JSON.stringify({ iat: now - 60, exp: now + 480, iss: config.appId }))}`;
  const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
  return `${unsigned}.${signer.sign(config.key).toString("base64url")}`;
};
async function api(config: AuthorityConfig, path: string, token: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(config.api + path, { ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function installationToken(config: AuthorityConfig, installationId: number, repositoryId?: number, write = false) {
  const body: any = { permissions: { contents: "read", pull_requests: "read", issues: "read", ...(write ? { statuses: "write" } : {}) } };
  if (repositoryId) body.repository_ids = [repositoryId];
  const result = await api(config, `/app/installations/${installationId}/access_tokens`, appJwt(config), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (typeof result?.token !== "string") throw new Error("installation token missing");
  return result.token;
}
const gitEnv = (token: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.RG_GITHUB_APP_PRIVATE_KEY;
  delete env.RG_GITHUB_APP_PRIVATE_KEY_FILE;
  delete env.RG_GITHUB_WEBHOOK_SECRET;
  return { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`, GIT_TERMINAL_PROMPT: "0" };
};

function loadAuthorityConfig(packageRoot: string): AuthorityConfig {
  const need = (name: string) => { const v = process.env[name]?.trim(); if (!v) throw new Error(`${name} is required`); return v; };
  const appId = need("RG_GITHUB_APP_ID"), webhookSecret = need("RG_GITHUB_WEBHOOK_SECRET"), evaluator = exactSha(need("RG_EVALUATOR_SHA"), "RG_EVALUATOR_SHA");
  const keyPath = process.env.RG_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const key = process.env.RG_GITHUB_APP_PRIVATE_KEY || (keyPath ? readFileSync(keyPath, "utf8") : "");
  if (!key) throw new Error("RG_GITHUB_APP_PRIVATE_KEY or RG_GITHUB_APP_PRIVATE_KEY_FILE is required");
  const evaluatorRoot = resolve(process.env.RG_EVALUATOR_ROOT || packageRoot);
  const actual = execFileSync("git", ["-C", evaluatorRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: SERVICE_GIT_TIMEOUT_MS }).trim();
  if (actual !== evaluator) throw new Error(`evaluator checkout ${actual} != ${evaluator}`);
  if (execFileSync("git", ["-C", evaluatorRoot, "status", "--porcelain=v1", "--untracked-files=no"], { encoding: "utf8", timeout: SERVICE_GIT_TIMEOUT_MS }).trim()) throw new Error("evaluator checkout has tracked modifications");
  const port = Number(process.env.RG_SERVICE_PORT || "8787"), interval = Number(process.env.RG_RECONCILE_MS || "60000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(interval) || interval < 1000) throw new Error("invalid service port/reconcile interval");
  return { appId, key, webhookSecret, evaluator, evaluatorRoot, state: resolve(process.env.RG_SERVICE_STATE_PATH || ".repo-guard-service-state.json"), work: resolve(process.env.RG_SERVICE_WORKSPACE_ROOT || tmpdir()), api: (process.env.RG_GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, ""), host: process.env.RG_SERVICE_HOST || "0.0.0.0", port, interval };
}
function fileState(path: string) {
  type State = { format: "repo-guard/authority-state-v1"; records: Record<string, AuthorityRecord> };
  const read = (): State => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { format: "repo-guard/authority-state-v1", records: {} };
  const write = (state: State) => { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(state) + "\n", { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, path); };
  return {
    get(target: AuthorityTarget) { return read().records[targetId(target)] ?? null; },
    put(record: AuthorityRecord) { const state = read(); state.records[targetId(record.key)] = record; write(state); },
    remove(target: AuthorityTarget) { const state = read(); delete state.records[targetId(target)]; write(state); },
    list() { return Object.values(read().records).map((record) => ({ installationId: record.key.installationId, repositoryId: record.key.repositoryId, repository: record.key.repository, pr: record.key.pr })); },
  };
}
async function observeAuthority(config: AuthorityConfig, target: AuthorityTarget) {
  const token = await installationToken(config, target.installationId, target.repositoryId);
  const pr = await api(config, `/repos/${target.repository}/pulls/${target.pr}`, token);
  if (positive(pr?.base?.repo?.id, "repository id") !== target.repositoryId || exactRepo(pr?.base?.repo?.full_name) !== target.repository) throw new Error("repository identity mismatch");
  const body = typeof pr?.body === "string" ? pr.body : "";
  const issues = [];
  const refs = extractLinkedIssueReferences(body, target.repository).filter((ref) => ref.repository.toLowerCase() === target.repository.toLowerCase());
  for (const ref of refs.length === 1 ? refs : []) {
    const issue = await api(config, `/repos/${target.repository}/issues/${ref.number}`, token);
    const login = typeof issue?.user?.login === "string" ? issue.user.login : null;
    let permission = null;
    if (login && issue?.user?.type !== "Bot") try { permission = (await api(config, `/repos/${target.repository}/collaborators/${encodeURIComponent(login)}/permission`, token))?.permission ?? null; } catch {}
    issues.push({ number: ref.number, body: issue?.body ?? "", login, type: issue?.user?.type ?? null, association: issue?.author_association ?? null, permission });
  }
  const base = exactSha(pr?.base?.sha, "BASE"), head = exactSha(pr?.head?.sha, "HEAD");
  const merge = typeof pr?.merge_commit_sha === "string" && SHA40.test(pr.merge_commit_sha) ? pr.merge_commit_sha : null;
  return { active: pr?.state === "open" && pr?.draft !== true && pr?.base?.ref === pr?.base?.repo?.default_branch, merge, key: { installationId: target.installationId, repositoryId: target.repositoryId, repository: target.repository, pr: target.pr, authorityBase: base, base, head, evaluator: config.evaluator, authorityDigest: createHash("sha256").update(JSON.stringify({ body, issues })).digest("hex") } };
}
async function publishAuthority(config: AuthorityConfig, target: AuthorityTarget, sha: string, state: "pending" | "success" | "failure") {
  const token = await installationToken(config, target.installationId, target.repositoryId, true);
  await api(config, `/repos/${target.repository}/statuses/${exactSha(sha, "status SHA")}`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, context: AUTHORITY_CONTEXT, description: state === "pending" ? "repo-guard reevaluation required" : state === "success" ? "repo-guard approved this exact transition" : "repo-guard rejected this exact transition" }) });
}
export function serviceEvaluatorEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  token: string,
  target: AuthorityTarget,
  config: { appId: string; evaluator: string },
  eventPath: string,
  runner: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GH_TOKEN: token,
    GITHUB_REPOSITORY: target.repository,
    GITHUB_EVENT_NAME: "repo_guard_service",
    GITHUB_WORKFLOW_REF: "",
    GITHUB_WORKFLOW_SHA: "",
    RG_EVENT_PATH: eventPath,
    RUNNER_TEMP: runner,
    RG_AUTHENTICATED_PROVIDER_BUNDLE: "",
    RG_SERVICE_REPOSITORY_ID: String(target.repositoryId),
    RG_AUTHORITY_PROVIDER: JSON.stringify({
      format: AUTHORITY_FORMAT,
      appId: config.appId,
      installationId: target.installationId,
      repositoryId: target.repositoryId,
      evaluatorSha: config.evaluator,
    }),
  };
}

export async function runBoundedChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  timeoutMs: number,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("child timeout must be a positive integer");
  return await new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectChild(error);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      finishError(new Error(`child process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => finishError(error));
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveChild({ status, signal, stdout, stderr });
    });
  });
}

async function evaluateAuthority(config: AuthorityConfig, target: AuthorityTarget, key: AuthorityEvaluationKey, expectedMerge: string): Promise<"success" | "failure"> {
  mkdirSync(config.work, { recursive: true }); const root = mkdtempSync(join(config.work, "rg-service-")), runner = mkdtempSync(join(config.work, "rg-runner-"));
  const token = await installationToken(config, target.installationId, target.repositoryId), env = gitEnv(token);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe", timeout: SERVICE_GIT_TIMEOUT_MS }).trim();
  try {
    const pr = await api(config, `/repos/${target.repository}/pulls/${target.pr}`, token), baseRef = String(pr?.base?.ref || "");
    execFileSync("git", ["check-ref-format", "--branch", baseRef], { stdio: "pipe", timeout: SERVICE_GIT_TIMEOUT_MS });
    git("init", "-q"); git("remote", "add", "origin", `https://github.com/${target.repository}.git`);
    git("fetch", "--no-tags", "--prune", "origin", `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`, `+refs/pull/${target.pr}/head:refs/remotes/pull/${target.pr}/head`, `+refs/pull/${target.pr}/merge:refs/remotes/pull/${target.pr}/merge`);
    const merge = git("rev-parse", `refs/remotes/pull/${target.pr}/merge`);
    if (merge !== expectedMerge || git("rev-parse", `refs/remotes/origin/${baseRef}`) !== key.base || git("rev-parse", `refs/remotes/pull/${target.pr}/head`) !== key.head || git("rev-parse", `${merge}^1`) !== key.base || git("rev-parse", `${merge}^2`) !== key.head) throw new Error("fetched transition changed");
    git("checkout", "-q", "--detach", key.base);
    const eventPath = join(runner, "event.json"); writeFileSync(eventPath, JSON.stringify({ pull_request: { number: target.pr, base: { sha: key.base, ref: baseRef }, head: { sha: key.head }, body: pr?.body ?? "" }, repository: { full_name: target.repository } }));
    const execution = await runBoundedChild(
      process.execPath,
      [resolve(config.evaluatorRoot, "dist/repo-guard.mjs"), "--repo-root", root, "--enforcement", "blocking", "check-pr", "--format", "json"],
      { cwd: root, env: serviceEvaluatorEnvironment(env, token, target, config, eventPath, runner) },
      SERVICE_EVALUATOR_TIMEOUT_MS,
    );
    let report: any = null; try { report = JSON.parse(execution.stdout || ""); } catch {}
    if (!report || !Number.isInteger(report.exitCode) || report.result === "error")
      throw new Error("native evaluator did not produce a policy verdict");
    if (execution.status === 0 && report.exitCode === 0 && ["passed", "passed_with_warnings"].includes(report.result))
      return "success";
    if (report.result === "failed") return "failure";
    throw new Error("native evaluator result is inconsistent");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(runner, { recursive: true, force: true }); }
}
async function page(config: AuthorityConfig, path: string, token: string, extract: (value: any) => any[]) {
  const values = []; for (let n = 1; n <= 10; n++) { const part = extract(await api(config, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${n}`, token)); values.push(...part); if (part.length < 100) break; } return values;
}
async function repositoryTargets(config: AuthorityConfig, installationId: number, repositoryId: number, repository: string, linkedIssue?: number | null) {
  const token = await installationToken(config, installationId, repositoryId);
  const pulls = await page(config, `/repos/${repository}/pulls?state=open`, token, (value) => Array.isArray(value) ? value : []);
  return pulls
    .filter((pr) => pr?.draft !== true && pr?.base?.repo?.id === repositoryId && pr?.base?.repo?.full_name === repository && pr?.base?.ref === pr?.base?.repo?.default_branch)
    .filter((pr) => !linkedIssue || extractLinkedIssueReferences(pr?.body ?? "", repository).some((ref) => ref.repository.toLowerCase() === repository.toLowerCase() && ref.number === linkedIssue))
    .map((pr) => ({ installationId, repositoryId, repository, pr: positive(pr.number, "PR") }));
}

async function runTrustedService(roots: { packageRoot: string }, args: string[] = []): Promise<number> {
  if (args.length) throw new Error("trusted-service accepts no arguments");
  const config = loadAuthorityConfig(roots.packageRoot), state = fileState(config.state), queues = new Map<string, Promise<void>>();
  const deps: AuthorityDependencies = { observe: (target) => observeAuthority(config, target), publish: (target, sha, status) => publishAuthority(config, target, sha, status), evaluate: (target, key, merge) => evaluateAuthority(config, target, key, merge), get: state.get, put: state.put, remove: state.remove };
  const enqueue = (target: AuthorityTarget) => { const id = targetId(target), prior = queues.get(id) ?? Promise.resolve(); const next = prior.catch(() => undefined).then(() => reconcileAuthorityTarget(target, deps)).then(() => undefined).catch((error) => console.error(`trusted-service ${id}: ${error.message}`)).finally(() => { if (queues.get(id) === next) queues.delete(id); }); queues.set(id, next); };
  const reconcileKnown = async () => { try { for (const target of state.list()) enqueue(target); } catch (error) { console.error(`trusted-service reconcile: ${(error as Error).message}`); } };
  const enqueueRepository = async (installationId: number, repositoryId: number, repository: string, linkedIssue?: number | null) => {
    for (const target of await repositoryTargets(config, installationId, repositoryId, repository, linkedIssue)) enqueue(target);
  };
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") { response.writeHead(200).end("ok\n"); return; }
    if (request.method !== "POST" || request.url !== "/webhook") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) request.destroy(); else chunks.push(chunk); });
    request.on("error", () => { if (!response.headersSent) response.writeHead(400).end(); });
    request.on("end", () => {
      const body = Buffer.concat(chunks), signature = Array.isArray(request.headers["x-hub-signature-256"]) ? request.headers["x-hub-signature-256"][0] : request.headers["x-hub-signature-256"];
      if (!verifyAuthorityWebhook(config.webhookSecret, body, signature)) { response.writeHead(401).end(); return; }
      let payload: any; try { payload = JSON.parse(body.toString("utf8")); } catch { response.writeHead(400).end(); return; }
      const event = Array.isArray(request.headers["x-github-event"]) ? request.headers["x-github-event"][0] : request.headers["x-github-event"];
      try {
        if (event === "pull_request" && ["opened", "edited", "synchronize", "reopened", "ready_for_review"].includes(payload?.action) && payload?.pull_request?.number)
          enqueue({ installationId: positive(payload?.installation?.id, "installation"), repositoryId: positive(payload?.repository?.id, "repository"), repository: exactRepo(payload?.repository?.full_name), pr: positive(payload.pull_request.number, "PR") });
        else if (event === "issues" && payload?.action === "edited" && payload?.changes?.body && payload?.issue?.number)
          void enqueueRepository(positive(payload?.installation?.id, "installation"), positive(payload?.repository?.id, "repository"), exactRepo(payload?.repository?.full_name), positive(payload.issue.number, "issue")).catch((error) => console.error(error.message));
        else if (event === "installation" && payload?.action === "created")
          for (const repository of payload?.repositories ?? []) void enqueueRepository(positive(payload?.installation?.id, "installation"), positive(repository?.id, "repository"), exactRepo(repository?.full_name)).catch((error) => console.error(error.message));
        else if (event === "installation_repositories")
          for (const repository of payload?.repositories_added ?? []) void enqueueRepository(positive(payload?.installation?.id, "installation"), positive(repository?.id, "repository"), exactRepo(repository?.full_name)).catch((error) => console.error(error.message));
      } catch (error) { console.error(`trusted-service webhook: ${(error as Error).message}`); }
      response.writeHead(202).end();
    });
  });
  server.listen(config.port, config.host); setInterval(() => void reconcileKnown(), config.interval).unref(); await reconcileKnown();
  console.log(`repo-guard trusted-service ${config.host}:${config.port}; gate=${AUTHORITY_CONTEXT}; evaluator=${config.evaluator}`);
  return await new Promise((resolveResult) => { const stop = () => server.close(() => resolveResult(0)); process.once("SIGINT", stop); process.once("SIGTERM", stop); });
}
