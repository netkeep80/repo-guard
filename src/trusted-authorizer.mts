import { execFileSync } from "node:child_process";

interface UserProjection {
  login?: unknown;
  type?: unknown;
}

interface IssueContextProjection {
  body?: unknown;
  user?: UserProjection | null;
  author_association?: unknown;
  labels?: unknown;
}

interface PermissionProjection {
  permission?: unknown;
  role_name?: unknown;
}

export type RepositoryPermissionObservation =
  | { status: "observed"; permission: unknown; role_name?: unknown }
  | { status: "unavailable"; permission: null; reason: string };

interface LocalTrustedAuthorizerInput {
  issueContext?: unknown;
  permissionObservation?: unknown;
}

interface ResolveTrustedAuthorizerInput {
  repoFullName: unknown;
  issueNumber?: unknown;
  issueContext?: unknown;
}

export interface TrustedAuthorizerSummary {
  trusted: boolean;
  source: "repository_permission";
  principal: {
    login: string | null;
    user_type: string | null;
    is_bot: boolean;
    author_association: string | null;
  };
  permission: RepositoryPermissionObservation;
  observed_labels: string[];
  reason: "trusted_permission" | "permission_insufficient" | "permission_unavailable" | "bot_principal" | "principal_missing";
}

const GITHUB_REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const TRUSTED_PERMISSIONS = new Set<string>(["admin", "maintain", "write"]);

function isValidRepo(repoFullName: unknown): repoFullName is string {
  return typeof repoFullName === "string" && GITHUB_REPO_FULL_NAME.test(repoFullName);
}

function isValidIssueNumber(number: unknown): boolean {
  return POSITIVE_INTEGER.test(String(number));
}

function safeGhJson(args: string[]): unknown | null {
  try {
    const out = execFileSync("gh", args, { encoding: "utf-8", timeout: 30000 });
    return out.trim() ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

export function fetchIssueAuthorContext(repoFullName: unknown, issueNumber: unknown): unknown | null {
  if (!isValidRepo(repoFullName) || !isValidIssueNumber(issueNumber)) return null;
  return safeGhJson([
    "api",
    `repos/${repoFullName}/issues/${issueNumber as string | number | bigint}`,
    "--jq",
    "{body: .body, user: {login: .user.login, type: .user.type}, author_association: .author_association, labels: [.labels[].name]}",
  ]);
}

export function fetchUserRepoPermission(repoFullName: unknown, username: unknown): RepositoryPermissionObservation {
  if (!isValidRepo(repoFullName) || typeof username !== "string" || username.length === 0) {
    return { status: "unavailable", permission: null, reason: "invalid_permission_lookup_input" };
  }
  const encodedUsername = encodeURIComponent(username);
  try {
    const out = execFileSync("gh", [
      "api",
      `repos/${repoFullName}/collaborators/${encodedUsername}/permission`,
      "--jq",
      "{permission, role_name}",
    ], { encoding: "utf-8", timeout: 30000 });
    const result = out.trim() ? JSON.parse(out) as PermissionProjection : null;
    if (!result || typeof result.permission !== "string") {
      return { status: "unavailable", permission: null, reason: "permission_response_invalid" };
    }
    return { status: "observed", permission: result.permission, role_name: result.role_name };
  } catch {
    return { status: "unavailable", permission: null, reason: "permission_lookup_failed" };
  }
}

export function isPermissionTrusted(permission: unknown): boolean {
  return typeof permission === "string" && TRUSTED_PERMISSIONS.has(permission);
}

export function isBotUser(user: unknown): boolean {
  if (!user || typeof user !== "object") return false;
  if ((user as UserProjection).type === "Bot") return true;
  return typeof (user as UserProjection).login === "string" && /\[bot\]$/i.test((user as UserProjection).login as string);
}

function normalizePermissionObservation(value: unknown): RepositoryPermissionObservation {
  if (value && typeof value === "object") {
    const candidate = value as Partial<RepositoryPermissionObservation>;
    if (candidate.status === "observed") return { status: "observed", permission: candidate.permission, ...("role_name" in candidate ? { role_name: candidate.role_name } : {}) };
    if (candidate.status === "unavailable") return { status: "unavailable", permission: null, reason: typeof candidate.reason === "string" ? candidate.reason : "permission_unavailable" };
  }
  return { status: "unavailable", permission: null, reason: "permission_not_observed" };
}

export function detectTrustedAuthorizerLocally({ issueContext, permissionObservation }: LocalTrustedAuthorizerInput): TrustedAuthorizerSummary {
  const context = issueContext && typeof issueContext === "object" ? issueContext as IssueContextProjection : null;
  const user = context?.user && typeof context.user === "object" ? context.user : null;
  const login = typeof user?.login === "string" && user.login ? user.login : null;
  const userType = typeof user?.type === "string" && user.type ? user.type : null;
  const authorAssociation = typeof context?.author_association === "string" ? context.author_association : null;
  const labels = Array.isArray(context?.labels) ? context.labels.filter((label): label is string => typeof label === "string") : [];
  const permission = normalizePermissionObservation(permissionObservation);
  const bot = isBotUser(user);
  const positivePermission = permission.status === "observed" && isPermissionTrusted(permission.permission);
  const trusted = Boolean(login && !bot && positivePermission);
  const reason: TrustedAuthorizerSummary["reason"] = !login
    ? "principal_missing"
    : bot
      ? "bot_principal"
      : permission.status === "unavailable"
        ? "permission_unavailable"
        : positivePermission
          ? "trusted_permission"
          : "permission_insufficient";

  return {
    trusted,
    source: "repository_permission",
    principal: { login, user_type: userType, is_bot: bot, author_association: authorAssociation },
    permission,
    observed_labels: labels,
    reason,
  };
}

export function resolveTrustedAuthorizer({ repoFullName, issueNumber, issueContext }: ResolveTrustedAuthorizerInput): TrustedAuthorizerSummary {
  const observedIssueContext = issueContext === undefined ? (issueNumber ? fetchIssueAuthorContext(repoFullName, issueNumber) : null) : issueContext;
  const context = observedIssueContext && typeof observedIssueContext === "object" ? observedIssueContext as IssueContextProjection : null;
  const username = context?.user?.login;
  const permissionObservation = typeof username === "string" && username.length && !isBotUser(context?.user)
    ? fetchUserRepoPermission(repoFullName, username)
    : { status: "unavailable", permission: null, reason: isBotUser(context?.user) ? "bot_principal" : "principal_missing" } as RepositoryPermissionObservation;
  return detectTrustedAuthorizerLocally({ issueContext: observedIssueContext, permissionObservation });
}
