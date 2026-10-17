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
 const resolver=createResourceResolver({repository,revision,requirements,readers:{
  [repository]:(sha,path)=>sha===revision && tracked.includes(path)?"snapshot:"+path:null
 }});
 return evaluateTrackedResourceClosure({requirements,j2,repository,revision,trackedPaths:tracked,resourceRelations:edges,resolver});
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

test("J1 shared Resource has stable multiple owning Requirements and canonical proof",()=>{
 const docs=[{id:"ROOT",relations:{
   p:{predicate:"requires",target:{kind:"artifact",path:"src/shared.ts"}}}},
  {id:"CHILD",relations:{
   derives:{predicate:"derives_from",target:{kind:"requirement",id:"ROOT"}},
   p:{predicate:"implemented_by",target:{kind:"artifact",path:"src/shared.ts"}}}}];
 const a=make(docs,["requirements/ROOT.json","requirements/CHILD.json","src/shared.ts"]);
 const b=make([...docs].reverse(),["src/shared.ts","requirements/CHILD.json","requirements/ROOT.json"]);
 assert.equal(a.ok,true);assert.deepEqual(a,b);
 assert.deepEqual(a.owners["src/shared.ts"],["CHILD","ROOT"]);
 assert.deepEqual(a.explanations["src/shared.ts"],["ROOT","requires:src/shared.ts"]);
});
test("J1 source moves follow exact I1 representations without neighboring directory exemptions",()=>{
 const docs=[{id:"ROOT",relations:{}}];
 const x=loadCanonicalRequirements({repository,revision,paths:["requirements/core/ROOT.json"],
  readFile:()=>JSON.stringify(docs[0])});
 const j2=evaluateRootedRequirements({requirements:x,trustedRoots:[x.index.ROOT.semantic]});
 const tracked=["requirements/core/ROOT.json","requirements/core/notes.txt"];
 const resolver=createResourceResolver({repository,revision,requirements:x,readers:{
  [repository]:(sha,path)=>sha===revision&&tracked.includes(path)?"tracked:"+path:null
 }});
 const result=evaluateTrackedResourceClosure({repository,revision,requirements:x,j2,trackedPaths:tracked,resolver});
 assert.deepEqual(result.justified,["requirements/core/ROOT.json"]);
 assert.deepEqual(result.unjustified,["requirements/core/notes.txt"]);
});
test("J1 missing resource target does not resolve a working-tree resource",()=>{
 const x=make([requirement("ROOT",["src/untracked.ts"])],["requirements/ROOT.json"]);
 assert.equal(x.ok,false);
 assert.ok(x.errors.some(e=>e.code==="missing_resource_target"&&e.target==="src/untracked.ts"));
});
test("J1 resource relations are bounded generates; unanchored arbitrary edges never create ownership",()=>{
 const docs=[requirement("ROOT",["src/source.ts"])];
 const tree=["requirements/ROOT.json","src/source.ts","gen/out.js"];
 const x=make(docs,tree,[{from:"src/source.ts",kind:"related_to",to:"gen/out.js"}]);
 assert.equal(x.ok,false);
 assert.deepEqual(x.unjustified,["gen/out.js"]);
 assert.ok(x.errors.some(e=>e.code==="unsupported_resource_relation"));
});
test("J1 independent exact reader rejects a revision substitution",()=>{
 const requirements=loadCanonicalRequirements({repository,revision,
  paths:["requirements/ROOT.json"],readFile:()=>JSON.stringify(requirement("ROOT",["src/a.ts"]))});
 const j2=evaluateRootedRequirements({requirements,trustedRoots:[requirements.index.ROOT.semantic]});
 const wrong=createResourceResolver({repository,revision,requirements,readers:{
  [repository]:()=>null
 }});
 const res=evaluateTrackedResourceClosure({repository,revision,requirements,j2,
  trackedPaths:["requirements/ROOT.json","src/a.ts"],resolver:wrong});
 assert.equal(res.ok,false);assert.ok(res.errors.some(e=>e.code==="missing_resource_target"));
});
test("J1-44 shadow negative candidate preserves legacy report",async()=>{
 const {runPolicyPipeline,runPolicyPipelineShadow}=await import("../dist/runtime/pipeline.mjs");
 const input={
  mode:"check-diff",repositoryRoot:"/tmp/i4-j1",repositoryIdentity:repository,
  policy:{policy_format_version:"0.3.0",repository_kind:"tooling",
   paths:{forbidden:[],governance_paths:[],canonical_docs:[],operational_paths:[]},
   diff_rules:{max_new_files:10,max_new_docs:10,max_net_added_lines:100},
   content_rules:[],cochange_rules:[]},
  changeIntent:null,changeIntentSource:"none",diffText:"",
  enforcement:{ok:true,mode:"blocking",source:"test",requested:"blocking"},
  trackedFiles:["requirements/ROOT.json","src/a.ts","src/orphan.ts"],
  readFile:()=>null,
  readFileAtRef:(_,path)=>path==="requirements/ROOT.json"?JSON.stringify(doc):"exact:"+path
 };
 const legacy=runPolicyPipeline(input,{quiet:true});
 const result=runPolicyPipelineShadow(input,{quiet:true},facts=>{
  const tracked=["requirements/ROOT.json","src/a.ts","src/orphan.ts"];
  const requirements=loadCanonicalRequirements({repository,revision,paths:["requirements/ROOT.json"],
   readFile:(sha,path)=>facts.readFileAtRef(sha,path)});
  const j2=evaluateRootedRequirements({requirements,trustedRoots:[requirements.index.ROOT.semantic]});
  const resolver=createResourceResolver({repository,revision,requirements,readers:{
   [repository]:(sha,path)=>tracked.includes(path)?facts.readFileAtRef(sha,path):null
  }});
  const j1=evaluateTrackedResourceClosure({repository,revision,requirements,j2,trackedPaths:tracked,resolver});
  return {ok:j1.ok,reasons:j1.unjustified.map(path=>"UNJUSTIFIED:"+path)};
 });
 assert.deepEqual(result.legacy,legacy);
 assert.equal(result.comparison.candidate.ok,false);
 assert.ok(result.comparison.candidate.reasons.includes("UNJUSTIFIED:src/orphan.ts"));
});
