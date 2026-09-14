import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as changeIntent from "../dist/change-intent.mjs";
import { detectTrustedAuthorizerLocally } from "../dist/trusted-authorizer.mjs";
import { checkGovernanceChangeAuthorization } from "../dist/checks/rules/governance-paths.mjs";

const trustedPermissions = new Set(["admin", "maintain", "write"]);
const permissions = ["admin", "maintain", "write", "read", "triage", "none", null];
const associations = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"];

function observation(permission) {
  return permission === null
    ? { status: "unavailable", permission: null, reason: "lookup_failed" }
    : { status: "observed", permission };
}

function authorizer(permission, association = "NONE", type = "User") {
  return detectTrustedAuthorizerLocally({
    issueContext: { user: { login: type === "Bot" ? "automation[bot]" : "alice", type }, author_association: association, labels: ["governance-approved"] },
    permissionObservation: observation(permission),
    codeownerApproved: true,
    trustedTeamApproval: true,
  });
}

describe("P0.2 positive repository permission authority", () => {
  it("trusts only positively observed admin/maintain/write permission for a human principal", () => {
    for (const permission of permissions) {
      for (const association of associations) {
        const evidence = authorizer(permission, association, "User");
        const expected = permission !== null && trustedPermissions.has(permission);
        assert.equal(evidence.trusted, expected, `${String(permission)} + ${association}`);
        assert.equal(evidence.source, "repository_permission");
        assert.equal(evidence.permission.permission, permission);
        assert.equal(evidence.permission.status, permission === null ? "unavailable" : "observed");
        assert.equal(evidence.principal.author_association, association);
      }
    }
  });

  it("never promotes weak or unavailable permission through association, labels, CODEOWNER, or team placeholders", () => {
    for (const permission of ["read", "triage", "none", null]) {
      const evidence = authorizer(permission, "OWNER", "User");
      assert.equal(evidence.trusted, false, `OWNER must not promote ${String(permission)}`);
      const check = checkGovernanceChangeAuthorization({
        files: [{ path: "repo-policy.json", status: "modified", addedLines: [], deletedLines: [] }],
        governancePaths: ["repo-policy.json"],
        governanceGrant: { authorized_governance_paths: ["repo-policy.json"] },
        trustedAuthorizer: evidence,
      });
      assert.equal(check.ok, false, `grant must remain blocked for ${String(permission)}`);
      assert.equal(check.untrusted_governance_grant_ignored, true);
    }
  });

  it("suppresses bots even when repository permission itself is strong", () => {
    const evidence = authorizer("admin", "OWNER", "Bot");
    assert.equal(evidence.trusted, false);
    assert.equal(evidence.principal.is_bot, true);
  });

  it("preserves repository identity in linked issue references", () => {
    assert.equal(typeof changeIntent.extractLinkedIssueReferences, "function");
    const refs = changeIntent.extractLinkedIssueReferences(
      "Fixes #5\nCloses netkeep80/repo-guard#6\nResolves another-owner/another-repo#7",
      "netkeep80/repo-guard",
    );
    assert.deepEqual(refs, [
      { repository: "netkeep80/repo-guard", number: 5 },
      { repository: "netkeep80/repo-guard", number: 6 },
      { repository: "another-owner/another-repo", number: 7 },
    ]);
  });
});
