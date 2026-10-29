import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements, validateCompiledConstraint } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTransitionCauseClosure } from "../dist/runtime/transition-closure.mjs";

const repo="netkeep80/repo-guard", A="a".repeat(40), B="b".repeat(40), C="c".repeat(40);
const art=(predicate,path)=>({predicate,target:{kind:"artifact",path}});
const parent={predicate:"derives_from",target:{kind:"requirement",id:"ROOT"}};
const node=(id,relations={},constraints)=>({path:`requirements/${id}.json`,value:{id,relations,...(constraints===undefined?{}:{constraints})}});
const lines=(max=10,relations=["implemented_by"],includeGenerated=false)=>({id:"lines",metric:"changed_lines",max,relations,includeGenerated});
const check=(kind="execution",key="execution:tests/t.mjs",verifierPath="tests/t.mjs")=>({id:"verify",relations:["implemented_by"],evidence:{kind,key,...(verifierPath?{verifierPath}:{})}});
const defaultRelations=()=>({parent,implementation:art("implemented_by","src/a.ts")});
const defaultNodes=(relations=defaultRelations(),constraints,other)=>[node("ROOT"),node("R1",relations,constraints),...(other?[node("R2",other.relations,other.constraints)]:[])];
function snapshot(revision,nodes,paths,edges=[],allowInvalid=false){
  const byPath=new Map(nodes.map(n=>[n.path,n.value]));
  const requirements=loadCanonicalRequirements({repository:repo,revision,paths:nodes.map(n=>n.path),readFile:(_,p)=>byPath.has(p)?JSON.stringify(byPath.get(p)):null});
  assert.equal(requirements.ok,true,JSON.stringify(requirements.errors));
  const j2=evaluateRootedRequirements({requirements,trustedRoots:[requirements.index.ROOT.semantic]});
  const tracked=[...nodes.map(n=>n.path),...paths];
  const resolver=createResourceResolver({repository:repo,revision,requirements,readers:{[repo]:(rev,p)=>rev===revision&&tracked.includes(p)?(byPath.has(p)?JSON.stringify(byPath.get(p)):"exact:"+rev+":"+p):null}});
  const j1=evaluateTrackedResourceClosure({repository:repo,revision,requirements,j2,trackedPaths:tracked,resourceRelations:edges,resolver});
  if(!allowInvalid){assert.equal(j2.ok,true,JSON.stringify(j2));assert.equal(j1.ok,true,JSON.stringify(j1));}
  return {revision,requirements,j2,j1,resourceRelations:edges};
}
function run(opts={}){
  const baseNodes=opts.baseNodes||defaultNodes(opts.baseRelations||defaultRelations(),opts.baseConstraints,opts.otherBase);
  const headNodes=opts.headNodes||defaultNodes(opts.headRelations||opts.baseRelations||defaultRelations(),opts.headConstraints===undefined?opts.baseConstraints:opts.headConstraints,opts.otherHead||opts.otherBase);
  const base=snapshot(opts.baseRevision||A,baseNodes,opts.baseFiles||["src/a.ts"],opts.baseEdges||[],opts.allowInvalidBase||false);
  const head=snapshot(opts.headRevision||B,headNodes,opts.headFiles||opts.baseFiles||["src/a.ts"],opts.headEdges===undefined?opts.baseEdges||[]:opts.headEdges,opts.allowInvalidHead||false);
  const trustedAuthorityBase=opts.trustedAuthorityBase||{revision:base.revision,requirements:base.requirements,j2:base.j2,j1:base.j1,resourceRelations:base.resourceRelations};
  const resourceDeltas=opts.resourceDeltas===undefined?[{kind:"modify",path:"src/a.ts"}]:opts.resourceDeltas;
  const observationFacts=(opts.observationFacts===undefined?(opts.observed===undefined?[]:[{path:opts.obsPath||"src/a.ts",metric:"changed_lines",value:opts.observed}]):opts.observationFacts)
    .map(o=>({authorityBaseRevision:trustedAuthorityBase.revision,baseRevision:base.revision,headRevision:head.revision,...o}));
  const result=evaluateTransitionCauseClosure({repository:repo,base,head,trustedAuthorityBase,resourceDeltas,observationFacts});
  return {result,base,head};
}
const yes=(x,name)=>assert.equal(x.result.ok,true,name+": "+x.result.reasons.join(" | "));
const no=(x,part,name)=>{assert.equal(x.result.ok,false,name+" unexpectedly GREEN");assert.ok(x.result.reasons.some(s=>s.includes(part)),name+" missing "+part+": "+x.result.reasons.join(" | "));};
const scopes=x=>x.result.explanations.constraints;
const hasScope=(x,owner,want)=>assert.deepEqual(scopes(x).find(e=>e.requirementId===owner)?.scope,want);
const verifierRelations=()=>({...defaultRelations(),test:art("verified_by","tests/t.mjs")});
const otherOwner=()=>({relations:{parent,implementation:art("implemented_by","src/a.ts")},constraints:[lines(3)]});

