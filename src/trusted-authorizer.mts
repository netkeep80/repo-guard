import { execFileSync } from "node:child_process";

interface UserProjection {
  login?: unknown;
  type?: unknown;
}

interface IssueContextProjection {
  user?: UserProjection | null;
  author_association?: unknown;
  labels?: unknown;
}

interface PullRequestContextProjection {
  labels?: unknown;
}

interface PermissionProjection {
  permission?: unknown;
  role_name?: unknown;
}

interface TrustedAuthorizerOptions {
  governanceApprovedLabel?: unknown;
  trustedTeamApproval?: unknown;
  codeownerApproved?: unknown;
}

interface LocalTrustedAuthorizerInput {
  issueContext?: unknown;
  prContext?: unknown;
  permission?: unknown;
  governanceApprovedLabel?: unknown;
  trustedTeamApproval?: unknown;
  codeownerApproved?: unknown;
}

interface ResolveTrustedAuthorizerInput {
  repoFullName: unknown;
  issueNumber?: unknown;
  prNumber?: unknown;
  options?: TrustedAuthorizerOptions;
}

export interface TrustedAuthorizerSummary {
  issue_author_permission_trusted: boolean;
  governance_approved_label: boolean;
  codeowner_approved: boolean;
  trusted_team_approval: boolean;
  issue_author_is_bot: boolean;
  detected_label: unknown | null;
  detected_author_login: unknown | null;
  detected_author_permission: unknown | null;
  detected_author_association: unknown | null;
}

const GITHUB_REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const TRUSTED_PERMISSIONS = new Set<string>(["admin", "maintain", "write"]);
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set<string>(["OWNER", "MEMBER", "COLLABORATOR"]);
const DEFAULT_GOVERNANCE_LABEL = "governance-approved";

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
    "{user: {login: .user.login, type: .user.type}, author_association: .author_association, labels: [.labels[].name]}",
  ]);
}

export function fetchPullRequestContext(repoFullName: unknown, prNumber: unknown): unknown | null {
  if (!isValidRepo(repoFullName) || !isValidIssueNumber(prNumber)) return null;
  return safeGhJson([
    "api",
    `repos/${repoFullName}/pulls/${prNumber as string | number | bigint}`,
    "--jq",
    "{labels: [.labels[].name]}",
  ]);
}

export function fetchUserRepoPermission(repoFullName: unknown, username: unknown): unknown | null {
  if (!isValidRepo(repoFullName)) return null;
  if (typeof username !== "string" || username.length === 0) return null;
  const encodedUsername = encodeURIComponent(username);
  const result = safeGhJson([
    "api",
    `repos/${repoFullName}/collaborators/${encodedUsername}/permission`,
    "--jq",
    "{permission, role_name}",
  ]) as PermissionProjection | null;
  if (!result) return null;
  return result.permission || null;
}

export function isPermissionTrusted(permission: unknown): boolean {
  if (typeof permission !== "string") return false;
  return TRUSTED_PERMISSIONS.has(permission);
}

export function isAuthorAssociationTrusted(authorAssociation: unknown): boolean {
  if (typeof authorAssociation !== "string") return false;
  return TRUSTED_AUTHOR_ASSOCIATIONS.has(authorAssociation);
}

export function isBotUser(user: unknown): boolean {
  if (!user || typeof user !== "object") return false;
  if ((user as UserProjection).type === "Bot") return true;
  if (typeof (user as UserProjection).login === "string" && /\[bot\]$/i.test((user as UserProjection).login as string)) return true;
  return false;
}

export function detectTrustedAuthorizerLocally({
  issueContext,
  prContext,
  permission,
  governanceApprovedLabel = DEFAULT_GOVERNANCE_LABEL,
  trustedTeamApproval = false,
  codeownerApproved = false,
}: LocalTrustedAuthorizerInput): TrustedAuthorizerSummary {
  const summary: TrustedAuthorizerSummary = {
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
    summary.detected_author_login = (issueContext as IssueContextProjection).user?.login || null;
    summary.detected_author_association = (issueContext as IssueContextProjection).author_association || null;
    summary.issue_author_is_bot = isBotUser((issueContext as IssueContextProjection).user);
    if (!summary.issue_author_is_bot) {
      if (isPermissionTrusted(permission)) {
        summary.issue_author_permission_trusted = true;
        summary.detected_author_permission = permission;
      } else if (isAuthorAssociationTrusted((issueContext as IssueContextProjection).author_association)) {
        summary.issue_author_permission_trusted = true;
        summary.detected_author_permission = (issueContext as IssueContextProjection).author_association;
      }
    }

    const labels = Array.isArray((issueContext as IssueContextProjection).labels) ? (issueContext as IssueContextProjection).labels as unknown[] : [];
    if (labels.includes(governanceApprovedLabel)) {
      summary.governance_approved_label = true;
      summary.detected_label = governanceApprovedLabel;
    }
  }

  if (prContext && typeof prContext === "object") {
    const labels = Array.isArray((prContext as PullRequestContextProjection).labels) ? (prContext as PullRequestContextProjection).labels as unknown[] : [];
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
}: ResolveTrustedAuthorizerInput): TrustedAuthorizerSummary {
  const governanceApprovedLabel = options.governanceApprovedLabel || DEFAULT_GOVERNANCE_LABEL;
  const issueContext = issueNumber ? fetchIssueAuthorContext(repoFullName, issueNumber) : null;
  const prContext = prNumber ? fetchPullRequestContext(repoFullName, prNumber) : null;
  const username = (issueContext as IssueContextProjection | null)?.user?.login;
  const permission = username && !isBotUser((issueContext as IssueContextProjection | null)?.user)
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
