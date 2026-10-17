import assert from "node:assert/strict";
import { strictCanonicalJson, loadCanonicalRequirements, semanticRequirementSubject, exactRepresentationSubject } from "../dist/runtime/canonical-requirements.mjs";
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