test("scoped Constraint: one Requirement / one Resource",()=>{const x=run({baseConstraints:[lines()],observed:5});yes(x,"scope");hasScope(x,"R1",["src/a.ts"]);});
test("scoped Constraint: generated descendants are included only when declared",()=>{const x=run({baseConstraints:[lines(10,["implemented_by"],true)],baseFiles:["src/a.ts","dist/a.js"],baseEdges:[{kind:"generates",from:"src/a.ts",to:"dist/a.js"}],resourceDeltas:[{kind:"modify",path:"dist/a.js"}],obsPath:"dist/a.js",observed:5});yes(x,"generated");hasScope(x,"R1",["dist/a.js","src/a.ts"]);});
test("scoped Constraint: shared Resource is checked independently for every owner",()=>no(run({baseConstraints:[lines(10)],otherBase:otherOwner(),observed:5}),"constraint_exceeded:R2:lines","shared"));
test("scoped Constraint: rename checks BASE and HEAD paths",()=>no(run({baseConstraints:[lines(3)],headRelations:{parent,implementation:art("implemented_by","src/b.ts")},headFiles:["src/b.ts"],resourceDeltas:[{kind:"rename",previousPath:"src/a.ts",path:"src/b.ts"}],obsPath:"src/b.ts",observed:5}),"constraint_exceeded:R1:lines","rename"));
test("scoped Constraint: type-change retains the obligation",()=>no(run({baseConstraints:[lines(3)],resourceDeltas:[{kind:"type_change",path:"src/a.ts",beforeType:"file",afterType:"symlink"}],observed:5}),"constraint_exceeded:R1:lines","type-change"));

test("scoped Constraint: below limit passes and above limit fails",()=>{yes(run({baseConstraints:[lines(10)],observed:7}),"below");no(run({baseConstraints:[lines(10)],observed:11}),"constraint_exceeded:R1:lines","above");});
test("scoped Constraint: huge diff without a Requirement-owned limit is not a hidden global budget",()=>yes(run({observed:17118}),"no global budget"));
test("scoped Constraint: unrelated changed Resource is outside the local scope",()=>{const x=run({baseConstraints:[lines(3)],baseRelations:{...defaultRelations(),outside:art("documents","docs/other.md")},baseFiles:["src/a.ts","docs/other.md"],resourceDeltas:[{kind:"modify",path:"docs/other.md"}],obsPath:"docs/other.md",observed:17118});yes(x,"unrelated");});
test("scoped Constraint: missing exact observation is RED, never zero",()=>no(run({baseConstraints:[lines(10)]}),"missing_observation:R1:lines","missing observation"));
test("scoped Constraint: candidate deletion or increase cannot erase BASE obligation",()=>{no(run({baseConstraints:[lines(3)],headConstraints:[],observed:5}),"constraint_exceeded:R1:lines","delete");no(run({baseConstraints:[lines(3)],headConstraints:[lines(100)],observed:5}),"constraint_exceeded:R1:lines","raise");});

