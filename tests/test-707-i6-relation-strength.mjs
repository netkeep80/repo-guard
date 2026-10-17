import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { evaluateTransitionCauseClosure } from "../dist/runtime/transition-closure.mjs";

const repository="netkeep80/repo-guard";
const A="a".repeat(40), B="b".repeat(40), C="c".repeat(40), D="d".repeat(40);
const art=(predicate,path)=>({predicate,target:{kind:"artifact",path}});
const req=(predicate,id)=>({predicate,target:{kind:"requirement",id}});
const node=(id,relations={},extra={})=>({path:"requirements/"+id+".json",value:{id,...extra,relations}});
const sources=(...nodes)=>nodes;
const paths=(nodes,...extra)=>[...nodes.map(n=>n.path),...extra];
function state(revision,nodes,tracked,{rootIds=["ROOT"],resourceRelations=[],allowInvalid=false}={}) {
  const byPath=new Map(nodes.map(x=>[x.path,x.value]));
  const requirements=loadCanonicalRequirements({repository,revision,paths:nodes.map(x=>x.path),
    readFile:(_,path)=>byPath.has(path)?JSON.stringify(byPath.get(path)):null});
  assert.equal(requirements.ok,true,JSON.stringify(requirements.errors));
  const j2=evaluateRootedRequirements({requirements,trustedRoots:rootIds.map(id=>requirements.index[id].semantic)});
  if(!allowInvalid) assert.equal(j2.ok,true,JSON.stringify(j2));
  const resolver=createResourceResolver({repository,revision,requirements,readers:{[repository]:(rev,path)=>
    rev===revision&&tracked.includes(path)?(byPath.has(path)?JSON.stringify(byPath.get(path)):"exact:"+rev+":"+path):null}});
  const j1=evaluateTrackedResourceClosure({repository,revision,requirements,j2,trackedPaths:tracked,resourceRelations,resolver});
  if(!allowInvalid) assert.equal(j1.ok,true,JSON.stringify(j1));
  return {revision,requirements,j2,j1,resourceRelations};
}
const auth=s=>({revision:s.revision,requirements:s.requirements,j2:s.j2});
const receipt=(a,b,h,permissions)=>({authorityBaseRevision:a.revision,baseRevision:b.revision,headRevision:h.revision,permissions});
const evidence=(a,b,h,key)=>({authorityBaseRevision:a.revision,baseRevision:b.revision,headRevision:h.revision,key,status:"pass"});
function evaluate(b,h,opt={}){return evaluateTransitionCauseClosure({repository,base:b,head:h,trustedAuthorityBase:opt.trustedAuthorityBase||auth(b),...opt});}
const intent=(...ids)=>({id:"external-work",addresses:ids});
const green=(r,label)=>assert.equal(r.ok,true,label+": "+r.reasons.join(" | "));
function red(r,fragment,label){assert.equal(r.ok,false,label+" unexpectedly GREEN");assert.ok(r.reasons.some(x=>x.includes(fragment)),label+" missing "+fragment+": "+r.reasons.join(" | "));}
const root=()=>node("ROOT");
const parent=req("derives_from","ROOT");
const normal=(path,predicate="implemented_by",key="implementation")=>node("R1",{parent,[key]:art(predicate,path)});
const built=(oldNode,newNode,basePaths,headPaths,options={})=>{
 const bNodes=[root(),oldNode],hNodes=[root(),newNode];
 const base=state(A,bNodes,paths(bNodes,...basePaths),options.baseState||{});
 const head=state(B,hNodes,paths(hNodes,...headPaths),options.headState||{});
 return {base,head};
};
test("I6 G01 implementation replacement requires no independent grant",()=>{
 const {base,head}=built(normal("src/old.ts"),normal("src/new.ts"),["src/old.ts"],["src/new.ts"]);
 green(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"delete",path:"src/old.ts"},{kind:"add",path:"src/new.ts"}]}),"G01");
});
test("I6 G02 exact rename is routine without artificial RequirementDelta",()=>{
 const {base,head}=built(normal("src/old.ts"),normal("src/new.ts"),["src/old.ts"],["src/new.ts"]);
 const r=evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"rename",previousPath:"src/old.ts",path:"src/new.ts"}]});
 green(r,"G02");assert.equal(r.deltas.some(d=>d.kind==="requirement_modify"),false);
});
test("I6 G03 verified_by replacement does not synthesize execution PASS",()=>{
 const {base,head}=built(normal("tests/old.mjs","verified_by"),normal("tests/new.mjs","verified_by"),["tests/old.mjs"],["tests/new.mjs"]);
 green(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"delete",path:"tests/old.mjs"},{kind:"add",path:"tests/new.mjs"}]}),"G03");
});
test("I6 G04 documents replacement is routine",()=>{
 const {base,head}=built(normal("docs/old.md","documents"),normal("docs/new.md","documents"),["docs/old.md"],["docs/new.md"]);
 green(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"delete",path:"docs/old.md"},{kind:"add",path:"docs/new.md"}]}),"G04");
});
test("I6 G05 relation-only descriptive correction without ResourceDelta",()=>{
 const bNode=node("R1",{parent,doc:art("documents","docs/shared.md")});
 const hNode=node("R1",{parent,doc:art("verified_by","docs/shared.md")});
 const {base,head}=built(bNode,hNode,["docs/shared.md"],["docs/shared.md"]);
 green(evaluate(base,head,{workIntent:intent("R1")}),"G05");
});
test("I6 G06 shared Resource remains owned after one descriptive replacement",()=>{
 const bNodes=[root(),normal("src/shared.ts"),node("R2",{parent,shared:art("implemented_by","src/shared.ts")})];
 const hNodes=[root(),normal("src/new.ts"),node("R2",{parent,shared:art("implemented_by","src/shared.ts")})];
 const base=state(A,bNodes,paths(bNodes,"src/shared.ts")),head=state(B,hNodes,paths(hNodes,"src/shared.ts","src/new.ts"));
 green(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"add",path:"src/new.ts"}]}),"G06");
});
test("I6 G07 N-target descriptive replacement stable and routine",()=>{
 const {base,head}=built(node("R1",{parent,a:art("implemented_by","src/a.ts"),b:art("implemented_by","src/b.ts")}),
 node("R1",{parent,c:art("implemented_by","src/c.ts"),d:art("implemented_by","src/d.ts")}),
 ["src/a.ts","src/b.ts"],["src/c.ts","src/d.ts"]);
 green(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[
 {kind:"delete",path:"src/a.ts"},{kind:"delete",path:"src/b.ts"},{kind:"add",path:"src/c.ts"},{kind:"add",path:"src/d.ts"}]}),"G07");
});
test("I6 G08 untouched requires obligation survives trace correction",()=>{
 const {base,head}=built(node("R1",{parent,need:art("requires","src/stable.ts"),i:art("implemented_by","src/old.ts")}),
 node("R1",{parent,need:art("requires","src/stable.ts"),i:art("implemented_by","src/new.ts")}),
 ["src/stable.ts","src/old.ts"],["src/stable.ts","src/new.ts"]);
 green(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"delete",path:"src/old.ts"},{kind:"add",path:"src/new.ts"}]}),"G08");
});
test("I6 G09 exact independent permission accepts otherwise protected transition",()=>{
 const {base,head}=built(node("R1",{parent,rule:art("constrains","docs/old.md"),doc:art("documents","docs/old.md")}),
 node("R1",{parent,doc:art("documents","docs/old.md")}),["docs/old.md"],["docs/old.md"]);
 const a=auth(base);
 green(evaluate(base,head,{workIntent:intent("R1"),trustedReceipts:[receipt(a,base,head,["requirement:R1"])]}),"G09");
});
test("I6 G10 unrelated owned resources not forced into artificial cochange",()=>{
 const {base,head}=built(node("R1",{parent,a:art("implemented_by","src/a.ts"),b:art("implemented_by","src/b.ts")}),
 node("R1",{parent,a:art("implemented_by","src/new.ts"),b:art("implemented_by","src/b.ts")}),
 ["src/a.ts","src/b.ts"],["src/new.ts","src/b.ts"]);
 const r=evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"delete",path:"src/a.ts"},{kind:"add",path:"src/new.ts"}]});
 green(r,"G10");assert.equal(r.deltas.some(d=>d.subject==="src/b.ts"&&d.kind.startsWith("resource_")),false);
});
test("I6 R01 blanket removal cannot become routine even with another owner",()=>{
 const bNodes=[root(),normal("src/shared.ts"),node("R2",{parent,other:art("implemented_by","src/shared.ts")})];
 const hNodes=[root(),node("R1",{parent}),node("R2",{parent,other:art("implemented_by","src/shared.ts")})];
 const b=state(A,bNodes,paths(bNodes,"src/shared.ts")),h=state(B,hNodes,paths(hNodes,"src/shared.ts"));
 red(evaluate(b,h,{workIntent:intent("R1")}),"missing_authority:requirement:R1","R01");
});
test("I6 R02 deleted requires obligation needs TRUST despite surviving alternative trace",()=>{
 const {base,head}=built(node("R1",{parent,need:art("requires","src/stable.ts"),impl:art("implemented_by","src/stable.ts")}),
 node("R1",{parent,impl:art("implemented_by","src/stable.ts")}),["src/stable.ts"],["src/stable.ts"]);
 red(evaluate(base,head,{workIntent:intent("R1")}),"missing_authority:requirement:R1","R02");
});
test("I6 R03 requires replaced with descriptive relation cannot launder weakness",()=>{
 const {base,head}=built(node("R1",{parent,need:art("requires","src/stable.ts")}),
 node("R1",{parent,weak:art("implemented_by","src/stable.ts")}),["src/stable.ts"],["src/stable.ts"]);
 red(evaluate(base,head,{workIntent:intent("R1")}),"missing_authority:requirement:R1","R03");
});
test("I6 R04 provenance removal remains protected if alternate root survives",()=>{
 const bNodes=[root(),node("R2",{parent}),node("R1",{a:req("derives_from","ROOT"),b:req("derives_from","R2")})];
 const hNodes=[root(),node("R2",{parent}),node("R1",{b:req("derives_from","R2")})];
 const b=state(A,bNodes,paths(bNodes)),h=state(B,hNodes,paths(hNodes));
 red(evaluate(b,h,{workIntent:intent("R1")}),"missing_authority:requirement:R1","R04");
});
test("I6 R05 constrains artifact removal cannot be treated as trace correction",()=>{
 const {base,head}=built(node("R1",{parent,guard:art("constrains","docs/policy.md"),doc:art("documents","docs/policy.md")}),
 node("R1",{parent,doc:art("documents","docs/policy.md")}),["docs/policy.md"],["docs/policy.md"]);
 red(evaluate(base,head,{workIntent:intent("R1")}),"missing_authority:requirement:R1","R05");
});
test("I6 R06 candidate WorkIntent metadata cannot mint authority",()=>{
 const {base,head}=built(node("R1",{parent,guard:art("constrains","docs/policy.md"),doc:art("documents","docs/policy.md")}),
 node("R1",{parent,doc:art("documents","docs/policy.md")}),["docs/policy.md"],["docs/policy.md"]);
 red(evaluate(base,head,{workIntent:{...intent("R1"),permissions:["requirement:R1"],trusted:true}}),"missing_authority:requirement:R1","R06");
});
test("I6 R07 stale exact receipt cannot survive rebase",()=>{
 const {base,head}=built(node("R1",{parent,need:art("requires","src/f.ts"),doc:art("documents","src/f.ts")}),
 node("R1",{parent,doc:art("documents","src/f.ts")}),["src/f.ts"],["src/f.ts"]);
 const a=auth(base);
 const stale={authorityBaseRevision:a.revision,baseRevision:C,headRevision:D,permissions:["requirement:R1"]};
 red(evaluate(base,head,{workIntent:intent("R1"),trustedReceipts:[stale]}),"missing_authority:requirement:R1","R07");
});
test("I6 R08 protected provider identity cannot be substituted by candidate relation",()=>{
 const {base,head}=built(normal(".github/workflows/trusted.yml"),normal(".github/workflows/trusted.yml"),[".github/workflows/trusted.yml"],[".github/workflows/trusted.yml"]);
 red(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"modify",path:".github/workflows/trusted.yml"}],protectedResources:[".github/workflows/trusted.yml"]}),"missing_authority:resource:.github/workflows/trusted.yml","R08");
});
test("I6 R09 descriptive trace never authorizes protected Resource mutation",()=>{
 const {base,head}=built(normal("src/immutable.ts"),normal("src/immutable.ts"),["src/immutable.ts"],["src/immutable.ts"]);
 red(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"modify",path:"src/immutable.ts"}],protectedResources:["src/immutable.ts"]}),"missing_authority:resource:src/immutable.ts","R09");
});
test("I6 R10 missing target cannot be accepted as exact ResourceRef",()=>{
 const bNodes=[root(),normal("src/a.ts")],hNodes=[root(),normal("src/missing.ts")];
 const b=state(A,bNodes,paths(bNodes,"src/a.ts")),h=state(B,hNodes,paths(hNodes),{allowInvalid:true});
 red(evaluate(b,h,{workIntent:intent("R1")}),"head:j1_not_closed","R10");
});
test("I6 R11 removing trace that leaves tracked orphan is not routine",()=>{
 const bNodes=[root(),normal("src/a.ts")],hNodes=[root(),node("R1",{parent})];
 const b=state(A,bNodes,paths(bNodes,"src/a.ts")),h=state(B,hNodes,paths(hNodes,"src/a.ts"),{allowInvalid:true});
 red(evaluate(b,h,{workIntent:intent("R1")}),"head:j1_not_closed","R11");
});
test("I6 R12 provenance replacement yielding unrooted SCC is RED",()=>{
 const bNodes=[root(),node("R1",{parent}),node("R2",{parent})];
 const hNodes=[root(),node("R1",{p:req("derives_from","R2")}),node("R2",{p:req("derives_from","R1")})];
 const b=state(A,bNodes,paths(bNodes)),h=state(B,hNodes,paths(hNodes),{allowInvalid:true});
 red(evaluate(b,h,{workIntent:intent("R1","R2")}),"head:j2_not_rooted","R12");
});
test("I6 R13 reverse impact cannot serve as cause",()=>{
 const nodes=[root(),normal("src/a.ts"),node("R2",{parent,dep:req("depends_on","R1")})];
 const b=state(A,nodes,paths(nodes,"src/a.ts")),h=state(B,nodes,paths(nodes,"src/a.ts"));
 red(evaluate(b,h,{workIntent:intent("R2"),resourceDeltas:[{kind:"modify",path:"src/a.ts"}]}),"no_cause","R13");
});
test("I6 R14 verified_by fact does not substitute exact execution evidence",()=>{
 const nodes=[root(),node("R1",{parent,verify:art("verified_by","tests/test.mjs")},{transition:{paths:["tests/test.mjs"],evidenceKeys:["execution:tests/test.mjs"]}})];
 const b=state(A,nodes,paths(nodes,"tests/test.mjs")),h=state(B,nodes,paths(nodes,"tests/test.mjs"));
 red(evaluate(b,h,{workIntent:intent("R1"),resourceDeltas:[{kind:"modify",path:"tests/test.mjs"}]}),"missing_evidence:execution:tests/test.mjs","R14");
});
test("I6 R15 candidate lifecycle promotion needs independent exact TRUST",()=>{
 const nodes=[root(),normal("src/a.ts")];
 const b=state(A,nodes,paths(nodes,"src/a.ts")),h=state(B,nodes,paths(nodes,"src/a.ts"));
 red(evaluate(b,h,{workIntent:intent("R1"),baseLifecycle:{R1:{current:false}},headLifecycle:{R1:{current:true}}}),"missing_authority:lifecycle:R1:current","R15");
});
test("I6 R16 retained evidence deletion cannot be authorized by trace removal",()=>{
 const bNodes=[root(),normal("history/evidence.md"),node("R2",{parent,retained:art("documents","history/evidence.md")})];
 const hNodes=[root(),node("R1",{parent}),node("R2",{parent,retained:art("documents","history/evidence.md")})];
 const b=state(A,bNodes,paths(bNodes,"history/evidence.md")),h=state(B,hNodes,paths(hNodes,"history/evidence.md"));
 red(evaluate(b,h,{workIntent:intent("R1"),resourceDeltas:[{kind:"delete",path:"history/evidence.md"}],protectedResources:["history/evidence.md"]}),"missing_authority:resource:history/evidence.md","R16");
});
test("I6 R17 mixed strong and weak predicates require before-state protection",()=>{
 const {base,head}=built(node("R1",{parent,strong:art("constrains","docs/a.md"),keep:art("documents","docs/a.md")}),
 node("R1",{parent,weak:art("implemented_by","docs/a.md"),keep:art("documents","docs/a.md")}),["docs/a.md"],["docs/a.md"]);
 red(evaluate(base,head,{workIntent:intent("R1")}),"missing_authority:requirement:R1","R17");
});
test("I6 R18 numerous descriptive edits cannot hide a strong removed obligation",()=>{
 const {base,head}=built(node("R1",{parent,strong:art("constrains","docs/a.md"),doc:art("documents","docs/a.md")}),
 node("R1",{parent,doc:art("documents","docs/a.md"),x:art("documents","docs/b.md"),y:art("implemented_by","docs/b.md"),z:art("verified_by","docs/b.md")}),
 ["docs/a.md"],["docs/a.md","docs/b.md"]);
 red(evaluate(base,head,{workIntent:intent("R1"),resourceDeltas:[{kind:"add",path:"docs/b.md"}]}),"missing_authority:requirement:R1","R18");
});
test("I6 R19 incomplete HEAD/J1 observations cannot be used to conceal orphan",()=>{
 const bNodes=[root(),node("R1",{parent,a:art("implemented_by","src/a.ts")})],hNodes=[root(),node("R1",{parent})];
 const b=state(A,bNodes,paths(bNodes,"src/a.ts")),h=state(B,hNodes,paths(hNodes,"src/a.ts"),{allowInvalid:true});
 red(evaluate(b,h,{workIntent:intent("R1")}),"head:j1_not_closed","R19");
});
test("I6 R20 N:M matching order must not alter verdicts",()=>{
 const old=node("R1",{parent,a:art("implemented_by","src/a.ts"),b:art("implemented_by","src/b.ts"),keep:art("documents","src/c.ts")});
 const newer=node("R1",{keep:art("documents","src/c.ts"),parent,b:art("implemented_by","src/y.ts"),a:art("implemented_by","src/x.ts")});
 const bNodes=[root(),old],hNodes=[root(),newer];
 const b=state(A,bNodes,paths(bNodes,"src/a.ts","src/b.ts","src/c.ts"));
 const h=state(B,hNodes,paths(hNodes,"src/x.ts","src/y.ts","src/c.ts"));
 const opts={workIntent:intent("R1"),resourceDeltas:[{kind:"delete",path:"src/a.ts"},{kind:"delete",path:"src/b.ts"},{kind:"add",path:"src/x.ts"},{kind:"add",path:"src/y.ts"}]};
 const r=evaluate(b,h,opts);
 green(r,"R20 deterministic benign replacement");
 const j=evaluate(b,h,{...opts,resourceDeltas:[...opts.resourceDeltas].reverse()});
 assert.deepEqual(r,j);
});
test("I6 extra: generates removal retains J1 but weakens explicit generation obligation",()=>{
 const bNodes=[root(),node("R1",{parent,a:art("implemented_by","src/from.ts"),b:art("documents","dist/to.js")})];
 const hNodes=bNodes;
 const b=state(A,bNodes,paths(bNodes,"src/from.ts","dist/to.js"),{resourceRelations:[{from:"src/from.ts",kind:"generates",to:"dist/to.js"}]});
 const h=state(B,hNodes,paths(hNodes,"src/from.ts","dist/to.js"));
 red(evaluate(b,h,{workIntent:intent("R1")}),"missing_authority:resource:src/from.ts","generates removal");
});
