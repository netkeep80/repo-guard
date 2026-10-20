#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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
  "trusted-service": { options: {}, positionals: 0, run: async (roots, args) => runTrustedService(roots, args) },
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
  base: string; head: string; evaluator: string; authorityDigest: string;
}
export interface AuthorityTarget { installationId: number; repositoryId: number; repository: string; pr: number; }
export interface AuthorityRecord { key: AuthorityEvaluationKey; state: "pending" | "success" | "failure"; }
export interface AuthorityDependencies {
  observe(target: AuthorityTarget): Promise<{ active: boolean; key: AuthorityEvaluationKey }>;
  publish(target: AuthorityTarget, head: string, state: "pending" | "success" | "failure"): Promise<void>;
  evaluate(target: AuthorityTarget, key: AuthorityEvaluationKey): Promise<"success" | "failure">;
  get(target: AuthorityTarget): AuthorityRecord | null;
  put(record: AuthorityRecord): void;
  remove(target: AuthorityTarget): void;
}

const AUTHORITY_CONTEXT = "trusted-enforcement";
const AUTHORITY_FORMAT = "repo-guard/github-app-authority-v1";
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
  return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}
export async function reconcileAuthorityTarget(target: AuthorityTarget, deps: AuthorityDependencies): Promise<"inactive" | "skipped" | "success" | "failure"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await deps.observe(target);
    if (!before.active) { deps.remove(target); return "inactive"; }
    const previous = deps.get(target);
    if (previous && previous.state !== "pending" && sameAuthorityEvaluationKey(previous.key, before.key)) return "skipped";
    const alreadyPending = previous?.state === "pending" && sameAuthorityEvaluationKey(previous.key, before.key);
    if (!alreadyPending) {
      await deps.publish(target, before.key.head, "pending");
      deps.put({ key: before.key, state: "pending" });
    }
    let result: "success" | "failure" = "failure";
    try { result = await deps.evaluate(target, before.key); } catch {}
    const after = await deps.observe(target);
    if (!after.active) { deps.remove(target); return "inactive"; }
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
  const response = await fetch(config.api + path, { ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(init.headers || {}) } });
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
const gitEnv = (token: string): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`, GIT_TERMINAL_PROMPT: "0" });

function loadAuthorityConfig(packageRoot: string): AuthorityConfig {
  const need = (name: string) => { const v = process.env[name]?.trim(); if (!v) throw new Error(`${name} is required`); return v; };
  const appId = need("RG_GITHUB_APP_ID"), webhookSecret = need("RG_GITHUB_WEBHOOK_SECRET"), evaluator = exactSha(need("RG_EVALUATOR_SHA"), "RG_EVALUATOR_SHA");
  const keyPath = process.env.RG_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const key = process.env.RG_GITHUB_APP_PRIVATE_KEY || (keyPath ? readFileSync(keyPath, "utf8") : "");
  if (!key) throw new Error("RG_GITHUB_APP_PRIVATE_KEY or RG_GITHUB_APP_PRIVATE_KEY_FILE is required");
  const evaluatorRoot = resolve(process.env.RG_EVALUATOR_ROOT || packageRoot);
  const actual = execFileSync("git", ["-C", evaluatorRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actual !== evaluator) throw new Error(`evaluator checkout ${actual} != ${evaluator}`);
  if (execFileSync("git", ["-C", evaluatorRoot, "status", "--porcelain=v1", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Error("evaluator checkout has tracked modifications");
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
    list() { return Object.values(read().records); },
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
  return { active: pr?.state === "open" && pr?.draft !== true && pr?.base?.ref === pr?.base?.repo?.default_branch, key: { installationId: target.installationId, repositoryId: target.repositoryId, repository: target.repository, pr: target.pr, base, head, evaluator: config.evaluator, authorityDigest: createHash("sha256").update(JSON.stringify({ body, issues })).digest("hex") } };
}
async function publishAuthority(config: AuthorityConfig, target: AuthorityTarget, head: string, state: "pending" | "success" | "failure") {
  const token = await 