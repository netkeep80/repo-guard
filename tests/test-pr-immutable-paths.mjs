import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDiff } from "../dist/diff/parser.mjs";
import { readFact } from "../dist/document-facts.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";

const PROTECTED = "docs/research/Новое осмысление МТС.md";
const MOVED = "docs/research/Новое осмысление МТС — moved.md";

function policy(prImmutable = [PROTECTED]) {
  return {
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: [],
      operational_paths: [],
      ...(prImmutable === undefined ? {} : { pr_immutable: prImmutable }),
    },
    diff_rules: {},
    content_rules: [],
    cochange_rules: [],
  };
}

function file(path, status = "modified", previousPath = undefined) {
  return {
    path,
    status,
    addedLines: [],
    deletedLines: [],
    ...(previousPath ? { previousPath } : {}),
  };
}

function facts(files, { baseImmutable = [PROTECTED], headImmutable = [PROTECTED], governanceGrant = null } = {}) {
  const basePolicy = policy(baseImmutable);
  const headPolicy = policy(headImmutable);
  return {
    policy: basePolicy,
    basePolicy,
    headPolicy,
    baseRef: "base",
    headRef: "head",
    diff: { files: { checked: files } },
    changeIntent: null,
    governanceGrant,
    trustedAuthorizer: { issue_author_permission_trusted: true },
    readFileAtRef(ref, path) {
      if (path !== "repo-policy.json") return null;
      return JSON.stringify(ref === "base" ? basePolicy : headPolicy);
    },
  };
}

function resultNamed(results, name) {
  return results.find((result) => result.name === name)?.check;
}

function mutationCheck(files, options = {}) {
  return resultNamed(evaluateConstraintIR(facts(files, options), { executionPhase: "transaction" }), "pr-immutable-paths");
}

function policySetCheck(options = {}) {
  return resultNamed(evaluateConstraintIR(facts([file("repo-policy.json")], options), { executionPhase: "transaction" }), "pr-immutable-policy-set");
}

test("public schema exposes non-empty unique paths.pr_immutable", () => {
  const schema = JSON.parse(readFileSync("schemas/repo-policy.schema.json", "utf8"));
  const definition = schema.properties.paths.properties.pr_immutable;
  assert.ok(definition, "paths.pr_immutable must exist in the public policy schema");
  assert.equal(definition.type, "array");
  assert.equal(definition.minItems, 1);
  assert.equal(definition.uniqueItems, true);
});

test("Git rename facts retain the previous path identity", () => {
  const parsed = parseDiff([
    `diff --git a/${PROTECTED} b/${MOVED}`,
    "similarity index 100%",
    `rename from ${PROTECTED}`,
    `rename to ${MOVED}`,
    "",
  ].join("\n"));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, MOVED);
  assert.equal(parsed[0].previousPath, PROTECTED);
});

test("changed_paths can opt into previous rename identities without changing the default", () => {
  const changed = [file(MOVED, "modified", PROTECTED)];
  const baseSelector = {
    source: "diff",
    selector: { kind: "changed_paths", patterns: [PROTECTED] },
    type: "repository_path_set",
  };
  const previousSelector = {
    source: "diff",
    selector: { kind: "changed_paths", patterns: [PROTECTED], include_previous_paths: true },
    type: "repository_path_set",
  };
  assert.deepEqual(readFact({ diff: { files: { checked: changed } } }, baseSelector), { ok: true, value: [] });
  assert.deepEqual(readFact({ diff: { files: { checked: changed } } }, previousSelector), { ok: true, value: [PROTECTED] });
});

test("protected modifications and deletions are blocked with exact path diagnostics", () => {
  for (const status of ["modified", "deleted"]) {
    const check = mutationCheck([file(PROTECTED, status)]);
    assert.equal(check?.ok, false, `${status} must be blocked`);
    assert.match(check.message, /paths:pr-immutable:mutation/);
    assert.deepEqual(check.data.source_values, [PROTECTED]);
  }
});

test("rename away and rename into a protected path are both blocked", () => {
  const away = mutationCheck([file(MOVED, "modified", PROTECTED)]);
  assert.equal(away?.ok, false);
  assert.deepEqual(away.data.source_values, [PROTECTED]);

  const into = mutationCheck([file(PROTECTED, "modified", MOVED)]);
  assert.equal(into?.ok, false);
  assert.deepEqual(into.data.source_values, [PROTECTED]);
});

test("delete plus add replacement is blocked while unrelated changes pass", () => {
  const replacement = mutationCheck([file(PROTECTED, "deleted"), file(PROTECTED, "added")]);
  assert.equal(replacement?.ok, false);
  assert.deepEqual(replacement.data.source_values, [PROTECTED]);

  const unrelated = mutationCheck([file("docs/other.md")]);
  assert.equal(unrelated?.ok, true);
});

test("multiple immutable patterns produce deterministic sorted diagnostics", () => {
  const first = "docs/a.md";
  const second = "docs/b.md";
  const check = mutationCheck(
    [file(second), file(first)],
    { baseImmutable: [second, first], headImmutable: [second, first] },
  );
  assert.equal(check?.ok, false);
  assert.deepEqual(check.data.source_values, [first, second]);
});

test("BASE immutable set itself is frozen for PR transactions", () => {
  const changed = policySetCheck({ headImmutable: [PROTECTED, "docs/another.md"] });
  assert.equal(changed?.ok, false);
  assert.match(changed.message, /paths:pr-immutable:policy-set/);

  const removed = policySetCheck({ headImmutable: undefined });
  assert.equal(removed?.ok, false);
});

test("GovernanceGrant cannot bypass immutable path or immutable-set vetoes", () => {
  const governanceGrant = {
    authorized_governance_paths: ["repo-policy.json", PROTECTED],
    allow_policy_relaxation: ["/paths/pr_immutable"],
    allow_atomic_governance_cutover: true,
  };

  const mutation = mutationCheck([file(PROTECTED)], { governanceGrant });
  assert.equal(mutation?.ok, false);
  assert.deepEqual(mutation.data.source_values, [PROTECTED]);

  const setChange = policySetCheck({ headImmutable: [PROTECTED, "docs/another.md"], governanceGrant });
  assert.equal(setChange?.ok, false);
});
