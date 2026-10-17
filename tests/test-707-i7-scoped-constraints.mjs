import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTransitionCauseClosure } from "../dist/runtime/transition-closure.mjs";

const repo="netkeep80/repo-guard", A="a".repeat(40), B="b".repeat(40), C="c".repeat(40), D="d".repeat(40);
const art=(predicate,path)=>({predicate,target:{kind:"artifact",path}});
const parent={predicate:"derives_from",target:{kind:"requirement",id:"ROOT"}};
const node=(id,relations={},constraints,extra={})=>({path:`requirements/${id}.json`,value:{id,...extra,relations,...(constraints===undefined?{}:{constraints})}});
const lines=(max=10,relations=["implemented_by"],includeGenerated=false)=>({id:"lines",metric:"changed_lines",max,relations,includeGenerated});
const check=(kind="execution",key="execution:tests/t.mjs",verifierPath="tests/t.mjs")=>({id:"verify",relations:["implemented_by"],evidence:{kind,key,providerId:kind==="execution"?"ci":"domain",...(verifierPath?{verifierPath}:{})}});
const defaultRelations=()=>({parent,implementation:art("implemented_by","src/a.ts")});
const defaultNodes=(relations=defaultRelations(),constraints,other)=>[node("ROOT"),node("R1",relations,constraints),...(other?[node("R2",other.relations,other.constraints)]:[])];
function snapshot(revision,nodes,paths,edges=[],allowInvalid=false){
 const byPath=new Map(nodes.map(n=>[n.path,n.value]));
 const requirements=loadCanonicalRequirements({repository:repo,revision,paths:nodes.map(n=>n.path),readFile:(_,p)=>byPath.has(p)?JSON.stringify(byPath.get(p)):null});
 assert.equal(requirements.ok,true,JSON.stringify(requirements.errors));
 const j2=evaluateRootedRequirements({requirements,trustedRoots:[requirements.index.ROOT.semantic]});
 const tracked=[...nodes.map(n=>n.path),...paths];
 const resolver=createResourceResolver({repository:repo,revision,requirements,readers:{[repo]:(rev,p)=>
   rev===revision && tracked.includes(p)?(byPath.has(p)?JSON.stringify(byPath.get(p)):"exact:"+rev+":"+p):null}});
 const j1=evaluateTrackedResourceClosure({repository:repo,revision,requirements,j2,trackedPaths:tracked,resourceRelations:edges,resolver});
 if(!allowInvalid){assert.equal(j2.ok,true,JSON.stringify(j2));assert.equal(j1.ok,true,JSON.stringify(j1));}
 return {revision,requirements,j2,j1,resourceRelations:edges};
}
function run(opts={}){
 const baseNodes=opts.baseNodes||defaultNodes(opts.baseRelations||defaultRelations(),opts.baseConstraints,opts.otherBase);
 const headNodes=opts.headNodes||defaultNodes(opts.headRelations||opts.baseRelations||defaultRelations(),opts.headConstraints===undefined?opts.baseConstraints:opts.headConstraints,opts.otherHead||opts.otherBase);
 const base=snapshot(opts.baseRevision||A,baseNodes,opts.baseFiles||["src/a.ts"],opts.baseEdges||[],opts.allowInvalidBase||false);
 const head=snapshot(opts.headRevision||B,headNodes,opts.headFiles||opts.baseFiles||["src/a.ts"],opts.headEdges===undefined?opts.baseEdges||[]:opts.headEdges,opts.allowInvalidHead||false);
 const trustedAuthorityBase=opts.trustedAuthorityBase||{revision:base.revision,requirements:base.requirements,j2:base.j2};
 const rd=opts.resourceDeltas===undefined?[{kind:"modify",path:"src/a.ts"}]:opts.resourceDeltas;
 const observationFacts=(opts.observationFacts===undefined?
   (opts.observed===undefined?[]:[{path:opts.obsPath||"src/a.ts",metric:"changed_lines",value:opts.observed}]):
   opts.observationFacts).map(o=>({authorityBaseRevision:trustedAuthorityBase.revision,baseRevision:base.revision,headRevision:head.revision,providerId:"git",...o}));
 const evidenceFacts=(opts.evidence||[]).map(e=>({authorityBaseRevision:trustedAuthorityBase.revision,baseRevision:base.revision,headRevision:head.revision,
   requirementId:"R1",subjectPaths:["src/a.ts"],...e}));
 const trustedReceipts=(opts.receipts||[]).map(x=>({authorityBaseRevision:trustedAuthorityBase.revision,baseRevision:base.revision,headRevision:head.revision,permissions:x}));
 const result=evaluateTransitionCauseClosure({repository:repo,base,head,trustedAuthorityBase,resourceDeltas:rd,workIntent:opts.workIntent===undefined?{id:"W",addresses:["R1","R2"]}:opts.workIntent,
   observationFacts,evidenceFacts,trustedReceipts,trustedEvidenceProviders:["ci","domain","git"],protectedResources:opts.protectedResources||[]});
 return {result,base,head};
}
const yes=(x,name)=>assert.equal(x.result.ok,true,name+": "+x.result.reasons.join(" | "));
const no=(x,part,name)=>{assert.equal(x.result.ok,false,name+" unexpectedly GREEN");assert.ok(x.result.reasons.some(s=>s.includes(part)),name+" missing "+part+": "+x.result.reasons.join(" | "));};
const scopes=x=>x.result.explanations.constraints;
const bound=(id="R1",key="lines")=>`constraint:${id}:${key}`;
const hasScope=(x,owner,want)=>assert.deepEqual(scopes(x).find(e=>e.requirementId===owner)?.scope,want);
const ev=(over={})=>({key:"execution:tests/t.mjs",status:"pass",providerId:"ci",verifierPath:"tests/t.mjs",verifierRevision:B,...over});
const domain=(over={})=>({key:"domain:equivalence",status:"pass",providerId:"domain",...over});
const verifierRelations=()=>({...defaultRelations(),test:art("verified_by","tests/t.mjs")});
const r1other=()=>({relations:{parent,implementation:art("implemented_by","src/a.ts")},constraints:[lines(3)]});