test("observation semantics: stale exact transition is rejected",()=>no(run({baseConstraints:[lines(10)],observationFacts:[{authorityBaseRevision:A,baseRevision:A,headRevision:C,path:"src/a.ts",metric:"changed_lines",value:5}]}),"invalid_observation:src/a.ts","stale observation"));
test("observation semantics: conflicting duplicate numeric observations fail closed",()=>no(run({baseConstraints:[lines(10)],observationFacts:[{path:"src/a.ts",metric:"changed_lines",value:5},{path:"src/a.ts",metric:"changed_lines",value:1}]}),"duplicate_observation:src/a.ts","duplicate"));

test("external execution constraint is delegated only when verified_by topology is valid",()=>{
  const ok=run({baseConstraints:[check()],baseRelations:verifierRelations(),baseFiles:["src/a.ts","tests/t.mjs"]});
  yes(ok,"delegated");
  assert.equal(scopes(ok).find(x=>x.constraintId==="verify")?.verdict,"DELEGATED");
  no(run({baseConstraints:[check()]}),"invalid_external_verifier:R1:verify","missing verifier");
});
test("external domain constraint remains delegated to ordinary domain CI",()=>{
  const x=run({baseConstraints:[check("domain","domain:equivalence",null)]});
  yes(x,"domain delegated");
  assert.equal(scopes(x).find(item=>item.constraintId==="verify")?.verdict,"DELEGATED");
});

test("accepted authority Constraint survives a weaker stacked local BASE",()=>{
  const acceptedNodes=defaultNodes(defaultRelations(),[lines(3)]);
  const accepted=snapshot(C,acceptedNodes,["src/a.ts"]);
  const trustedAuthorityBase={revision:C,requirements:accepted.requirements,j2:accepted.j2,j1:accepted.j1,resourceRelations:accepted.resourceRelations};
  no(run({baseConstraints:[lines(800)],headConstraints:[lines(800)],observed:5,trustedAuthorityBase}),"constraint_exceeded:R1:lines","stacked authority");
});
test("accepted generated scope fails closed when its generation graph is unavailable",()=>{
  const acceptedNodes=defaultNodes(defaultRelations(),[lines(3,["implemented_by"],true)]);
  const accepted=snapshot(C,acceptedNodes,["src/a.ts"]);
  const trustedAuthorityBase={revision:C,requirements:accepted.requirements,j2:accepted.j2,j1:accepted.j1};
  no(run({baseConstraints:[lines(800)],observed:5,trustedAuthorityBase}),"missing_trusted_generation_scope:R1:lines","generation scope");
});

const requirementCauseZero=()=>({id:"no-ui",activation:"requirement_cause",relations:["constrains"],metric:"changed_resources",max:0});
function hardening(deltas){
  const relationsR2={parent,shared:art("implemented_by","src/shared.ts"),guardedUi:art("constrains","src/ui.ts")};
  const nodes=[node("ROOT"),node("R1",{parent,shared:art("implemented_by","src/shared.ts")}),node("R2",relationsR2,[requirementCauseZero()]),node("R3",{parent,ui:art("implemented_by","src/ui.ts")})];
  const base=snapshot(A,nodes,["src/shared.ts","src/ui.ts"]),head=snapshot(B,nodes,["src/shared.ts","src/ui.ts"]);
  return evaluateTransitionCauseClosure({repository:repo,base,head,trustedAuthorityBase:{revision:A,requirements:base.requirements,j2:base.j2,j1:base.j1},resourceDeltas:deltas});
}
test("requirement_cause Constraint activates from repository causal ownership",()=>{
  const redResult=hardening([{kind:"modify",path:"src/shared.ts"},{kind:"modify",path:"src/ui.ts"}]);
  assert.equal(redResult.ok,false);
  assert.ok(redResult.reasons.some(x=>x.includes("constraint_exceeded:R2:no-ui:1>0")),redResult.reasons.join(" | "));
  const greenResult=hardening([{kind:"modify",path:"src/shared.ts"}]);
  assert.equal(greenResult.ok,true,greenResult.reasons.join(" | "));
});


const metricEvidence = ({ metric = "changed_resources", max = 10, kind = "domain", verifierPath = null } = {}) => ({
  id: "combo",
  relations: ["implemented_by"],
  metric,
  max,
  evidence: {
    kind,
    key: kind === "execution" ? "execution:tests/t.mjs" : "domain:test",
    ...(verifierPath ? { verifierPath } : {}),
  },
});
const constraintExplanation = (x, id = "combo") => scopes(x).find(item => item.constraintId === id);

