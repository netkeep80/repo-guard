import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractChangeIntent, extractGovernanceGrant, extractLinkedIssueNumbers, resolveChangeIntent } from "../src/change-intent.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const intent = (type = "bugfix") => `\`\`\`repo-guard-yaml
change_type: ${type}
scope: ["src/**"]
budgets: {}
anchors: { affects: [], implements: [], verifies: [] }
must_touch: ["src/**"]
must_not_touch: []
expected_effects: ["effect"]
\`\`\``;
const jsonIntent = `\`\`\`repo-guard-json
{"change_type":"bugfix","scope":["src/**"],"budgets":{},"must_touch":[],"must_not_touch":[],"expected_effects":[]}
\`\`\``;
const grant = `\`\`\`repo-guard-grant
authorized_governance_paths:
  - schemas/**
allow_policy_relaxation:
  - /size_rules/source/max
\`\`\``;

describe("ChangeIntent extraction", () => {
  it("supports YAML and JSON", () => {
    assert.equal(extractChangeIntent(intent()).changeIntent.change_type, "bugfix");
    assert.equal(extractChangeIntent(jsonIntent).changeIntent.change_type, "bugfix");
  });
  it("keeps repository templates self-hosted", () => {
    assert.equal(extractChangeIntent(readFileSync(resolve(root, ".github/PULL_REQUEST_TEMPLATE.md"), "utf-8")).ok, true);
    assert.equal(extractChangeIntent(readFileSync(resolve(root, ".github/ISSUE_TEMPLATE/change-contract.yml"), "utf-8")).ok, true);
  });
  it("rejects missing, malformed and multiple ChangeIntents", () => {
    assert.equal(extractChangeIntent("text").error, "change_intent_not_found");
    assert.equal(extractChangeIntent("```repo-guard-json\n{bad\n```").error, "change_intent_malformed_json");
    assert.equal(extractChangeIntent(`${intent()}\n${intent("feature")}`).error, "multiple_change_intents");
  });
  it("falls back to linked issue but never over malformed PR intent", () => {
    assert.equal(resolveChangeIntent("text", intent("feature")).changeIntent.change_type, "feature");
    assert.equal(resolveChangeIntent(intent(), intent("feature")).changeIntent.change_type, "bugfix");
    assert.equal(resolveChangeIntent("```repo-guard-json\n{bad\n```", intent()).error, "change_intent_malformed_json");
  });
});

describe("GovernanceGrant extraction", () => {
  it("is an independent linked-issue block", () => {
    const result = extractGovernanceGrant(`${intent("governance")}\n${grant}`);
    assert.equal(result.ok, true);
    assert.deepEqual(result.grant.authorized_governance_paths, ["schemas/**"]);
    assert.deepEqual(result.grant.allow_policy_relaxation, ["/size_rules/source/max"]);
  });
  it("is absent rather than inferred from ChangeIntent", () => assert.equal(extractGovernanceGrant(intent("governance")).grant, null));
  it("rejects multiple or malformed grants", () => {
    assert.equal(extractGovernanceGrant(`${grant}\n${grant}`).error, "multiple_governance_grants");
    assert.match(extractGovernanceGrant("```repo-guard-grant\n[bad\n```").error, /grant_malformed/);
  });
});

describe("linked issue references", () => {
  assert.deepEqual(extractLinkedIssueNumbers("Fixes #5\nCloses #5\nResolves owner/repo#7"), [5, 7]);
  assert.deepEqual(extractLinkedIssueNumbers("normal text"), []);
});
