import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { evaluateTransitionCauseClosure } from "../dist/runtime/transition-closure.mjs";

const repository="netkeep80/repo-guard", A="a".repeat(40), B="b".repeat(40);
const art=(predicate,path)=>({predicate,target:{kind:"artifact",path}});
const req=(predicate,id)=>({predicate,target:{kind:"requirement",id}});
const node=(id,relations={})=>({path:"requirements/"+id+".json",value:{id,relations}});
const root=()=>node("ROOT"), parent=req("derives_from","ROOT");
const normal=(path,predicate="implemented_by")=>node("R1",{parent,target:art(predicate,path)});
function state(revision,nodes,files,edges=[]){
  const byPath=new Map(nodes.map(x=>[x.path,x.value]));
  const requirements=loadCanonicalRequirements({repository,revision,paths:nodes.map(x=>x.path),readFile:(_,p)=>byPath.has(p)?JSON.stringify(byPath.get(p)):null});
  assert.equal(requirements.ok,true,JSON.stringify(requirements.errors));
  const j2=evaluateRootedRequirements({requirements,trustedRoots:[requirements.index.ROOT.semantic]});
  assert.equal(j2.ok,true,JSON.stringify(j2));
  const trackedPaths=[...nodes.map(x=>x.path),...files];
  const resolver=createResourceResolver({repository,revision,requirements,readers:{[repository]:(rev,p)=>rev===revision&&trackedPaths.includes(p)?(byPath.has(p)?JSON.stringify(byPath.get(p)):"exact:"+rev+":"+p):null}});
  const j1=evaluateTrackedResourceClosure({repository,revision,requirements,j2,trackedPaths,resourceRelations:edges,resolver});
  assert.equal(j1.ok,true,JSON.stringify(j1));
  return {revision,requirements,j2,j1,resourceRelations:edges};
}
const authority=s=>({revision:s.revision,requirements:s.requirements,j2:s.j2,j1:s.j1,resourceRelations:s.resourceRelations});
const evaluate=(base,head,resourceDeltas=[])=>evaluateTransitionCauseClosure({repository,base,head,trustedAuthorityBase:authority(base),resourceDeltas});
const green=(r,label)=>assert.equal(r.ok,true,label+": "+r.reasons.join(" | "));

test("relation strength: implemented_by replacement is causal without extra authority",()=>{
  const base=state(A,[root(),normal("src/old.ts")],["src/old.ts"]);
  const head=state(B,[root(),normal("src/new.ts")],["src/new.ts"]);
  green(evaluate(base,head,[{kind:"delete",path:"src/old.ts"},{kind:"add",path:"src/new.ts"}]),"implementation");
});

test("relation strength: verified_by replacement remains structural, not execution truth",()=>{
  const base=state(A,[root(),normal("tests/old.mjs","verified_by")],["tests/old.mjs"]);
  const head=state(B,[root(),normal("tests/new.mjs","verified_by")],["tests/new.mjs"]);
  green(evaluate(base,head,[{kind:"delete",path:"tests/old.mjs"},{kind:"add",path:"tests/new.mjs"}]),"verified_by");
});

test("relation strength: documents replacement remains descriptive causal topology",()=>{
  const base=state(A,[root(),normal("docs/old.md","documents")],["docs/old.md"]);
  const head=state(B,[root(),normal("docs/new.md","documents")],["docs/new.md"]);
  green(evaluate(base,head,[{kind:"delete",path:"docs/old.md"},{kind:"add",path:"docs/new.md"}]),"documents");
});

test("relation strength: requires relation removal is still explained by its owning Requirement",()=>{
  const base=state(A,[root(),node("R1",{parent,need:art("requires","src/stable.ts")})],["src/stable.ts"]);
  const head=state(B,[root(),node("R1",{parent,doc:art("documents","src/stable.ts")})],["src/stable.ts"]);
  const result=evaluate(base,head);
  green(result,"requires");
  const relation=result.explanations.whyChanged.find(x=>x.kind.startsWith("relation_") && x.causes.includes("R1"));
  assert.ok(relation, "relation transition must retain R1 as causal owner");
});

test("relation strength: resource generates topology stays causal through exact source ownership",()=>{
  const nodes=[root(),normal("src/a.ts")];
  const base=state(A,nodes,["src/a.ts","dist/a.js"],[{from:"src/a.ts",kind:"generates",to:"dist/a.js"}]);
  const head=state(B,nodes,["src/a.ts","dist/b.js"],[{from:"src/a.ts",kind:"generates",to:"dist/b.js"}]);
  green(evaluate(base,head,[{kind:"delete",path:"dist/a.js"},{kind:"add",path:"dist/b.js"}]),"generates");
});

console.log("J3 relation-strength compiler witnesses loaded");
