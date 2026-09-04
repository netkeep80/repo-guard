import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import Ajv from "ajv";
import { compileConstraintProgram, compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";

const transitionRule = {
  id: "release-revision",
  kind: "scalar_strictly_greater",
  comparator: "semver",
  left: { document: "head-revision", pointer: "", type: "string" },
  right: { document: "base-revision", pointer: "", type: "string" },
};

const basePolicy = () => ({
  paths: { forbidden: [], canonical_docs: [], governance_paths: ["repo-policy.json"], operational_paths: [] },
  diff_rules: { max_new_docs: 2, max_new_files: 5 },
  document_relations: {
    documents: {
      "base-revision": { path: "meta/REVISION", format: "plain_text", snapshot: "base" },
      "head-revision": { path: "meta/REVISION", format: "plain_text", snapshot: "head" },
    },
    rules: [structuredClone(transitionRule)],
  },
});

function facts(baseValue, headValue, { missingBase = false, missingHead = false } = {}) {
  return {
    repositoryRoot: process.cwd(),
    baseRef: "BASE",
    headRef: "HEAD",
    readFileAtRef: (ref, path) => {
      assert.equal(path, "meta/REVISION");
      if (ref === "BASE") {
        if (missingBase) throw new Error("missing BASE file");
        return baseValue;
      }
      if (ref === "HEAD") {
        if (missingHead) throw new Error("missing HEAD file");
        return headValue;
      }
      throw new Error(`unexpected ref ${ref}`);
    },
    policy: basePolicy(),
    changeIntent: null,
    diff: {
      files: {
        checked: [{ path: "src/unrelated.mjs", status: "modified", addedLines: ["x"], deletedLines: ["y"] }],
      },
    },
  };
}

function transitionCheck(baseValue, headValue, options) {
  const entries = evaluateConstraintIR(facts(baseValue, headValue, options), { executionPhase: "transaction" });
  return entries.find((entry) => entry.name === "document-relation:release-revision")?.check;
}

describe("snapshot-aware ordered document relations", () => {
  it("compiles into the existing document-relation Constraint Program path", () => {
    const entry = compileConstraintProgram(basePolicy()).find((item) => item.key === "document-relation:release-revision");
    assert.equal(entry?.runtime?.kind, "document_scalar_strictly_greater");
  });

  for (const [from, to] of [["1.2.3\n", "1.2.4\n"], ["1.2.3", "1.3.0"]]) {
    it(`${from.trim()} -> ${to.trim()} passes`, () => {
      const check = transitionCheck(from, to);
      assert.equal(check?.ok, true);
      assert.equal(check?.base_value, from.trim());
      assert.equal(check?.head_value, to.trim());
      assert.equal(check?.expected_relation, "strictly_greater");
    });
  }

  for (const [label, from, to] of [
    ["equality", "1.2.3", "1.2.3"],
    ["downgrade", "1.2.3", "1.2.2"],
    ["malformed HEAD", "1.2.3", "not-a-version"],
  ]) {
    it(`${label} fails closed with BASE/HEAD diagnostics`, () => {
      const check = transitionCheck(from, to);
      assert.equal(check?.ok, false);
      assert.equal(check?.rule_id, "release-revision");
      assert.equal(check?.path, "meta/REVISION");
      assert.equal(check?.base_value, from);
      assert.equal(check?.head_value, to);
      assert.equal(check?.expected_relation, "strictly_greater");
    });
  }

  it("missing HEAD fails closed", () => {
    const check = transitionCheck("1.2.3", null, { missingHead: true });
    assert.equal(check?.ok, false);
    assert.equal(check?.path, "meta/REVISION");
    assert.match(check?.message || "", /HEAD/i);
  });

  it("malformed trusted BASE fails closed", () => {
    const check = transitionCheck("broken", "1.2.4");
    assert.equal(check?.ok, false);
    assert.equal(check?.base_value, "broken");
    assert.match(check?.message || "", /BASE/i);
  });

  it("unrelated repository change still requires the ordered relation", () => {
    const check = transitionCheck("2.0.0", "2.0.0");
    assert.equal(check?.ok, false);
  });

  it("is transaction-only rather than a state-only invariant", () => {
    const entries = evaluateConstraintIR(facts("1.0.0", "1.0.1"), { executionPhase: "state" });
    assert.equal(entries.some((entry) => entry.name === "document-relation:release-revision"), false);
  });
});

describe("ordered document relation policy-delta semantics", () => {
  it("adding the relation is tightening", () => {
    const before = basePolicy();
    before.document_relations.rules = [];
    assert.equal(compareConstraintPrograms(before, basePolicy()).relation, "stricter");
  });

  it("removing the relation is a relaxation", () => {
    const after = basePolicy();
    after.document_relations.rules = [];
    const result = compareConstraintPrograms(basePolicy(), after);
    assert.equal(result.relation, "weaker");
    assert.ok(result.relaxations.some((item) => item.kind === "document_relation_removed" && item.rule_id === "release-revision"));
  });

  for (const field of ["path", "format", "snapshot", "comparator"]) {
    it(`changing ${field} is incomparable through existing relation identity`, () => {
      const after = basePolicy();
      if (field === "path") after.document_relations.documents["head-revision"].path = "meta/OTHER";
      if (field === "format") after.document_relations.documents["head-revision"].format = "json";
      if (field === "snapshot") after.document_relations.documents["head-revision"].snapshot = "base";
      if (field === "comparator") after.document_relations.rules[0].comparator = "numeric_tuple";
      const result = compareConstraintPrograms(basePolicy(), after);
      assert.equal(result.relation, "incomparable");
      assert.ok(result.incomparable.some((item) => item.pointer === "/document_relations/rules/release-revision"));
    });
  }
});

describe("ordered document relation schema", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/repo-policy.schema.json", import.meta.url), "utf-8"));
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const schemaPolicy = () => ({
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    ...basePolicy(),
    content_rules: [],
    cochange_rules: [],
  });

  it("accepts snapshot plain-text documents with semver ordering", () => {
    assert.equal(validate(schemaPolicy()), true, JSON.stringify(validate.errors));
  });

  it("rejects unsupported comparators fail-closed", () => {
    const policy = schemaPolicy();
    policy.document_relations.rules[0].comparator = "numeric_tuple";
    assert.equal(validate(policy), false);
  });
});
