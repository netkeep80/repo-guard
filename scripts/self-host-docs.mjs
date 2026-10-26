#!/usr/bin/env node
// #820 consumer renderer: canonical Requirements + project presentation model -> generic Projection outputs.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProjectionModel, projectionModelIdentity } from "../dist/projection-model.mjs";
import { loadNativeRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { COMMANDS } from "../dist/repo-guard.mjs";

const moduleRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const MODEL=".repo-guard/readme-model.json";
const STATE=".repo-guard/projections.json";
const REQDIR="requirements/repo-guard";
const REPOSITORY="netkeep80/repo-guard";
const REVISION="0000000000000000000000000000000000000000";
const README_ID="repo-guard.docs.readme";
const CLI_ID="repo-guard.docs.cli-reference";
const CONTRACT="repo-guard-doc-self-host/v2";
const TOOL="repo-guard/docs-self-host@2";
const sha=(value)=>createHash("sha256").update(value,"utf8").digest("hex");
const read=(root,path)=>readFileSync(resolve(root,path),"utf8");

function documentModel(root){
  const value=JSON.parse(read(root,MODEL));
  if(value?.schema!=="repo-guard/readme-model/v1") throw new Error("invalid README document model schema");
  if(!Array.isArray(value.requirement_ids)||value.requirement_ids.length===0||
     new Set(value.requirement_ids).size!==value.requirement_ids.length) throw new Error("invalid README Requirement inventory");
  if(!value.readme||!value.cli) throw new Error("README model requires presentation sections");
  return value;
}
function requirements(root,ids){
  const paths=readdirSync(resolve(root,REQDIR),{withFileTypes:true})
    .filter((entry)=>entry.isFile()&&/\.rg\.(?:yaml|json)$/.test(entry.name))
    .map((entry)=>REQDIR+"/"+entry.name).sort();
  const native=loadNativeRequirements({
    repository:REPOSITORY,revision:REVISION,paths,
    readFile:(_revision,path)=>read(root,path),
  });
  if(!native.ok) throw new Error("invalid canonical Requirements: "+native.errors.map((x)=>x.code+":"+x.path).join(","));
  return ids.map((id)=>{
    const item=native.index[id];
    if(!item) throw new Error("unknown README Requirement "+id);
    if(typeof item.normative!=="string") throw new Error("README requires textual normative value for "+id);
    return item;
  });
}
function commandModel(value){
  const commands=[...COMMANDS].sort();
  const descriptions=value.cli.descriptions||{}, examples=value.cli.examples||{};
  if(commands.some((name)=>typeof descriptions[name]!=="string"||typeof examples[name]!=="string")) throw new Error("README model misses current CLI command");
  if(Object.keys(descriptions).some((name)=>!commands.includes(name))||Object.keys(examples).some((name)=>!commands.includes(name))) throw new Error("README model contains retired CLI command");
  return commands.map((name)=>({name,description:descriptions[name],example:examples[name]}));
}
const ticks=String.fromCharCode(96).repeat(3);
const tick=String.fromCharCode(96);
const fenced=(language,lines)=>[ticks+language,...lines,ticks];

export function renderDocumentation(root=moduleRoot){
  const value=documentModel(root);
  const reqs=requirements(root,value.requirement_ids);
  const commands=commandModel(value);
  const r=value.readme;
  const architecture=[ticks+"text",...r.architecture.map((item,index)=>index===0?item:"+ "+item),ticks];
  const requirementText=reqs.map((item)=>item.normative.trimEnd()).join("\n\n");
  const commandSections=commands.flatMap((item)=>[
    "### "+tick+item.name+tick,"",item.description,"",...fenced("bash",[item.example]),"",
  ]);
  const readme=[
    "# "+r.title,"",r.intro,"",...architecture,"",
    "## "+r.requirements_heading,"",r.requirements_intro,"",requirementText,"",
    "## "+r.commands_heading,"",...commandSections,
    "## "+r.action_heading,"",r.action_intro,"",...fenced("yaml",r.action_example),"",
    "## "+r.projection_heading,"",r.projection_intro,"",
    "## "+r.development_heading,"",...fenced("bash",r.development_commands),"",
    r.roadmap_text+" [#"+r.roadmap_issue+"](https://github.com/netkeep80/repo-guard/issues/"+r.roadmap_issue+").","",
  ].join("\n");
  const cli=["# Команды RepoGuard","","Этот файл является GENERATED Projection из текущего CLI inventory и project-owned presentation model.","",...commandSections].join("\n");
  return {[README_ID]:readme,[CLI_ID]:cli};
}
function digestMap(root,ids){return Object.fromEntries(requirements(root,ids).map((item)=>[item.id,item.semantic.digest]));}
function identity(root,source,digests){
  if(source.kind==="repository_content") return {source_id:source.id,algorithm:"sha256",digest:sha(read(root,source.path))};
  if(source.kind==="repository_subject"&&source.subject.kind==="requirement"){
    const digest=digests[source.subject.id];
    if(!digest) throw new Error("Projection references Requirement outside document model: "+source.subject.id);
    return {source_id:source.id,algorithm:"sha256",digest};
  }
  throw new Error("unsupported self-host Projection source "+source.id);
}
export function expectedProjectionState(root=moduleRoot,outputs=renderDocumentation(root)){
  const data=documentModel(root), digests=digestMap(root,data.requirement_ids);
  const declared=JSON.parse(read(root,STATE));
  if(declared.schema!=="repo-guard/projection-check/v0"||!Array.isArray(declared.entries)) throw new Error("invalid self-host Projection declaration");
  return {
    schema:declared.schema,
    entries:declared.entries.map((record)=>{
      if(record.state!=="live") return record;
      const model=normalizeProjectionModel(record.model), payload=outputs[model.id];
      if(typeof payload!=="string") throw new Error("unknown documentation Projection "+model.id);
      return {
        state:"live",model,
        build:{
          schema:"repo-guard/projection-build-record/v0",
          projection_id:model.id,
          model_identity:projectionModelIdentity(model),
          source_identities:model.sources.map((source)=>identity(root,source,digests)),
          generator:{contract_id:model.generator.contract_id,tool_identity:TOOL},
          configuration_digest:sha(CONTRACT),
          output_identity:{algorithm:"sha256",digest:sha(payload)},
          evidence:[],
        },
        current_generator:{tool_identity:TOOL,configuration_digest:sha(CONTRACT)},
      };
    }),
  };
}
export function verifyDocumentation(root=moduleRoot){
  const outputs=renderDocumentation(root);
  const declared=JSON.parse(read(root,STATE));
  const expected=expectedProjectionState(root,outputs);
  if(JSON.stringify(declared)!==JSON.stringify(expected)) throw new Error("stale self-host Projection BuildRecord; regenerate --state");
  for(const record of expected.entries){
    if(record.state!=="live") continue;
    if(read(root,record.model.target.path)!==outputs[record.model.id]) throw new Error("stale generated documentation bytes: "+record.model.target.path);
  }
  return true;
}
const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  const outputs=renderDocumentation();
  const command=process.argv[2]||"--outputs";
  if(command==="--outputs") process.stdout.write(JSON.stringify(outputs)+"\n");
  else if(command==="--state") process.stdout.write(JSON.stringify(expectedProjectionState(moduleRoot,outputs),null,2)+"\n");
  else if(command==="--check"){verifyDocumentation();console.log("Real RepoGuard documentation projections: CURRENT");}
  else throw new Error("Expected --outputs, --state or --check");
}