test("#836 F1 metric PASS + no evidence", () => {
  const x = run({ baseConstraints: [lines(10)], observed: 5 });
  yes(x, "metric pass");
  assert.equal(constraintExplanation(x, "lines")?.verdict, "PASS");
  assert.equal(constraintExplanation(x, "lines")?.evidenceStatus, null);
});
test("#836 F2 metric RED + no evidence", () => {
  const x = run({ baseConstraints: [lines(0)], observed: 1 });
  no(x, "constraint_exceeded:R1:lines:1>0", "metric red");
  assert.equal(constraintExplanation(x, "lines")?.verdict, "RED");
  assert.equal(constraintExplanation(x, "lines")?.evidenceStatus, null);
});
test("#836 F3 evidence-only valid domain delegation", () => {
  const x = run({ baseConstraints: [check("domain", "domain:test", null)] });
  yes(x, "domain evidence");
  assert.equal(constraintExplanation(x, "verify")?.verdict, "DELEGATED");
  assert.equal(constraintExplanation(x, "verify")?.evidenceStatus, "DELEGATED");
});
test("#836 F4 metric PASS + valid domain evidence", () => {
  const x = run({ baseConstraints: [metricEvidence({ max: 2 })] });
  yes(x, "metric pass domain");
  assert.equal(constraintExplanation(x)?.verdict, "DELEGATED");
  assert.equal(constraintExplanation(x)?.evidenceStatus, "DELEGATED");
});
test("#836 F5 metric RED + valid domain evidence", () => {
  const x = run({ baseConstraints: [metricEvidence({ max: 0 })] });
  no(x, "constraint_exceeded:R1:combo:1>0", "metric red domain");
  assert.equal(constraintExplanation(x)?.verdict, "RED");
  assert.equal(constraintExplanation(x)?.evidenceStatus, "DELEGATED");
});
test("#836 F6 metric PASS + valid execution evidence", () => {
  const x = run({
    baseConstraints: [metricEvidence({ max: 2, kind: "execution", verifierPath: "tests/t.mjs" })],
    baseRelations: verifierRelations(),
    baseFiles: ["src/a.ts", "tests/t.mjs"],
  });
  yes(x, "metric pass execution");
  assert.equal(constraintExplanation(x)?.verdict, "DELEGATED");
  assert.equal(constraintExplanation(x)?.evidenceStatus, "DELEGATED");
});
test("#836 F7 metric RED + valid execution evidence", () => {
  const x = run({
    baseConstraints: [metricEvidence({ max: 0, kind: "execution", verifierPath: "tests/t.mjs" })],
    baseRelations: verifierRelations(),
    baseFiles: ["src/a.ts", "tests/t.mjs"],
  });
  no(x, "constraint_exceeded:R1:combo:1>0", "metric red execution");
  assert.equal(constraintExplanation(x)?.verdict, "RED");
  assert.equal(constraintExplanation(x)?.evidenceStatus, "DELEGATED");
});
test("#836 F8 invalid execution verifier stays RED", () => {
  const x = run({ baseConstraints: [metricEvidence({ max: 2, kind: "execution", verifierPath: "tests/t.mjs" })] });
  no(x, "invalid_external_verifier:R1:combo", "invalid verifier");
  assert.equal(constraintExplanation(x)?.verdict, "RED");
  assert.equal(constraintExplanation(x)?.evidenceStatus, "INVALID");
});
test("#836 F9 inactive Constraint does not activate evidence", () => {
  const x = run({ baseConstraints: [check("domain", "domain:test", null)], resourceDeltas: [] });
  yes(x, "inactive evidence");
  assert.equal(constraintExplanation(x, "verify")?.verdict, "NOT_APPLICABLE");
  assert.equal(constraintExplanation(x, "verify")?.evidenceStatus, null);
});
test("#836 F10 missing changed_lines observation stays RED with evidence", () => {
  const x = run({ baseConstraints: [metricEvidence({ metric: "changed_lines", max: 10 })] });
  no(x, "missing_observation:R1:combo:src/a.ts", "missing observation with evidence");
  assert.equal(constraintExplanation(x)?.verdict, "RED");
  assert.equal(constraintExplanation(x)?.evidenceStatus, "DELEGATED");
});


