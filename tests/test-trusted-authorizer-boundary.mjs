import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectTrustedAuthorizerLocally,
  isBotUser,
  isPermissionTrusted,
} from "../dist/trusted-authorizer.mjs";

describe("trusted authorizer boundary", () => {
  it("trusts positively observed write authority for a human but suppresses bots", () => {
    const human = detectTrustedAuthorizerLocally({
      issueContext: { user: { login: "maintainer", type: "User" }, author_association: "CONTRIBUTOR", labels: [] },
      permissionObservation: { status: "observed", permission: "write" },
    });
    assert.equal(human.trusted, true);
    assert.equal(human.source, "repository_permission");
    assert.equal(human.reason, "trusted_permission");
    assert.equal(human.principal.login, "maintainer");
    assert.equal(human.principal.is_bot, false);
    assert.equal(human.permission.permission, "write");

    const bot = detectTrustedAuthorizerLocally({
      issueContext: { user: { login: "automation[bot]", type: "Bot" }, author_association: "OWNER", labels: [] },
      permissionObservation: { status: "observed", permission: "admin" },
    });
    assert.equal(bot.trusted, false);
    assert.equal(bot.reason, "bot_principal");
    assert.equal(bot.principal.is_bot, true);
  });

  it("keeps association and labels as provenance without promoting unavailable permission", () => {
    const evidence = detectTrustedAuthorizerLocally({
      issueContext: { user: { login: "owner", type: "User" }, author_association: "OWNER", labels: ["governance-approved"] },
      permissionObservation: { status: "unavailable", permission: null, reason: "lookup_failed" },
    });
    assert.equal(evidence.trusted, false);
    assert.equal(evidence.reason, "permission_unavailable");
    assert.equal(evidence.principal.author_association, "OWNER");
    assert.deepEqual(evidence.observed_labels, ["governance-approved"]);
    assert.equal(evidence.permission.status, "unavailable");
  });

  it("fails closed for malformed primitive trust inputs", () => {
    assert.equal(isPermissionTrusted("write"), true);
    assert.equal(isPermissionTrusted("read"), false);
    assert.equal(isPermissionTrusted(42), false);
    assert.equal(isBotUser("dependabot[bot]"), false);
    assert.equal(isBotUser({ login: "dependabot[bot]" }), true);
  });
});