test("I7 S01 one Requirement / one Resource derived scope",()=>{const x=run({baseConstraints:[lines()],observed:5});yes(x,"S01");hasScope(x,"R1",["src/a.ts"]);});
test("I7 S02 one Requirement / N Resources",()=>{const rel={...defaultRelations(),other:art("implemented_by","src/b.ts")};const x=run({baseRelations:rel,baseFiles:["src/a.ts","src/b.ts"],baseConstraints:[lines()],observed:5});yes(x,"S02");hasScope(x,"R1",["src/a.ts","src/b.ts"]);});
test("I7 S03 shared Resource belongs to N scopes",()=>{const x=run({baseConstraints:[lines(8)],otherBase:r1other(),observed:4});no(x,"constraint_exceeded:R2:lines","S03");assert.equal(scopes(x).length,2);});
test("I7 S04 multi-hop generates contributes only when enabled",()=>{const x=run({baseConstraints:[lines(10,["implemented_by"],true)],baseFiles:["src/a.ts","dist/a.js"],baseEdges:[{kind:"generates",from:"src/a.ts",to:"dist/a.js"}],resourceDeltas:[{kind:"modify",path:"dist/a.js"}],obsPath:"dist/a.js",observed:5});yes(x,"S04");hasScope(x,"R1",["dist/a.js","src/a.ts"]);});
test("I7 S05 shared Resource checks two separate limit owners",()=>{const x=run({baseConstraints:[lines(9)],otherBase:r1other(),observed:5});no(x,"constraint_exceeded:R2:lines","S05");assert.equal(scopes(x).length,2);});
test("I7 S06 BASE scope remains after HEAD relation withdrawal",()=>{const headRel={parent,documentation:art("documents","src/a.ts")};const x=run({baseConstraints:[lines(3)],headRelations:headRel,observed:5});no(x,"constraint_exceeded:R1:lines","S06");});
test("I7 S07 rename checks BASE and HEAD paths",()=>{const x=run({baseConstraints:[lines(3)],headRelations:{parent,implementation:art("implemented_by","src/b.ts")},headFiles:["src/b.ts"],resourceDeltas:[{kind:"rename",previousPath:"src/a.ts",path:"src/b.ts"}],obsPath:"src/b.ts",observed:5});no(x,"constraint_exceeded:R1:lines","S07");});
test("I7 S08 type-change retains scoped obligation",()=>{const x=run({baseConstraints:[lines(3)],resourceDeltas:[{kind:"type_change",path:"src/a.ts",beforeType:"file",afterType:"symlink"}],observed:5});no(x,"constraint_exceeded:R1:lines","S08");});
test("I7 S09 unrooted Requirement never establishes valid authority",()=>{const x=run({baseRelations:{implementation:art("implemented_by","src/a.ts")},baseConstraints:[lines(100)],allowInvalidBase:true,allowInvalidHead:true,observed:5});no(x,"base:j2_not_rooted","S09");});
test("I7 S10 no infrastructure wildcard justification exemption",()=>{const x=run({baseConstraints:[lines()],observed:5,headFiles:["src/a.ts",".github/workflows/ci.yml"],allowInvalidHead:true,resourceDeltas:[{kind:"add",path:".github/workflows/ci.yml"}]});no(x,"head:j1_not_closed","S10");});

