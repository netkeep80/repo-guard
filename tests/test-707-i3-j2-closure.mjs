import test from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
const repo="netkeep80/repo-guard",sha="a".repeat(40);
const req=(id,parents=[],extra={})=>({id,relations:Object.fromEntries(parents.map((p,i)=>["p"+i,{predicate:"derives_from",target:{kind:"requirement",id:p}}])),...extra});
const load=(documents)=>loadCanonicalRequirements({repository:repo,revision:sha,paths:documents.map(x=>"requirements/"+x.id+".json"),readFile:(_,path)=>JSON.stringify(documents.find(x=>path==="requirements/"+x.id+".json"))});
const root=(universe,id)=>({...universe.index[id].semantic});
const evaluate=(docs,roots=[],extra={})=>{const universe=load(docs);return evaluateRootedRequirements({requirements:universe,trustedRoots:roots.map(id=>typeof id==="string"?root(universe,id):id),...extra})};
test("J2 RED unrooted two-node SCC must not self-root",()=>{const x=evaluate([req("A",["B"]),req("B",["A"])]);assert.equal(x.ok,false);assert.deepEqual(x.unrooted,["A","B"])});
test("J2-01..07 direct root, chain, diamond, existence OR",()=>{
 const d=[req("ROOT"),req("A",["ROOT"]),req("B",["A"]),req("C",["A","B"]),req("D",["ROOT","C"])];
 const x=evaluate(d,["ROOT"]);assert.equal(x.ok,true);assert.deepEqual(x.rooted,["A","B","C","D","ROOT"]);
 assert.deepEqual(x.explanations.C,["ROOT","A","C"]);
 assert.equal(evaluate([req("X")]).ok,false);
 assert.equal(evaluate([req("R1"),req("R2"),req("CHILD",["R1","R2"])],["R1"]).ok,false);
});
test("J2-08..17 only derives_from is bearing; unrooted SCC and rooted SCC",()=>{
 for(const predicate of ["depends_on","constrains","supersedes","verified_by","implemented_by","documents"]){
  const d=[req("ROOT"),req("X",[],{relations:{edge:{predicate,target:{kind:"requirement",id:"ROOT"}}}})];
  assert.deepEqual(evaluate(d,["ROOT"]).unrooted,["X"]);
 }
 assert.equal(evaluate([req("A",["A"])]).ok,false);
 assert.equal(evaluate([req("A",["B"]),req("B",["C"]),req("C",["A"])]).ok,false);
 assert.equal(evaluate([req("ROOT"),req("A",["ROOT","B"]),req("B",["A"] )],["ROOT"]).ok,true);
 assert.deepEqual(evaluate([req("ROOT"),req("A",["ROOT"]),req("ORPHAN")],["ROOT"]).unrooted,["ORPHAN"]);
});
test("J2-18..29 dangling targets, self-root attacks, stale/different roots",()=>{
 assert.equal(evaluate([req("A",["MISSING"])]).ok,false);
 assert.ok(evaluate([req("A",["MISSING"])]).errors.some(x=>x.code==="missing_requirement_target"));
 for(const field of ["root","trusted","accepted"]) assert.equal(evaluate([req("FAKE",[],{[field]:true})]).ok,false);
 const original=load([req("ROOT")]), old=root(original,"ROOT");
 assert.equal(evaluate([req("ROOT",[],{statement:"mutated"})],[old]).ok,false);
 assert.equal(evaluate([req("ROOT")],[{...old,repository:"other/repo"}]).ok,false);
 assert.equal(evaluate([req("ROOT")],[{...old,requirementId:"ABSENT"}]).ok,false);
 const moved=loadCanonicalRequirements({repository:repo,revision:sha,paths:["requirements/moved/ROOT.json"],readFile:()=>JSON.stringify(req("ROOT"))});
 const y=evaluateRootedRequirements({requirements:moved,trustedRoots:[old]});
 assert.equal(y.ok,true);assert.equal(y.explanations.ROOT[0],"ROOT");
});
test("J2-30..40 rooted is not transition permission; input order invariant",()=>{
 const d=[req("ROOT"),req("A",["ROOT"]),req("B",["A"]),req("C",["A","B"])];
 const x=evaluate(d,["ROOT"]);assert.equal(x.ok,true);
 for(const forbidden of ["authorized","accepted","current","trusted","cause","affected","justified","domain_pass"])assert.equal(forbidden in x,false);
 const y=evaluate([...d].reverse(),["ROOT"]);
 assert.deepEqual(x,y);
});

test("J2-35..40 exact root and provenance permutations, shortest canonical root proof",()=>{
 const documents=[req("A"),req("B"),req("C",["B","A"]),req("D",["C"])];
 const base=evaluate(documents,["B","A"]);
 const permuted=evaluate([...documents].reverse(),["A","B"]);
 assert.deepEqual(base,permuted);
 assert.deepEqual(base.explanations.C,["A","C"]);
 assert.deepEqual(base.explanations.D,["A","C","D"]);
 const permutedEdges=[req("A"),req("B"),req("C",["A","B"]),req("D",["C"])];
 assert.deepEqual(base,evaluate(permutedEdges,["A","B"]));
});
