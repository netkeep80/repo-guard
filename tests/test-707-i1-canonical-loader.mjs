import assert from "node:assert/strict";
import { strictCanonicalJson, loadCanonicalRequirements, loadNativeRequirements, semanticRequirementSubject, exactRepresentationSubject } from "../dist/runtime/canonical-requirements.mjs";
import { runPolicyPipelineShadow } from "../dist/runtime/pipeline.mjs";
import { parseJson } from "../dist/document-facts.mjs";
import { test } from "node:test";
const sha = "a".repeat(40), repo = "netkeep80/repo-guard";
const item = (path, text) => [path, text];
const load = (files, extra = {}) => loadCanonicalRequirements({
  repository: repo, revision: sha, paths: files.map(x => x[0]),
  readFile: (revision, path) => { assert.equal(revision, sha); return files.find(x => x[0] === path)?.[1] ?? null; }, ...extra,
});
test("#704 RED: generic JSON last-key-wins must not extend to canonical Requirements", () => {
  assert.deepEqual(parseJson('{"id":"R1","id":"R2"}'), { id: "R2" });
  assert.throws(() => strictCanonicalJson('{"id":"R1","id":"R2"}'), /duplicate/i);
  assert.throws(() => strictCanonicalJson('{"id":"R1","x":{"a":1,"a":2}}'), /duplicate/i);
});
test("I1 F1-F4 F23-F25 canonical snapshot index and identity", () => {
  const good = load([item("requirements/R1.yaml","id: R1\nvalue: yes\n"), item("requirements/R2.json",'{"id":"R2","value":42}')]);
  assert.equal(good.ok,true);
  assert.deepEqual(good.requirements.map(x => x.id),["R1","R2"]);
  assert.equal(good.index.R1.source.path,"requirements/R1.yaml");
  assert.equal(load([item("requirements/irrelevant.json",'{"id":"R1"}'),item("requirements/R1.yaml","id: R1")]).ok,false);
  assert.equal(load([item("requirements/R1.json",'{"value":1}')]).ok,false);
  assert.equal(load([item("requirements/R1.json",'{"id":"R1"}'),item("requirements/R2.json",'{"id":"R1","value":2}')]).ok,false);
});
test("I1 F5-F8 unsafe parse fails closed without global parseJson change", () => {
  for (const raw of ['{"id":"R1","id":"R2"}','{"id":"R1","x":{"a":1,"a":2}}']) assert.equal(load([item("requirements/R1.json",raw)]).ok,false);
  for(const y of ["id: R1\nid: R2","id: R1\na: &v yes\nb: *v","id: R1\nx: !foo bar","id: R1\n<<: {x: 2}"]) assert.equal(load([item("requirements/R1.yaml",y)]).ok,false);
});
test("I1 F9-F15 canonical digest stable for representation edits, order; semantic mutation changes", () => {
  const a=load([item("requirements/R1.json",'{"id":"R1","x":{"a":1,"b":2}}')]);
  const b=load([item("requirements/renamed/R1.json",' { "x" : { "b" : 2, "a" : 1 }, "id" : "R1" } ')]);
  const c=load([item("requirements/R1.json",'{"id":"R1","x":{"a":2,"b":2}}')]);
  assert.equal(a.ok,true); assert.equal(b.ok,true); assert.equal(c.ok,true);
  assert.deepEqual(a.index.R1.semantic,b.index.R1.semantic);
  assert.notDeepEqual(a.index.R1.source,b.index.R1.source);
  assert.notDeepEqual(a.index.R1.representation,b.index.R1.representation);
  assert.notEqual(a.index.R1.semantic.digest,c.index.R1.semantic.digest);
  assert.deepEqual(load([item("requirements/B.json",'{"id":"B"}'),item("requirements/A.json",'{"id":"A"}')]).requirements.map(x=>x.id),["A","B"]);
});
test("I1 F16-F19 F27-F28 paths, exact revision, pointer errors deterministic", () => {
  for(const path of ["../R.json","/tmp/R.json","C:/R.json","requirements\\R.json","https:evil.json","requirements/../R.json"]) assert.equal(load([item(path,'{"id":"R1"}')]).ok,false,path);
  assert.equal(load([item("requirements/R1.json",'{"id":"R1"}')],{revision:"main"}).ok,false);
  const a=load([item("requirements/R1.json",'{"id":"R1"}'),item("requirements/R2.json",'{"id":"R1"}')]);
  const b=load([item("requirements/R2.json",'{"id":"R1"}'),item("requirements/R1.json",'{"id":"R1"}')]);
  assert.deepEqual(a.errors,b.errors);
  const x=load([item("requirements/R1.json",'{"id":"R1","statement":{"v":3}}')]);
  assert.equal(x.resolveFragment("R1","/statement/missing").ok,false);
  assert.equal(x.resolveFragment("R1","/statement/~2").ok,false);
});
test("I1 F20-F22 F26 identity subject classes are authority-neutral", () => {
  const r=load([item("requirements/R1.json",'{"id":"R1","trusted":true,"statement":{"a":1},"relations":[{"key":"K"}]}')]);
  assert.equal(r.ok,true);
  const s=r.index.R1.semantic, e=r.index.R1.representation;
  assert.equal(s.kind,"semantic_requirement");
  assert.equal(e.kind,"exact_representation");
  assert.equal("trusted" in e,false); assert.equal("trusted" in s,false);
  assert.notDeepEqual(s,e);
  assert.equal(r.resolveFragment("R1","/relations/0",{durable:true}).ok,false);
  assert.equal(r.resolveFragment("R1","/statement/a",{durable:true}).ok,true);
  assert.throws(()=>exactRepresentationSubject(repo,"main","requirements/R1.json"),/revision/i);
  assert.equal(semanticRequirementSubject(repo,"R1",s.digest).kind,"semantic_requirement");
});

