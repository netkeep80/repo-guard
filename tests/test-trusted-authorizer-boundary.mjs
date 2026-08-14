import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectTrustedAuthorizerLocally,
  isAuthorAssociationTrusted,
  isBotUser,
  isPermissionTrusted,
} from "../dist/trusted-authorizer.mjs";

describe("trusted authorizer boundary", () => {
  it("trusts declared write authority for a human but suppresses bots", () => {
    const human = detectTrustedAuthorizerLocally({
      issueContext: { user: { login: "maintainer", type: "User" }, author_association: "CONTRIBUTOR", labels: [] },
      permission: "write",
    });
    assert.equal(human.issue_author_permission_trusted, true);
    assert.equal(human.issue_author_is_bot, false);
    assert.equal(human.detected_author_permission, "write");

    const bot = detectTrustedAuthorizerLocally({
      issueContext: { user: { login: "automation[bot]", type: "Bot" }, author_association: "OWNER", labels: [] },
      permission: "admin",
    });
    assert.equal(bot.issue_author_is_bot, true);
    assert.equal(bot.issue_author_permission_trusted, false);
    assert.equal(bot.detected_author_permission, null);
  });

  it("keeps association and governance-label trust sources unchanged", () => {
    const issue = detectTrustedAuthorizerLocally({
      issueContext: { user: { login: "owner", type: "User" }, author_association: "OWNER", labels: ["governance-approved"] },
      permission: null,
    });
    assert.equal(issue.issue_author_permission_trusted, true);
    assert.equal(issue.detected_author_permission, "OWNER");
    assert.equal(issue.governance_approved_label, true);
    assert.equal(issue.detected_label, "governance-approved");

    const pr = detectTrustedAuthorizerLocally({
      issueContext: null,
      prContext: { labels: ["governance-approved"] },
    });
    assert.equal(pr.governance_approved_label, true);
    assert.equal(pr.detected_label, "governance-approved");
  });

  it("fails closed for malformed primitive trust inputs", () => {
    assert.equal(isPermissionTrusted("write"), true);
    assert.equal(isPermissionTrusted(42), false);
    assert.equal(isAuthorAssociationTrusted("OWNER"), true);
    assert.equal(isAuthorAssociationTrusted({}), false);
    assert.equal(isBotUser("dependabot[bot]"), false);
    assert.equal(isBotUser({ login: "dependabot[bot]" }), true);
  });
});
