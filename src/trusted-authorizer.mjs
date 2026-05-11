import { execFileSync } from "node:child_process";

const GITHUB_REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const TRUSTED_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const DEFAULT_GOVERNANCE_LABEL = "governance-approved";

function isValidRepo(repoFullName) {
  return typeof repoFullName === "string" && GITHUB_REPO_FULL_NAME.test(repoFullName);
}

function isValidIssueNumber(number) {
  return POSITIVE_INTEGER.test(String(number));
}

function safeGhJson(args) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf-8", timeout: 30000 });
    return out.trim() ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

export function fetchIssueAuthorContext(repoFullName, issueNumber) {
  if (!isValidRepo(repoFullName) || !isValidIssueNumber(issueNumber)) return null;
  return safeGhJson([
    "api",
    `repos/${repoFullName}/issues/${issueNumber}`,
    "--jq",
    "{user: {login: .user.login, type: .user.type}, author_association: .author_association, labels: [.labels[].name]}",
  ]);
}

export function fetchPullRequestContext(repoFullName, prNumber) {
  if (!isValidRepo(repoFullName) || !isValidIssueNumber(prNumber)) return null;
  return safeGhJson([
    "api",
    `repos/${repoFullName}/pulls/${prNumber}`,
    "--jq",
    "{labels: [.labels[].name]}",
  ]);
}

export function fetchUserRepoPermission(repoFullName, username) {
  if (!isValidRepo(repoFullName)) return null;
  if (typeof username !== "string" || username.length === 0) return null;
  const encodedUsername = encodeURIComponent(username);
  const result = safeGhJson([
    "api",
    `repos/${repoFullName}/collaborators/${encodedUsername}/permission`,
    "--jq",
    "{permission, role_name}",
  ]);
  if (!result) return null;
  return result.permission || null;
}

export function isPermissionTrusted(permission) {
  if (typeof permission !== "string") return false;
  return TRUSTED_PERMISSIONS.has(permission);
}

export function isAuthorAssociationTrusted(authorAssociation) {
  if (typeof authorAssociation !== "string") return false;
  return TRUSTED_AUTHOR_ASSOCIATIONS.has(authorAssociation);
}

export function isBotUser(user) {
  if (!user || typeof user !== "object") return false;
  if (user.type === "Bot") return true;
  if (typeof user.login === "string" && /\[bot\]$/i.test(user.login)) return true;
  return false;
}

export function detectTrustedAuthorizerLocally({
  issueContext,
  prContext,
  permission,
  governanceApprovedLabel = DEFAULT_GOVERNANCE_LABEL,
  trustedTeamApproval = false,
  codeownerApproved = false,
}) {
  const summary = {
    issue_author_permission_trusted: false,
    governance_approved_label: false,
    codeowner_approved: Boolean(codeownerApproved),
    trusted_team_approval: Boolean(trustedTeamApproval),
    issue_author_is_bot: false,
    detected_label: null,
    detected_author_login: null,
    detected_author_permission: null,
    detected_author_association: null,
  };

  if (issueContext && typeof issueContext === "object") {
    summary.detected_author_login = issueContext.user?.login || null;
    summary.detected_author_association = issueContext.author_association || null;
    summary.issue_author_is_bot = isBotUser(issueContext.user);
    if (!summary.issue_author_is_bot) {
      if (isPermissionTrusted(permission)) {
        summary.issue_author_permission_trusted = true;
        summary.detected_author_permission = permission;
      } else if (isAuthorAssociationTrusted(issueContext.author_association)) {
        summary.issue_author_permission_trusted = true;
        summary.detected_author_permission = issueContext.author_association;
      }
    }

    const labels = Array.isArray(issueContext.labels) ? issueContext.labels : [];
    if (labels.includes(governanceApprovedLabel)) {
      summary.governance_approved_label = true;
      summary.detected_label = governanceApprovedLabel;
    }
  }

  if (prContext && typeof prContext === "object") {
    const labels = Array.isArray(prContext.labels) ? prContext.labels : [];
    if (labels.includes(governanceApprovedLabel)) {
      summary.governance_approved_label = true;
      summary.detected_label = governanceApprovedLabel;
    }
  }

  return summary;
}

export function resolveTrustedAuthorizer({
  repoFullName,
  issueNumber,
  prNumber,
  options = {},
}) {
  const governanceApprovedLabel = options.governanceApprovedLabel || DEFAULT_GOVERNANCE_LABEL;
  const issueContext = issueNumber ? fetchIssueAuthorContext(repoFullName, issueNumber) : null;
  const prContext = prNumber ? fetchPullRequestContext(repoFullName, prNumber) : null;
  const username = issueContext?.user?.login;
  const permission = username && !isBotUser(issueContext.user)
    ? fetchUserRepoPermission(repoFullName, username)
    : null;

  // codeowner_approved / trusted_team_approval are accepted as trust sources by
  // the rule engine but are not yet auto-resolved from the GitHub API here.
  // They flow in only through caller-provided options for tests / future work.
  return detectTrustedAuthorizerLocally({
    issueContext,
    prContext,
    permission,
    governanceApprovedLabel,
    trustedTeamApproval: options.trustedTeamApproval,
    codeownerApproved: options.codeownerApproved,
  });
}
