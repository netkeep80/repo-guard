import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compareConstraintPrograms } from "../dist/checks/constraint-program.mjs";

const docsPolicy = (files = ["contracts/v0.1.json"], extra = {}) => ({
  integration: {
    docs: [{
      id: "readme-contract-governance",
      path: "README.md",
      must_reference_files: files,
      ...extra,
    }],
  },
});

describe("integration docs must_reference_files strictness", () => {
  it("treats must_reference_files adoption on an existing docs entry as stricter", () => {
    const base = docsPolicy(undefined);
    delete base.integration.docs[0].must_reference_files;
    const head = docsPolicy(["contracts/v0.1.json"]);

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "stricter");
    assert.deepEqual(comparison.relaxations, []);
    assert.deepEqual(comparison.incomparable, []);
  });

  it("treats adding a required file reference as stricter without root incomparable", () => {
    const base = docsPolicy(["contracts/v0.1.json"]);
    const head = docsPolicy(["contracts/v0.1.json", "contracts/v0.2.json"]);

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "stricter");
    assert.deepEqual(comparison.relaxations, []);
    assert.ok(comparison.incomparable.every((item) => item.pointer !== "/"));
  });

  it("treats removing a required file reference as an explicit relaxation", () => {
    const base = docsPolicy(["contracts/v0.1.json", "contracts/v0.2.json"]);
    const head = docsPolicy(["contracts/v0.1.json"]);

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "weaker");
    assert.ok(comparison.relaxations.some((item) =>
      item.kind === "integration_doc_required_file_removed"
      && item.pointer === "/integration/docs/readme-contract-governance/must_reference_files"
      && item.file === "contracts/v0.2.json"));
  });

  it("ignores must_reference_files ordering", () => {
    const base = docsPolicy(["contracts/v0.1.json", "contracts/v0.2.json"]);
    const head = docsPolicy(["contracts/v0.2.json", "contracts/v0.1.json"]);

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "equal");
    assert.deepEqual(comparison.relaxations, []);
    assert.deepEqual(comparison.incomparable, []);
  });

  it("keeps remove plus add weaker because a required reference was removed", () => {
    const base = docsPolicy(["contracts/v0.1.json", "contracts/v0.2.json"]);
    const head = docsPolicy(["contracts/v0.1.json", "contracts/v0.3.json"]);

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "weaker");
    assert.ok(comparison.relaxations.some((item) =>
      item.kind === "integration_doc_required_file_removed"
      && item.pointer === "/integration/docs/readme-contract-governance/must_reference_files"
      && item.file === "contracts/v0.2.json"));
  });

  it("treats removing the whole docs entry as an explicit relaxation", () => {
    const base = docsPolicy(["contracts/v0.1.json"]);
    const head = { integration: { docs: [] } };

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "weaker");
    assert.ok(comparison.relaxations.some((item) =>
      item.kind === "integration_doc_removed"
      && item.pointer === "/integration/docs/readme-contract-governance"));
  });

  it("keeps unknown sibling docs wiring changes incomparable", () => {
    const base = docsPolicy(["contracts/v0.1.json"], { selector: "README" });
    const head = docsPolicy(["contracts/v0.1.json"], { selector: "docs/README" });

    const comparison = compareConstraintPrograms(base, head);

    assert.equal(comparison.relation, "incomparable");
    assert.ok(comparison.incomparable.some((item) => item.pointer === "/"));
  });
});
