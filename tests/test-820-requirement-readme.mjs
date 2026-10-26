import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProjectionCheck } from "../dist/projection-check.mjs";
import { loadNativeRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { renderDocumentation, expectedProjectionState, verifyDocumentation } from "../scripts/self-host-docs.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const runner=resolve(root,"dist/repo-guard.mjs");
const STATE=".repo-guard/projections.json", MODEL=".repo-guard/readme-model.json";
const README="README.md", CLI="docs/cli-reference.md", RUNTIME="dist/repo-guard.mjs", RENDERER="scripts/self-host-docs.mjs";
const read=(path)=>readFileSync(resolve(root,path),"utf8");
const requirementIds=JSON.parse(read(MODEL)).requirement_ids;
const requirementPaths=requirementIds.map((id)=>"requirements/repo-guard/"+id+".rg.yaml");
const stateRaw=read(STATE), state=JSON.parse(stateRaw);
const readmeEntry=state.entries.find((entry)=>entry.model.id==="repo-guard.docs.readme");
assert.ok(readmeEntry);

function reader(overrides=new Map()){
  return (path)=>{
    if(overrides.has(path)) return overrides.get(path);
    const absolute=resolve(root,path);
    return existsSync(absolute)?readFileSync(absolute,"utf8"):null;
  };
}
function native(overrides=new Map()){
  const get=reader(overrides);
  const result=loadNativeRequirements({
    repository:"netkeep80/repo-guard",revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    paths:requirementPaths,readFile:(_revision,path)=>get(path),
  });
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  return result;
}
function projectionReport(overrides=new Map()){
  const get=reader(overrides), requirements=native(overrides);
  return evaluateProjectionCheck({
    baseRaw:stateRaw,headRaw:stateRaw,readHead:get,
    facts:{readFile:get,diff:{files:{checked:[]}}},
    resolveRequirement:(id)=>requirements.index[id]?{digest:requirements.index[id].semantic.digest,path:requirements.index[id].source.path}:null,
  });
}
function readmeAnalysis(report){
  const item=report.analyses.find((x)=>x.projection_id===readmeEntry.model.id);
  assert.ok(item); return item;
}
function rendererOutputs(){
  return JSON.parse(execFileSync(process.execPath,[resolve(root,RENDERER),"--outputs"],{cwd:root,encoding:"utf8"}));
}
function fixture(fn){
  const dir=mkdtempSync(join(tmpdir(),"repo-guard-820-"));
  const put=(path,content)=>{mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),content);};
  const git=(...args)=>execFileSync("git",args,{cwd:dir,encoding:"utf8"}).trim();
  const commit=(message)=>{git("add","-A");git("-c","user.name=#820 Fixture","-c","user.email=820@example.invalid","commit","-qm",message);return git("rev-parse","HEAD");};
  const runBuild=(base,head,outputs)=>{
    const outputPath=join(tmpdir(),"repo-guard-820-output-"+process.pid+"-"+Date.now()+".json");
    writeFileSync(outputPath,JSON.stringify(outputs));
    const result=spawnSync(process.execPath,[runner,"--repo-root",dir,"build","--base",base,"--head",head,"--outputs",outputPath],{cwd:dir,encoding:"utf8",env:{PATH:process.env.PATH}});
    rmSync(outputPath,{force:true}); return result;
  };
  try{
    git("init","-q","-b","main"); git("remote","add","origin","https://github.com/netkeep80/repo-guard.git");
    for(const path of [STATE,MODEL,README,CLI,RUNTIME,RENDERER,...requirementPaths]) put(path,read(path));
    return fn({dir,put,git,commit,runBuild});
  }finally{rmSync(dir,{recursive:true,force:true});}
}