test("I7 Q01 measured change below Requirement limit passes",()=>yes(run({baseConstraints:[lines(10)],observed:7}),"Q01"));
test("I7 Q02 measured change above Requirement limit fails",()=>no(run({baseConstraints:[lines(10)],observed:11}),"constraint_exceeded:R1:lines","Q02"));
test("I7 Q03 huge diff without Requirement-owned constraint is not a blocker",()=>yes(run({observed:17118}),"Q03"));
test("I7 Q04 scoped limit does not apply to unrelated changed Resource",()=>{const x=run({baseConstraints:[lines(3)],baseRelations:{...defaultRelations(),outside:art("documents","docs/other.md")},baseFiles:["src/a.ts","docs/other.md"],resourceDeltas:[{kind:"modify",path:"docs/other.md"}],obsPath:"docs/other.md",observed:17118});yes(x,"Q04");});
test("I7 Q05 shared Resource independently checked for all constraints",()=>no(run({baseConstraints:[lines(10)],otherBase:r1other(),observed:5}),"constraint_exceeded:R2:lines","Q05"));
test("I7 Q06 missing required independent OBSERVATION is not zero",()=>no(run({baseConstraints:[lines(10)]}),"missing_observation:R1:lines","Q06"));
test("I7 Q07 HEAD relabel cannot make BASE scoped change disappear",()=>no(run({baseConstraints:[lines(3)],headRelations:{parent,documentation:art("documents","src/a.ts")},observed:5}),"constraint_exceeded:R1:lines","Q07"));
test("I7 Q08 candidate deletes constraint, independent Requirement grant not a limit bypass",()=>no(run({baseConstraints:[lines(3)],headConstraints:[],receipts:[["requirement:R1"]],observed:5}),"constraint_exceeded:R1:lines","Q08"));
test("I7 Q09 candidate raises limit, independent Requirement grant not a BASE bypass",()=>no(run({baseConstraints:[lines(3)],headConstraints:[lines(100)],receipts:[["requirement:R1"]],observed:5}),"constraint_exceeded:R1:lines","Q09"));
test("I7 Q10 unordered observations/relations do not change verdict or proofs",()=>{const a=run({baseConstraints:[lines(8)],observed:5}),b=run({baseConstraints:[lines(8)],observationFacts:[{path:"src/a.ts",metric:"changed_lines",value:5}]});assert.deepEqual(a.result,b.result);});

