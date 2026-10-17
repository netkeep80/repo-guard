import test from "node:test";
import assert from "node:assert/strict";
import {loadCanonicalRequirements} from "../dist/runtime/canonical-requirements.mjs";
import {evaluateRootedRequirements} from "../dist/runtime/requirement-closure.mjs";
import {createResourceResolver} from "../dist/runtime/resource-resolver.mjs";
import {evaluateTrackedResourceClosure} from "../dist/runtime/resource-closure.mjs";
const repository="netkeep80/repo-guard",revision="a".repeat(40);
const make=(docs,tracked,edges=[])=>{
 const requirements=loadCanonicalRequirements({repository,revision,paths:docs.map(x=>"requirements/"+x.id+".json"),
  readFile:(_,path)=>JSON.stringify(docs.find(x=>path==="requirements/"+x.id+".json"))});
 const root=requirements.index.ROOT?.semantic;
 const j2=evaluateRootedRequirements({requirements,trustedRoots:root?[root]:[]});
 return evaluateTrackedResourceClosure({requirements,j2,repository,revision,trackedPaths:tracked,resourceRelations:edges,
  resolveArtifact:(path)=>tracked.includes(path)});
};
const requirement=(id,targets=[])=>({id,relations:Object.fromEntries(targets.map((path,i)=>["edge"+i,{predicate:"requires",target:{kind:"artifact",path}}]))});
const doc=requirement("ROOT",["src/a.ts"]);
test("J1 TDD RED: full tracked tree rejects unknown orphan despite rooted Requirement",()=>{
 const x=make([doc],["requirements/ROOT.json","src/a.ts","src/orphan.ts"]);
 assert.equal(x.ok,false);assert.deepEqual(x.unjustified,["src/orphan.ts"]);
});
test("J1 direct kinds, canonical source, N:M and no acceptance flags",()=>{
 const x=make([{id:"ROOT",relations:{
  a:{predicate:"requires",target:{kind:"artifact",path:"src/a.ts"}},
  b:{predicate:"implemented_by",target:{kind:"artifact",path:"src/b.ts"}},
  c:{predicate:"verified_by",target:{kind:"artifact",path:"tests/t.mjs"}},
  d:{predicate:"documents",target:{kind:"artifact",path:"docs/d.md"}}}}],
  ["requirements/ROOT.json","src/a.ts","src/b.ts","tests/t.mjs","docs/d.md"]);
 assert.equal(x.ok,true);assert.equal(x.justified.length,5);
 for(const k of ["authorized","deletable","cause","accepted","current","domain_pass"])assert.equal(k in x,false);
});
test("J1 multi-hop generates, anchored cycle and disconnected cycle",()=>{
 const x=make([doc],["requirements/ROOT.json","src/a.ts","dist/b.js","dist/c.js","tmp/x","tmp/y"],
 [{from:"src/a.ts",kind:"generates",to:"dist/b.js"},{from:"dist/b.js",kind:"generates",to:"dist/c.js"},
 {from:"dist/c.js",kind:"generates",to:"src/a.ts"},
 {from:"tmp/x",kind:"generates",to:"tmp/y"},{from:"tmp/y",kind:"generates",to:"tmp/x"}]);
 assert.deepEqual(x.unjustified,["tmp/x","tmp/y"]);
 assert.deepEqual(x.explanations["dist/c.js"],["ROOT","requires:src/a.ts","generates:dist/b.js","generates:dist/c.js"]);
});
test("J1 dangling unsafe wildcard paths fail closed",()=>{
 for(const path of ["src/missing.ts","../bad.ts","**/*","src/"]) {
  const x=make([requirement("ROOT",[path])],["requirements/ROOT.json","src/a.ts"]);
  assert.equal(x.ok,false,path);
  assert.ok(x.errors.length>0,path);
 }
});
test("J1 source representation is exact, not directory exemption or candidate metadata",()=>{
 const a=make([{id:"ROOT",justified:true,infrastructure:true,retained:true}],
 ["requirements/ROOT.json","requirements/notes.txt",".github/workflows/ci.yml"]);
 assert.deepEqual(a.justified,["requirements/ROOT.json"]);
 assert.deepEqual(a.unjustified,[".github/workflows/ci.yml","requirements/notes.txt"]);
});
test("J1 invalid J2 cannot yield success",()=>{
 const docs=[{id:"ORPHAN",relations:{x:{predicate:"requires",target:{kind:"artifact",path:"src/a.ts"}}}}];
 const x=make(docs,["requirements/ORPHAN.json","src/a.ts"]);
 assert.equal(x.ok,false);assert.equal(x.errors[0].code,"j2_not_rooted");
});