test("I1 F21 stable keyed fragment identity survives unrelated sibling insertion", () => {
  const before = load([item("requirements/R1.json",'{"id":"R1","relations":{"verified":{"id":"V1"}}}')]);
  const after = load([item("requirements/R1.json",'{"id":"R1","relations":{"other":{"id":"V0"},"verified":{"id":"V1"}}}')]);
  const first = before.resolveFragment("R1", "/relations/verified", { durable: true });
  const second = after.resolveFragment("R1", "/relations/verified", { durable: true });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.value, second.value);
  assert.equal(first.identity.pointer, second.identity.pointer);
});

test("I1 uses I0 shadow on existing normalized facts without altering v3 blocking report", async () => {
  const input = {
    mode: "check-diff", repositoryRoot: "/tmp/rg-i1-snapshot", repositoryIdentity: repo,
    policy: {
      policy_format_version: "0.3.0", repository_kind: "tooling",
      paths: { forbidden: [], governance_paths: [], canonical_docs: [], operational_paths: [] },
      diff_rules: { max_new_files: 8, max_new_docs: 8, max_net_added_lines: 100 },
      content_rules: [], cochange_rules: [],
    },
    changeIntent: null, changeIntentSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText: "", trackedFiles: ["requirements/R1.json"],
    readFile: () => '{"id":"R1"}',
    readFileAtRef: (revision, path) => revision === sha && path === "requirements/R1.json" ? '{"id":"R1"}' : null,
  };
  const { runPolicyPipeline } = await import("../dist/runtime/pipeline.mjs");
  const baseline = runPolicyPipeline(input, { quiet: true });
  const shadow = runPolicyPipelineShadow(input, { quiet: true }, (facts) => {
    const result = loadCanonicalRequirements({
      repository: facts.repositoryIdentity,
      revision: sha,
      paths: facts.trackedFiles,
      readFile: (revision, path) => facts.readFileAtRef(revision, path),
    });
    return { ok: result.ok, reasons: result.errors.map(e => e.code) };
  });
  assert.deepEqual(shadow.legacy, baseline);
  assert.equal(shadow.comparison.candidate.ok, true);
  assert.equal(shadow.comparison.classification, baseline.ok ? "EQUIVALENT" : "UNEXPECTED_DIFFERENCE");
  const malformed = runPolicyPipelineShadow(input, { quiet: true }, (facts) => {
    const result = loadCanonicalRequirements({
      repository: facts.repositoryIdentity, revision: sha, paths: facts.trackedFiles,
      readFile: () => '{"id":"R1","id":"R2"}',
    });
    return { ok: result.ok, reasons: result.errors.map(e => e.code) };
  });
  assert.deepEqual(malformed.legacy, baseline);
  assert.equal(malformed.comparison.candidate.ok, false);
  assert.ok(malformed.comparison.candidate.reasons.includes("duplicate_json_key"));
});

