import { execFileSync } from "node:child_process";
const GITHUB_REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const TRUSTED_PERMISSIONS = new Set(["admin", "maintain", "write"]);
function isValidRepo(repoFullName) {
    return typeof repoFullName === "string" && GITHUB_REPO_FULL_NAME.test(repoFullName);
}
function isValidIssueNumber(number) {
    return POSITIVE_INTEGER.test(String(number));
}
export function describeGhFailure(error) {
    if (error && typeof error === "object") {
        const candidate = error;
        const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
        const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
        const detail = stderr || message || (candidate.status !== undefined ? `exit status ${String(candidate.status)}` : "unknown gh failure");
        return detail.replace(/\\s+/g, " ").slice(0, 500);
    }
    return String(error).replace(/\\s+/g, " ").slice(0, 500);
}
function safeGhJson(args, operation) {
    try {
        const out = execFileSync("gh", args, { encoding: "utf-8", timeout: 30000 });
        return out.trim() ? JSON.parse(out) : null;
    }
    catch (error) {
        console.error(`repo-guard: ${operation} failed: ${describeGhFailure(error)}`);
        return null;
    }
}
export function fetchIssueAuthorContext(repoFullName, issueNumber) {
    if (!isValidRepo(repoFullName) || !isValidIssueNumber(issueNumber))
        return null;
    return safeGhJson([
        "api",
        `repos/${repoFullName}/issues/${issueNumber}`,
        "--jq",
        "{body: .body, user: {login: .user.login, type: .user.type}, author_association: .author_association, labels: [.labels[].name]}",
    ], `linked issue #${String(issueNumber)} fetch`);
}
export function fetchUserRepoPermission(repoFullName, username) {
    if (!isValidRepo(repoFullName) || typeof username !== "string" || username.length === 0) {
        return { status: "unavailable", permission: null, reason: "invalid_permission_lookup_input" };
    }
    const encodedUsername = encodeURIComponent(username);
    const result = safeGhJson([
        "api",
        `repos/${repoFullName}/collaborators/${encodedUsername}/permission`,
        "--jq",
        "{permission, role_name}",
    ], `repository permission lookup for ${username}`);
    if (!result) {
        return { status: "unavailable", permission: null, reason: "permission_lookup_failed" };
    }
    if (typeof result.permission !== "string") {
        return { status: "unavailable", permission: null, reason: "permission_response_invalid" };
    }
    return { status: "observed", permission: result.permission, role_name: result.role_name };
}
export function isPermissionTrusted(permission) {
    return typeof permission === "string" && TRUSTED_PERMISSIONS.has(permission);
}
export function isBotUser(user) {
    if (!user || typeof user !== "object")
        return false;
    if (user.type === "Bot")
        return true;
    return typeof user.login === "string" && /\[bot\]$/i.test(user.login);
}
function normalizePermissionObservation(value) {
    if (value && typeof value === "object") {
        const candidate = value;
        if (candidate.status === "observed")
            return { status: "observed", permission: candidate.permission, ...("role_name" in candidate ? { role_name: candidate.role_name } : {}) };
        if (candidate.status === "unavailable")
            return { status: "unavailable", permission: null, reason: typeof candidate.reason === "string" ? candidate.reason : "permission_unavailable" };
    }
    return { status: "unavailable", permission: null, reason: "permission_not_observed" };
}
export function detectTrustedAuthorizerLocally({ issueContext, permissionObservation }) {
    const context = issueContext && typeof issueContext === "object" ? issueContext : null;
    const user = context?.user && typeof context.user === "object" ? context.user : null;
    const login = typeof user?.login === "string" && user.login ? user.login : null;
    const userType = typeof user?.type === "string" && user.type ? user.type : null;
    const authorAssociation = typeof context?.author_association === "string" ? context.author_association : null;
    const labels = Array.isArray(context?.labels) ? context.labels.filter((label) => typeof label === "string") : [];
    const permission = normalizePermissionObservation(permissionObservation);
    const bot = isBotUser(user);
    const positivePermission = permission.status === "observed" && isPermissionTrusted(permission.permission);
    const trusted = Boolean(login && !bot && positivePermission);
    const reason = !login
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
export function resolveTrustedAuthorizer({ repoFullName, issueNumber, issueContext }) {
    const observedIssueContext = issueContext === undefined ? (issueNumber ? fetchIssueAuthorContext(repoFullName, issueNumber) : null) : issueContext;
    const context = observedIssueContext && typeof observedIssueContext === "object" ? observedIssueContext : null;
    const username = context?.user?.login;
    const permissionObservation = typeof username === "string" && username.length && !isBotUser(context?.user)
        ? fetchUserRepoPermission(repoFullName, username)
        : { status: "unavailable", permission: null, reason: isBotUser(context?.user) ? "bot_principal" : "principal_missing" };
    return detectTrustedAuthorizerLocally({ issueContext: observedIssueContext, permissionObservation });
}
