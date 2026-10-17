import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";

const A="a".repeat(40), B="b".repeat(40);
const repo="netkeep80/repo-guard", external="netkeep80/anum_docs";
const data=new Map([
  [repo+"@"+A+"/requirements/R1.json",'{"id":"R1","relations":{"one":{"id":"V1"}}}'],
  [repo+"@"+A+"/src/a.mts","export const a=1"],
  [repo+"@"+A+"/docs/d.json",'{"id":"D","relations":{"one":{"id":"V1"}}}'],
  [external+"@"+A+"/docs/x.json",'{"id":"X","value":1}'],
  [external+"@"+B+"/docs/x.json",'{"id":"X","value":2}'],
]);
const readers={
  [repo]:(revision,path)=>data.get(repo+"@"+revision+"/"+path)??null,
  [external]:(revision,path)=>data.get(external+"@"+revision+"/"+path)??null,
};
const index=loadCanonicalRequirements({repository:repo,revision:A,paths:["requirements/R1.json"],readFile:readers[repo]});
const build=(overrides={})=>createResourceResolver({repository:repo,revision:A,requirements:index,readers,...overrides});
const ok=(r,ref,opts)=>{const x=r.resolve(ref,opts);assert.equal(x.ok,true,JSON.stringify(x));return x.value};
const red=(r,ref,opts)=>{const x=r.resolve(ref,opts);assert.equal(x.ok,false,JSON.stringify(x));return x.error.code};
test("I2 RED: four-variant production resolver must exist",()=>assert.equal(typeof createResourceResolver,"function"));
test("R1-R4 RequirementRef uses I1 ID index not filename",()=>{
  const r=build(),a=ok(r,{kind:"requirement",id:"R1"});
  assert.equal(a.semantic.requirementId,"R1");
  assert.equal(red(r,{kind:"requirement",id:"MISSING"}),"unknown_requirement");
  const move=loadCanonicalRequirements({repository:repo,revision:A,paths:["requirements/renamed.json"],readFile:(_,p)=>p==="requirements/renamed.json"?data.get(repo+"@"+A+"/requirements/R1.json"):null});
  assert.deepEqual(ok(build({requirements:move}),{kind:"requirement",id:"R1"}).semantic,a.semantic);
});
test("R5-R11 artifact and local document use exact snapshot with safe path and strict pointer",()=>{
 const r=build();
 assert.equal(ok(r,{kind:"artifact",path:"src/a.mts"}).representation.revision,A);
 assert.equal(red(r,{kind:"artifact",path:"src/missing.mts"}),"missing_path");
 for(const p of ["../a","/tmp/a","C:/evil","src\\x","https:a"])assert.equal(red(r,{kind:"artifact",path:p}),"unsafe_path");
 assert.equal(ok(r,{kind:"document",path:"docs/d.json"}).value.id,"D");
 assert.equal(ok(r,{kind:"document",path:"docs/d.json",pointer:"/relations/one"}).value.id,"V1");
 assert.equal(red(r,{kind:"document",path:"docs/d.json",pointer:"/relations/~2"}),"malformed_pointer");
 assert.equal(red(r,{kind:"document",path:"docs/d.json",pointer:"/absent"}),"missing_fragment");
});
test("R12-R21 exact external, historical identity, deterministic repeat and floating rejection",()=>{
 const r=build(),ref={kind:"external_document",repository:external,revision:A,path:"docs/x.json",pointer:"/value"};
 const x=ok(r,ref),y=ok(r,ref);
 assert.deepEqual(x,y); assert.equal(x.value,1);assert.equal(x.representation.revision,A);
 assert.equal(ok(r,{...ref,revision:B}).value,2);
 for(const revision of ["main","master","HEAD","refs/heads/main","latest","v1","abcd"]) assert.equal(red(r,{...ref,revision}),"invalid_revision");
 assert.equal(red(r,{...ref,repository:"other/repo"}),"unknown_repository");
 assert.equal(red(r,{...ref,path:"docs/no.json"}),"missing_path");
 assert.equal(red(r,{...ref,pointer:"/missing"}),"missing_fragment");
});
test("R22-R31 authority neutral and semantic/exact subject separation",()=>{
 const r=build();
 for(const ref of [{kind:"requirement",id:"R1",trusted:true},{kind:"artifact",path:"src/a.mts",authoritative:true},{kind:"document",path:"docs/d.json",current:true},{kind:"external_document",repository:external,revision:A,path:"docs/x.json",accepted:true}]) assert.equal(red(r,ref),"invalid_ref");
 for(const ref of [{kind:"unknown",path:"docs/d.json"},{kind:"requirement",id:"R1",path:"requirements/R1.json"}])assert.equal(red(r,ref),"invalid_ref");
 const req=ok(r,{kind:"requirement",id:"R1"}),doc=ok(r,{kind:"document",path:"docs/d.json"});
 assert.equal(req.semantic.kind,"semantic_requirement");
 assert.equal(doc.representation.kind,"exact_representation");
 for(const result of [req,doc]) for(const k of ["trusted","accepted","authorized","current","justified","cause","affected"])assert.equal(k in result,false);
 assert.equal(doc.representation.repository,req.representation.repository);
 assert.equal(doc.representation.revision,req.representation.revision);
});
test("R32-R38 reader dispatch rejects mismatch, working-tree fallback and positional durable pointer",()=>{
 const r=build(),ref={kind:"external_document",repository:external,revision:A,path:"docs/x.json"};
 assert.equal(red(build({readers:{[repo]:readers[repo]}}),ref),"unknown_repository");
 assert.equal(red(r,{kind:"artifact",path:"src/unknown.mts"}),"missing_path");
 assert.equal(red(r,{kind:"document",path:"docs/d.json",pointer:"/relations/0"},{durable:true}),"non_durable_pointer");
 assert.equal(ok(r,{kind:"document",path:"docs/d.json",pointer:"/relations/one"},{durable:true}).value.id,"V1");
 assert.equal(red(r,{kind:"external_document",repository:external,revision:B,path:"docs/x.json",pointer:"/value"},{expectedRevision:A}),"inconsistent_snapshot");
});