const b1Canonical = (rule) => {
  const parsed = validateCompiledConstraint(rule);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.value;
};
const b1Original = {
  id: "guard", relations: ["implemented_by", "documents"],
  metric: "changed_resources", max: 1,
};
const b1Explicit = {
  id: "guard", activation: "scoped_change",
  relations: ["documents", "implemented_by"], includeGenerated: false,
  metric: "changed_resources", max: 1,
};
function b1Replay(authorityRule, baseRule) {
  const relations = {
    parent, implementation: art("implemented_by", "src/a.ts"),
    document: art("documents", "docs/a.md"),
  };
  const paths = ["src/a.ts", "docs/a.md"];
  const authority = snapshot(C, defaultNodes(relations, [authorityRule]), paths);
  const base = snapshot(A, defaultNodes(relations, [baseRule]), paths);
  const head = snapshot(B, defaultNodes(relations, [baseRule]), paths);
  const result = evaluateTransitionCauseClosure({
    repository: repo, base, head,
    trustedAuthorityBase: {
      revision: authority.revision, requirements: authority.requirements,
      j1: authority.j1, j2: authority.j2,
      resourceRelations: authority.resourceRelations,
    },
    resourceDeltas: [{kind:"modify", path:"src/a.ts"}],
  });
  return result.explanations.constraints.filter(x => x.requirementId === "R1" && x.constraintId === "guard");
}
test("#836 B1 blocked-head direct compiled reproducer: semantic equivalents must apply once", () => {
  assert.equal(b1Canonical(b1Original).id, "guard");
  assert.equal(b1Canonical(b1Explicit).id, "guard");
  assert.equal(b1Replay(b1Original, b1Explicit).length, 1, "AUTHORITY/BASE/HEAD duplicate obligation");
});
test("#836 B1 default and relation order canonical fingerprints", () => {
  const variants = [
    {...b1Original, activation: "scoped_change"},
    {...b1Original, includeGenerated: false},
    {...b1Original, relations: [...b1Original.relations].reverse()},
    b1Explicit,
  ];
  for (const variant of variants) {
    assert.deepEqual(b1Canonical(variant), b1Canonical(b1Original));
    assert.equal(b1Replay(b1Original, variant).length, 1, JSON.stringify(variant));
  }
});
test("#836 B1 preserve true semantic differences and reject duplicate relations", () => {
  const variants = [
    {...b1Original, activation:"requirement_cause"},
    {...b1Original, includeGenerated:true},
    {...b1Original, relations:["implemented_by"]},
    {...b1Original, relations:["documents"]},
    {...b1Original, metric:"changed_lines"},
    {...b1Original, max:2},
    {...b1Original, evidence:{kind:"domain",key:"domain:test"}},
  ];
  for (const variant of variants) {
    assert.notDeepEqual(b1Canonical(variant),b1Canonical(b1Original));
    assert.equal(b1Replay(b1Original,variant).length,2,JSON.stringify(variant));
  }
  assert.equal(validateCompiledConstraint({
    ...b1Original,relations:["documents","documents"],
  }).ok,false);
});


test("#840 Slice 3 legacy malformed Constraint collection remains fail-closed", () => {
  no(
    run({ baseConstraints: { malformed: true }, headConstraints: { malformed: true }, resourceDeltas: [] }),
    "I7:invalid_constraints:AUTHORITY:R1",
    "legacy malformed constraints collection",
  );
});

test("#840 Slice 3 legacy malformed Constraint item remains fail-closed", () => {
  const malformed = [{ id: "bad", relations: ["implemented_by"], metric: "changed_resources" }];
  no(
    run({ baseConstraints: malformed, headConstraints: malformed, resourceDeltas: [] }),
    "I7:invalid_constraint:AUTHORITY:R1",
    "legacy malformed constraint item",
  );
});

console.log("compiler-only scoped Constraint witnesses loaded");