test("I7 E01 verified_by trace alone cannot assert execution PASS",()=>no(run({baseConstraints:[check()],baseRelations:verifierRelations(),baseFiles:["src/a.ts","tests/t.mjs"]}),"missing_evidence:R1:verify","E01"));
test("I7 E02 exact verifier execution PASS with subject/provider satisfies obligation",()=>yes(run({baseConstraints:[check()],baseRelations:verifierRelations(),baseFiles:["src/a.ts","tests/t.mjs"],evidence:[ev()]}),"E02"));
test("I7 E03 another verifier's PASS is inapplicable",()=>no(run({baseConstraints:[check()],baseRelations:verifierRelations(),baseFiles:["src/a.ts","tests/t.mjs"],evidence:[ev({verifierPath:"tests/other.mjs"})]}),"missing_evidence:R1:verify","E03"));
test("I7 E04 PASS for different HEAD is stale",()=>no(run({baseConstraints:[check()],baseRelations:verifierRelations(),baseFiles:["src/a.ts","tests/t.mjs"],evidence:[ev({headRevision:C})]}),"missing_evidence:R1:verify","E04"));
test("I7 E05 FAIL does not count as PASS",()=>no(run({baseConstraints:[check()],baseRelations:verifierRelations(),baseFiles:["src/a.ts","tests/t.mjs"],evidence:[ev({status:"fail"})]}),"missing_evidence:R1:verify","E05"));
test("I7 E06 missing mandatory DOMAIN evidence is RED",()=>no(run({baseConstraints:[check("domain","domain:equivalence",null)]}),"missing_evidence:R1:verify","E06"));
test("I7 E07 J1/J2/J3 closure does not generate DOMAIN truth",()=>no(run({baseConstraints:[check("domain","domain:equivalence",null)]}),"missing_evidence:R1:verify","E07"));
test("I7 E08 generation freshness is independent DOMAIN fact",()=>{const x=run({baseConstraints:[{id:"fresh",relations:["implemented_by"],includeGenerated:true,evidence:{kind:"domain",key:"domain:generation_freshness",providerId:"domain"}}],baseFiles:["src/a.ts","dist/a.js"],baseEdges:[{kind:"generates",from:"src/a.ts",to:"dist/a.js"}],resourceDeltas:[{kind:"modify",path:"dist/a.js"}]});no(x,"missing_evidence:R1:fresh","E08");});
test("I7 E09 adding a verifier file does not mean execution PASS",()=>{const rel=verifierRelations();const x=run({baseConstraints:[check()],baseRelations:defaultRelations(),headRelations:rel,baseFiles:["src/a.ts"],headFiles:["src/a.ts","tests/t.mjs"],resourceDeltas:[{kind:"modify",path:"src/a.ts"},{kind:"add",path:"tests/t.mjs"}]});no(x,"missing_evidence:R1:verify","E09");});
test("I7 E10 Requirement change does not mechanically require verifier cochange",()=>{const old=defaultNodes(verifierRelations(),[check()]);const newer=defaultNodes(verifierRelations(),[check()],null);newer[1].value.note="refined";const x=run({baseNodes:old,headNodes:newer,baseFiles:["src/a.ts","tests/t.mjs"],resourceDeltas:[{kind:"modify",path:"src/a.ts"}],receipts:[["requirement:R1"]],evidence:[ev()]});yes(x,"E10");});

