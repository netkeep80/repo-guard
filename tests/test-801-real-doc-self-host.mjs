import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const read=(path)=>readFileSync(join(root,path),"utf8");
const runner=join(root,"dist/repo-guard.mjs");
const renderer=join(root,"scripts/self-host-docs.mjs");
const reqs=Array.from({length:8},(_,i)=>"requirements/repo-guard/RG-0"+(i+1)+".rg.yaml");
const snapshot=["README.md","RELEASING.md","docs/cli-reference.md","dist/repo-guard.mjs",".repo-guard/projections.json",".repo-guard/readme-model.json","scripts/self-host-docs.mjs",...reqs];
const original=JSON.parse(read(".repo-guard/projections.json"));
const outputs=JSON.parse(execFileSync(process.execPath,[renderer,"--outputs"],{cwd:root,encoding:"utf8"}));
const live=original.entries.filter((entry)=>entry.state==="live");
const readme=live.find((entry)=>entry.model.target.path==="README.md");
const cli=live.find((entry)=>entry.model.target.path==="docs/cli-reference.md");
assert.ok(readme&&cli); assert.equal(live.length,2); assert.ok(live.every((entry)=>entry.model.target.ownership==="generated"));

function environment(fn){
  const dir=mkdtempSync(join(tmpdir(),"repo-guard-801-"));
  const git=(...args)=>execFileSync("git",args,{cwd:dir,encoding:"utf8"}).trim();
  const put=(path,value)=>{mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),value);};
  const commit=(message)=>{git("add","-A");git("-c","user.name=Self Host","-c","user.email=selfhost@example.invalid","commit","-qm",message);return git("rev-parse","HEAD");};
  const run=(command,base,head,supplied=outputs)=>{
    const temp=join(tmpdir(),"repo-guard-801-output-"+Date.now()+"-"+Math.random()+".json"); writeFileSync(temp,JSON.stringify(supplied));
    let status=0,out="",error="";
    try{out=execFileSync(process.execPath,[runner,"--repo-root",dir,command,"--base",base,"--head",head,...(command==="build"?["--outputs",temp]:["--format","json"])],{cwd:dir,encoding:"utf8",env:{PATH:process.env.PATH}});}
    catch(failure){status=failure.status??1;out=String(failure.stdout||"");error=String(failure.stderr||"");}
    finally{rmSync(temp,{force:true});}
    return {status,out,error,result:status===0?JSON.parse(out):null};
  };
  try{
    git("init","-q","-b","main");git("remote","add","origin","https://github.com/netkeep80/repo-guard.git");
    for(const path of snapshot) put(path,read(path));
    return fn({dir,git,put,commit,run});
  }finally{rmSync(dir,{recursive:true,force:true});}
}

test("#801 current real self-host declaration and local renderer are synchronized",()=>{
  const source=readFileSync(renderer,"utf8");
  assert.equal(source.includes("node:http"),false); assert.equal(source.includes("fetch("),false);
  assert.equal(JSON.stringify(JSON.parse(execFileSync(process.execPath,[renderer,"--state"],{cwd:root,encoding:"utf8"}))),JSON.stringify(original));
  assert.match(execFileSync(process.execPath,[renderer,"--check"],{cwd:root,encoding:"utf8"}),/CURRENT/);
  for(const entry of live) assert.equal(read(entry.model.target.path),outputs[entry.model.id]);
});
test("#801 current GENERATED docs repair/replay while SOURCE remains untouched",()=>{
  for(const entry of live) environment(({dir,put,commit,run})=>{
    const source=read("RELEASING.md"), base=commit("accepted generated docs");
    put(entry.model.target.path,"stale generated documentation\n");
    const head=commit("drift output"); assert.notEqual(run("check",base,head).status,0);
    const built=run("build",base,head); assert.equal(built.status,0,built.error);
    for(const current of live) assert.equal(readFileSync(join(dir,current.model.target.path),"utf8"),outputs[current.model.id]);
    assert.equal(readFileSync(join(dir,"RELEASING.md"),"utf8"),source);
    const replay=run("build",base,head); assert.equal(replay.status,0,replay.error); assert.equal(replay.result.idempotent,true);
  });
});
test("#801 retired GENERATED writer uses exact BASE-owned orphan cleanup",()=>{
  environment(({dir,put,commit,run})=>{
    const base=commit("accepted README writer");
    put(".repo-guard/projections.json",JSON.stringify({schema:original.schema,entries:original.entries.filter((entry)=>entry.model.id!==readme.model.id)},null,2)+"\n");
    const head=commit("retire README writer"); assert.notEqual(run("check",base,head).status,0);
    const result=run("build",base,head,{[cli.model.id]:outputs[cli.model.id]});
    assert.equal(result.status,0,result.error); assert.equal(existsSync(join(dir,"README.md")),false);
    assert.equal(readFileSync(join(dir,cli.model.target.path),"utf8"),outputs[cli.model.id]);
  });
});
test("#801 retained GENERATED output remains without a live writer",()=>{
  environment(({dir,put,commit,run})=>{
    const base=commit("accepted CLI writer");
    put(".repo-guard/projections.json",JSON.stringify({schema:original.schema,entries:original.entries.map((entry)=>entry.model.id===cli.model.id?{state:"retained",model:entry.model}:entry)},null,2)+"\n");
    const head=commit("retain CLI docs");
    const result=run("build",base,head,{[readme.model.id]:outputs[readme.model.id]});
    assert.equal(result.status,0,result.error); assert.equal(result.result.idempotent,true);
    assert.equal(readFileSync(join(dir,cli.model.target.path),"utf8"),read(cli.model.target.path));
  });
});
test("#801 Requirement relation cannot write SOURCE and renderer has no App/service authority",()=>{
  environment(({dir,git,put,commit,run})=>{
    put("requirements/Q.rg.yaml",[
      "format: repo-guard/requirement-v1","id: Q","normative: Documentation relation grants no writer.","relations:",
      "  - predicates: [documents]","    target:","      kind: artifact",'      path: "RELEASING.md"',""
    ].join("\n"));
    const head=commit("SOURCE relation"), before=git("status","--porcelain=v1");
    const bad=run("build",head,head,{...outputs,"not-a-live-writer":"MALICIOUS"});
    assert.notEqual(bad.status,0); assert.equal(readFileSync(join(dir,"RELEASING.md"),"utf8"),read("RELEASING.md")); assert.equal(git("status","--porcelain=v1"),before);
    const valid=run("build",head,head); assert.equal(valid.status,0,valid.error); assert.equal(valid.result.idempotent,true);
  });
});