test("I1 semantic canonicalizer rejects non-finite or host-only values before SHA256", () => {
  assert.equal(load([item("requirements/R1.json",'{"id":"R1","overflow":1e999}')]).ok, false);
  assert.equal(load([item("requirements/R1.yaml","id: R1\nvalue: .nan\n")]).ok, false);
});


const nativeLoad = (files, extra = {}) => loadNativeRequirements({
  repository: repo, revision: sha, paths: files.map(x => x[0]),
  readFile: (revision, path) => { assert.equal(revision, sha); return files.find(x => x[0] === path)?.[1] ?? null; },
  ...extra,
});

const nativeYaml = ({
  id = "R1",
  normative = "Keep behavior stable.",
  lifecycle = "",
  relations = "",
  constraints = "",
} = {}) => [
  "format: repo-guard/requirement-v1",
  "id: " + id,
  "normative: " + JSON.stringify(normative),
  lifecycle,
  relations,
  constraints,
  "",
].filter(Boolean).join("\n");

test("C2.1 N01-N04 discovers only .rg.yaml/.rg.json and keeps semantic identity independent of source/codec", () => {
  const yaml = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml())]);
  const json = nativeLoad([item("requirements/moved/R1.rg.json", JSON.stringify({
    constraints: [],
    relations: [],
    lifecycle: { published: false, current: false, accepted: false },
    normative: "Keep behavior stable.",
    id: "R1",
    format: "repo-guard/requirement-v1",
  }))]);
  assert.equal(yaml.ok, true);
  assert.equal(json.ok, true);
  assert.deepEqual(yaml.index.R1.semantic, json.index.R1.semantic);
  assert.notDeepEqual(yaml.index.R1.representation, json.index.R1.representation);

  const ignored = nativeLoad([
    item("requirements/legacy.yaml", "id: LEGACY\n"),
    item("requirements/R1.rg.yaml", nativeYaml()),
  ]);
  assert.deepEqual(ignored.requirements.map(x => x.id), ["R1"]);
});

test("C2.1 N05 normative-only digest ignores relation/constraint/lifecycle edits but changes on normative mutation", () => {
  const base = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml())]);
  const metadata = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    lifecycle: "lifecycle:\n  accepted: true\n  current: false\n  published: false",
    relations: "relations:\n  - predicates: [implemented_by]\n    target: { kind: artifact, path: src/a.mts }",
    constraints: "constraints:\n  - id: lines\n    scope: { relations: [implemented_by], include_generated: false }\n    metric: { key: git.changed_lines, max: 10 }",
  }))]);
  const changed = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({ normative: "Different normative meaning." }))]);
  assert.equal(base.ok, true);
  assert.equal(metadata.ok, true);
  assert.equal(changed.ok, true);
  assert.equal(base.index.R1.semantic.digest, metadata.index.R1.semantic.digest);
  assert.notEqual(base.index.R1.semantic.digest, changed.index.R1.semantic.digest);
});

test("C2.1 N06-N10 strict native source fails closed on duplicate keys/IDs, unknown fields and unknown predicates", () => {
  assert.equal(nativeLoad([item("requirements/R1.rg.json",
    '{"format":"repo-guard/requirement-v1","id":"R1","normative":"a","normative":"b"}')]).ok, false);
  assert.equal(nativeLoad([
    item("requirements/a.rg.yaml", nativeYaml({ id: "R1" })),
    item("requirements/b.rg.yaml", nativeYaml({ id: "R1" })),
  ]).ok, false);
  assert.equal(nativeLoad([item("requirements/R1.rg.yaml",
    nativeYaml() + "trusted: true\n")]).ok, false);
  const unknown = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    relations: "relations:\n  - predicates: [protects]\n    target: { kind: artifact, path: src/a.mts }",
  }))]);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(e => e.code === "unknown_predicate"));
});