test("I7 T01 one-shot exact receipt waives only a specific scoped numeric limit",()=>yes(run({baseConstraints:[lines(800)],observed:17118,receipts:[[bound()]]}),"T01"));
test("I7 T02 receipt for a different Requirement is not applicable",()=>no(run({baseConstraints:[lines(800)],observed:17118,receipts:[[bound("R2")]]}),"constraint_exceeded:R1:lines","T02"));
test("I7 T03 receipt for a different constraint identity is not applicable",()=>no(run({baseConstraints:[lines(800)],observed:17118,receipts:[[bound("R1","other")]]}),"constraint_exceeded:R1:lines","T03"));
test("I7 T04 exact receipt for a different BASE is stale",()=>{const x=run({baseConstraints:[lines(800)],observed:17118});const {base,head}=x;const r=evaluateTransitionCauseClosure({repository:repo,base,head,trustedAuthorityBase:{revision:base.revision,requirements:base.requirements,j2:base.j2},workIntent:{id:"W",addresses:["R1"]},resourceDeltas:[{kind:"modify",path:"src/a.ts"}],observationFacts:[{authorityBaseRevision:A,baseRevision:A,headRevision:B,path:"src/a.ts",metric:"changed_lines",value:17118,providerId:"git"}],trustedEvidenceProviders:["git"],trustedReceipts:[{authorityBaseRevision:A,baseRevision:C,headRevision:B,permissions:[bound()]}]});no({result:r},"constraint_exceeded:R1:lines","T04");});
test("I7 T05 exact receipt for a different HEAD is stale",()=>{const x=run({baseConstraints:[lines(800)],observed:17118});const {base,head}=x;const r=evaluateTransitionCauseClosure({repository:repo,base,head,trustedAuthorityBase:{revision:A,requirements:base.requirements,j2:base.j2},workIntent:{id:"W",addresses:["R1"]},resourceDeltas:[{kind:"modify",path:"src/a.ts"}],observationFacts:[{authorityBaseRevision:A,baseRevision:A,headRevision:B,path:"src/a.ts",metric:"changed_lines",value:17118,providerId:"git"}],trustedEvidenceProviders:["git"],trustedReceipts:[{authorityBaseRevision:A,baseRevision:A,headRevision:C,permissions:[bound()]}]});no({result:r},"constraint_exceeded:R1:lines","T05");});
test("I7 T06 candidate WorkIntent flags cannot self-authorize",()=>no(run({baseConstraints:[lines(800)],observed:17118,workIntent:{id:"W",addresses:["R1"],permissions:[bound()],trusted:true}}),"constraint_exceeded:R1:lines","T06"));
test("I7 T07 constraint receipt cannot substitute authority for protected workflow mutation",()=>no(run({baseConstraints:[lines(800)],observed:17118,receipts:[[bound()]],protectedResources:["src/a.ts"]}),"missing_authority:resource:src/a.ts","T07"));
test("I7 T08 constraint exception does not bypass missing J3 cause",()=>no(run({baseConstraints:[lines(800)],observed:17118,receipts:[[bound()]],workIntent:null}),"J3:no_cause","T08"));
test("I7 T09 numeric exception cannot synthesize mandatory DOMAIN PASS",()=>no(run({baseConstraints:[{...lines(800),evidence:{kind:"domain",key:"domain:equivalence",providerId:"domain"}}],observed:17118,receipts:[[bound()]]}),"missing_evidence:R1:lines","T09"));
test("I7 T10 a one-shot receipt is not a permanent change profile",()=>{const x=run({baseConstraints:[lines(800)],observed:17118,receipts:[[bound()]],headRevision:D});yes(x,"T10 exact new permit");const {base,head}=x;const r=evaluateTransitionCauseClosure({repository:repo,base,head,trustedAuthorityBase:{revision:A,requirements:base.requirements,j2:base.j2},resourceDeltas:[{kind:"modify",path:"src/a.ts"}],workIntent:{id:"W",addresses:["R1"]},observationFacts:[{authorityBaseRevision:A,baseRevision:A,headRevision:D,path:"src/a.ts",metric:"changed_lines",value:17118,providerId:"git"}],trustedEvidenceProviders:["git"],trustedReceipts:[{authorityBaseRevision:A,baseRevision:A,headRevision:B,permissions:[bound()]}]});no({result:r},"constraint_exceeded:R1:lines","T10 stale");});