test("#820 F1 normative Requirement semantic change makes README STALE",()=>{
  const path=requirementPaths[0];
  const changed=read(path).replace("Независимая проверка принятого состояния","Независимая проверка принятого состояния — changed fixture");
  assert.equal(readmeAnalysis(projectionReport(new Map([[path,changed]]))).freshness,"STALE");
});
test("#820 F1 rebuild after normative change restores CURRENT output",()=>{
  const path=requirementPaths[0];
  fixture(({dir,put,commit,runBuild})=>{
    commit("accepted requirement-driven README");
    put(path,read(path).replace("Независимая проверка принятого состояния","Независимая проверка принятого состояния — rebuilt fixture"));
    const changed=commit("change canonical Requirement semantics");
    const outputs=renderDocumentation(dir);
    put(STATE,JSON.stringify(expectedProjectionState(dir,outputs),null,2)+"\n");
    const regenerated=commit("regenerate Projection state");
    const result=runBuild(changed,regenerated,outputs);
    assert.equal(result.status,0,result.stderr);
    assert.equal(readFileSync(join(dir,README),"utf8"),outputs[readmeEntry.model.id]);
    assert.equal(verifyDocumentation(dir),true);
  });
});
test("#820 F2 serialization-only Requirement edit stays CURRENT",()=>{
  const path=requirementPaths[0];
  assert.equal(readmeAnalysis(projectionReport(new Map([[path,"# representation-only comment\n"+read(path)]]))).freshness,"CURRENT");
});
test("#820 F3 manual generated README drift is BROKEN",()=>{
  assert.equal(readmeAnalysis(projectionReport(new Map([[README,read(README)+"\nmanual drift\n"]]))).freshness,"BROKEN");
});
test("#820 F4 document model change makes README STALE",()=>{
  const value=JSON.parse(read(MODEL)); value.readme.roadmap_text+=" fixture";
  assert.equal(readmeAnalysis(projectionReport(new Map([[MODEL,JSON.stringify(value,null,2)+"\n"]]))).freshness,"STALE");
});
test("#820 F4 rebuild after document model change restores CURRENT output",()=>{
  fixture(({dir,put,commit,runBuild})=>{
    commit("accepted document model");
    const value=JSON.parse(read(MODEL)); value.readme.roadmap_text+=" rebuilt fixture";
    put(MODEL,JSON.stringify(value,null,2)+"\n");
    const changed=commit("change README presentation model");
    const outputs=renderDocumentation(dir);
    put(STATE,JSON.stringify(expectedProjectionState(dir,outputs),null,2)+"\n");
    const regenerated=commit("regenerate document Projection state");
    const result=runBuild(changed,regenerated,outputs);
    assert.equal(result.status,0,result.stderr);
    assert.equal(readFileSync(join(dir,README),"utf8"),outputs[readmeEntry.model.id]);
    assert.equal(verifyDocumentation(dir),true);
  });
});
test("#820 F5 declared CLI runtime fact change makes README STALE",()=>{
  assert.equal(readmeAnalysis(projectionReport(new Map([[RUNTIME,read(RUNTIME)+"\n// fixture runtime change\n"]]))).freshness,"STALE");
});
test("#820 F6 deterministic renderer and GENERATED materialization are idempotent",()=>{
  const first=rendererOutputs(), second=rendererOutputs(); assert.deepEqual(first,second);
  fixture(({dir,put,commit,runBuild})=>{
    const base=commit("accepted generated docs");
    put(README,read(README)+"\nmanual drift\n");
    const drift=commit("drift README");
    const repair=runBuild(base,drift,first); assert.equal(repair.status,0,repair.stderr);
    assert.equal(readFileSync(join(dir,README),"utf8"),first[readmeEntry.model.id]);
    const repaired=commit("repair README");
    const replay=runBuild(repaired,repaired,first); assert.equal(replay.status,0,replay.stderr);
    assert.equal(JSON.parse(replay.stdout).idempotent,true);
  });
});
test("#820 F7 canonical Requirements are the only normative prose authority",()=>{
  assert.equal(existsSync(resolve(root,"docs/product-requirements.md")),false);
  const modelText=read(MODEL), requirements=native();
  for(const path of requirementPaths){
    const id=path.match(/RG-\d+/)[0], normative=requirements.index[id].normative;
    assert.ok(read(README).includes(normative.trimEnd()));
    assert.equal(modelText.includes(normative.slice(0,Math.min(80,normative.length))),false);
  }
});
test("#820 F8 Requirement documents relation grants no README writer",()=>{
  const outputs=rendererOutputs();
  fixture(({dir,put,commit,runBuild})=>{
    const accepted=commit("accepted generated README");
    const current=JSON.parse(read(STATE));
    current.entries=current.entries.filter((entry)=>entry.model.id!==readmeEntry.model.id);
    put(STATE,JSON.stringify(current,null,2)+"\n");
    const noWriter=commit("remove README writer");
    const before=readFileSync(join(dir,README),"utf8");
    const result=runBuild(accepted,noWriter,outputs);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/unowned generated output/);
    assert.equal(readFileSync(join(dir,README),"utf8"),before);
  });
});
test("#820 declaration uses canonical Requirement SubjectRefs and whole-file GENERATED README",()=>{
  assert.equal(readmeEntry.model.target.ownership,"generated");
  assert.equal(readmeEntry.model.target.path,README);
  const subjects=readmeEntry.model.sources.filter((x)=>x.kind==="repository_subject").map((x)=>x.subject);
  assert.deepEqual(subjects,requirementIds.map((id)=>({kind:"requirement",id})));
  for(const source of readmeEntry.model.sources.filter((x)=>x.kind==="repository_subject")) assert.equal("representation" in source,false);
});