test("C2.1 N11 grouped relations normalize to sorted primitive facts and duplicate primitive facts are RED", () => {
  const good = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    relations: [
      "relations:",
      "  - predicates: [verified_by, implemented_by]",
      "    target: { kind: artifact, path: src/a.mts }",
      "  - source: { kind: artifact, path: src/a.mts }",
      "    predicates: [generates]",
      "    target: { kind: artifact, path: dist/a.mjs }",
    ].join("\n"),
  }))]);
  assert.equal(good.ok, true);
  assert.deepEqual(good.index.R1.relations.map(r => r.predicate), ["generates", "implemented_by", "verified_by"]);

  const duplicate = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    relations: [
      "relations:",
      "  - predicates: [implemented_by]",
      "    target: { kind: artifact, path: src/a.mts }",
      "  - predicates: [implemented_by]",
      "    target: { kind: artifact, path: src/a.mts }",
    ].join("\n"),
  }))]);
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some(e => e.code === "duplicate_relation"));
});

test("C2.1 N12-N15 ResourceRef and relation domains are exact and authority-neutral", () => {
  const floating = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    relations: [
      "relations:",
      "  - predicates: [documents]",
      "    target:",
      "      kind: external_document",
      "      repository: netkeep80/anum_docs",
      "      revision: main",
      "      path: requirements/mts-v0.15.json",
    ].join("\n"),
  }))]);
  assert.equal(floating.ok, false);

  const positional = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    relations: [
      "relations:",
      "  - predicates: [documents]",
      "    target: { kind: document, path: docs/a.json, pointer: /items/0 }",
    ].join("\n"),
  }))]);
  assert.equal(positional.ok, false);

  const badGenerate = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    relations: [
      "relations:",
      "  - predicates: [generates]",
      "    target: { kind: artifact, path: dist/a.mjs }",
    ].join("\n"),
  }))]);
  assert.equal(badGenerate.ok, false);

  const trust = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    relations: [
      "relations:",
      "  - predicates: [implemented_by]",
      "    target: { kind: artifact, path: src/a.mts, trusted: true }",
    ].join("\n"),
  }))]);
  assert.equal(trust.ok, false);
});

test("C2.1 N16-N20 constraints normalize exact lifecycle/scope/activation/evidence without provider trust", () => {
  const good = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    lifecycle: "lifecycle:\n  accepted: true\n  current: false\n  published: false",
    relations: [
      "relations:",
      "  - predicates: [implemented_by]",
      "    target: { kind: artifact, path: src/a.mts }",
      "  - predicates: [constrains]",
      "    target: { kind: artifact, path: src/ui.mts }",
    ].join("\n"),
    constraints: [
      "constraints:",
      "  - id: changed-lines",
      "    activation: scoped_change",
      "    scope: { relations: [implemented_by], include_generated: true }",
      "    metric: { key: git.changed_lines, max: 800 }",
      "  - id: no-ui",
      "    activation: requirement_cause",
      "    scope: { relations: [constrains], include_generated: false }",
      "    metric: { key: git.changed_resources, max: 0 }",
      "  - id: verified",
      "    scope: { relations: [implemented_by], include_generated: false }",
      "    evidence:",
      "      class: execution",
      "      key: tests:implementation",
      "      verifier: { kind: artifact, path: tests/a.test.mjs }",
    ].join("\n"),
  }))]);
  assert.equal(good.ok, true);
  assert.deepEqual(good.index.R1.lifecycle, { accepted: true, current: false, published: false });
  assert.deepEqual(good.index.R1.constraints.map(x => x.id), ["changed-lines", "no-ui", "verified"]);
  assert.equal(JSON.stringify(good.index.R1.constraints).includes("providerId"), false);

  const duplicateConstraint = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    constraints: [
      "constraints:",
      "  - id: x",
      "    scope: { relations: [implemented_by] }",
      "    metric: { key: git.changed_lines, max: 1 }",
      "  - id: x",
      "    scope: { relations: [implemented_by] }",
      "    metric: { key: git.changed_lines, max: 2 }",
    ].join("\n"),
  }))]);
  assert.equal(duplicateConstraint.ok, false);

  const providerInProject = nativeLoad([item("requirements/R1.rg.yaml", nativeYaml({
    constraints: [
      "constraints:",
      "  - id: verify",
      "    scope: { relations: [implemented_by] }",
      "    evidence: { class: domain, key: domain:x, providerId: trusted-ci }",
    ].join("\n"),
  }))]);
  assert.equal(providerInProject.ok, false);
});