/* Additional production adversarial provenance and stacked-authority falsifiers. */
test("I7 A01 forged OBSERVATION provider is not independent evidence",()=>no(run({baseConstraints:[lines(800)],observed:5,observationFacts:[{path:"src/a.ts",metric:"changed_lines",value:5,providerId:"candidate"}]}),"invalid_observation","A01"));
test("I7 A02 fact from untrusted DOMAIN provider cannot authorize",()=>no(run({baseConstraints:[check("domain","domain:equivalence",null)],evidence:[domain({providerId:"candidate"})]}),"missing_evidence:R1:verify","A02"));
test("I7 A03 PASS bound to wrong Resource subject does not satisfy verification",()=>no(run({baseConstraints:[check()],baseRelations:verifierRelations(),baseFiles:["src/a.ts","tests/t.mjs"],evidence:[ev({subjectPaths:["src/b.ts"]})]}),"missing_evidence:R1:verify","A03"));
test("I7 A04 simultaneous PASS and FAIL from same evidence subject fail closed",()=>no(run({baseConstraints:[check()],baseRelations:verifierRelations(),baseFiles:["src/a.ts","tests/t.mjs"],evidence:[ev(),ev({status:"fail"})]}),"conflicting_evidence:R1:verify","A04"));
test("I7 A05 forged execution PASS without verified_by trace fails exact verifier relevance",()=>no(run({baseConstraints:[check()],evidence:[ev()]}),"missing_evidence:R1:verify","A05"));
test("I7 A06 conflicting duplicate numeric observations fail closed",()=>no(run({baseConstraints:[lines(10)],observationFacts:[{path:"src/a.ts",metric:"changed_lines",value:5},{path:"src/a.ts",metric:"changed_lines",value:1}]}),"duplicate_observation","A06"));
test("I7 A07 malformed candidate constraint definition rejects unknown metric",()=>{const x=run({baseConstraints:[{id:"broken",metric:"untrusted_metric",max:10,relations:["implemented_by"]}]});no(x,"invalid_constraint:AUTHORITY:R1","A07");});
test("I7 A08 generated path is excluded when descriptor does not request descendants",()=>{const x=run({baseConstraints:[lines(1)],baseRelations:{...defaultRelations(),generated:art("documents","dist/a.js")},baseFiles:["src/a.ts","dist/a.js"],baseEdges:[{from:"src/a.ts",kind:"generates",to:"dist/a.js"}],resourceDeltas:[{kind:"modify",path:"dist/a.js"}],obsPath:"dist/a.js",observed:17118});yes(x,"A08");});
test("I7 A09 changed_resources metric counts exact delta without line observation",()=>{const x=run({baseConstraints:[{id:"count",metric:"changed_resources",max:1,relations:["implemented_by"]}]});yes(x,"A09");assert.equal(scopes(x)[0].observed,1);});
test("I7 A10 trusted authority BASE constraint survives weaker stacked local BASE",()=>{const acceptedNodes=defaultNodes(defaultRelations(),[lines(3)]);const accepted=snapshot(C,acceptedNodes,["src/a.ts"]);const trustedAuthorityBase={revision:accepted.revision,requirements:accepted.requirements,j2:accepted.j2};const x=run({baseConstraints:[lines(800)],headConstraints:[lines(800)],observed:5,trustedAuthorityBase});no(x,"constraint_exceeded:R1:lines","A10");});

test("I7 A11 missing accepted generation graph on stacked authority is fail-closed",()=>{const acceptedNodes=defaultNodes(defaultRelations(),[lines(3,["implemented_by"],true)]);const accepted=snapshot(C,acceptedNodes,["src/a.ts"]);const trustedAuthorityBase={revision:C,requirements:accepted.requirements,j2:accepted.j2};const x=run({baseConstraints:[lines(800)],observed:5,trustedAuthorityBase});no(x,"missing_trusted_generation_scope:R1:lines","A11");});
test("I7 A12 accepted generation graph remains effective after local stacked edge removal",()=>{const edge={from:"src/a.ts",kind:"generates",to:"dist/a.js"};const acceptedNodes=defaultNodes(defaultRelations(),[lines(3,["implemented_by"],true)]);const accepted=snapshot(C,acceptedNodes,["src/a.ts","dist/a.js"],[edge]);const trustedAuthorityBase={revision:C,requirements:accepted.requirements,j2:accepted.j2,resourceRelations:[edge]};const rel={...defaultRelations(),doc:art("documents","dist/a.js")};const x=run({baseRelations:rel,baseConstraints:[lines(800)],baseFiles:["src/a.ts","dist/a.js"],resourceDeltas:[{kind:"modify",path:"dist/a.js"}],obsPath:"dist/a.js",observed:5,trustedAuthorityBase});no(x,"constraint_exceeded:R1:lines","A12");});
