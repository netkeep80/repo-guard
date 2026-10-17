import { normalizeDocumentFact } from "../document-facts.mjs";
import type { CanonicalRequirementsResult } from "./canonical-requirements.mjs";
import type { RootedRequirementResult } from "./requirement-closure.mjs";

const direct = new Set(["requires","implemented_by","verified_by","documents","generates"]);
const norm = (path) => {
  if (typeof path !== "string") throw new Error("path must be string");
  const normalized = normalizeDocumentFact(path,"repository_path");
  if (normalized !== path || /[*?\[\]{}]/.test(path) || path.endsWith("/"))
    throw new Error("noncanonical or wildcard resource target");
  return path;
};
const exactArtifact = (input, path) => {
  const resolved=input.resolver.resolve({kind:"artifact",path});
  if(!resolved.ok) return false;
  const result=resolved.value;
  return result?.representation?.repository===input.repository &&
    result.representation.revision===input.revision && result.representation.path===path;
};
const obj = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
const score=(v)=>v.length.toString().padStart(8,"0")+"\0"+v.join("\0");
export function evaluateTrackedResourceClosure(input) {
  const errors=[];
  const tracked=new Set();
  for(const path of input.trackedPaths) {
    try {tracked.add(norm(path));}catch {errors.push({code:"invalid_tracked_path",path:String(path)})}
  }
  const just=new Map();
  const owners=new Map();
  const links=new Map();
  const add=(path,proof,owner:string)=>{
    const prior=just.get(path);
    if(!prior || score(proof)<score(prior))just.set(path,proof);
    if(!owners.has(path))owners.set(path,new Set());
    owners.get(path).add(owner);
  };
  if(!input.requirements.ok || !input.j2.ok)
    errors.push({code:"j2_not_rooted",path:""});
  else {
    const rooted=[...input.j2.rooted].sort();
    for(const id of rooted) {
      const requirement=input.requirements.index[id];
      if(!requirement || requirement.representation.repository!==input.repository ||
        requirement.representation.revision!==input.revision) {
        errors.push({code:"inconsistent_snapshot",path:id}); continue;
      }
      const proof=input.j2.explanations[id]||[id];
      const source=requirement.source.path;
      if(tracked.has(source))add(source,[...proof,"source:"+source],id);
      else errors.push({code:"missing_canonical_source",path:source});
      const relations=obj(obj(requirement.value)?.relations);
      for(const key of Object.keys(relations||{}).sort()) {
        const relation=obj(relations[key]);
        if(!relation || !direct.has(String(relation.predicate)))continue;
        const target=obj(relation.target);
        if(!target || target.kind!=="artifact")continue;
        let path;
        try {path=norm(target.path)}catch {errors.push({code:"unsafe_resource_target",path:id,target:key});continue}
        if(!tracked.has(path) || !exactArtifact(input,path)) {
          errors.push({code:"missing_resource_target",path:id,target:path});continue;
        }
        add(path,[...proof,String(relation.predicate)+":"+path],id);
      }
    }
    for(const edge of input.resourceRelations||[]) {
      if(edge.kind!=="generates") {errors.push({code:"unsupported_resource_relation",path:String(edge.from)});continue}
      let from,to;
      try {from=norm(edge.from);to=norm(edge.to)}catch {errors.push({code:"unsafe_resource_target",path:String(edge.from)});continue}
      if(!tracked.has(from)||!tracked.has(to) || !exactArtifact(input,to) || !exactArtifact(input,from)) {
        errors.push({code:"missing_resource_target",path:from,target:to});continue;
      }
      if(!links.has(from))links.set(from,[]);
      links.get(from).push({kind:"generates",to});
    }
    let changed=true;
    while(changed) {
      changed=false;
      for(const from of [...links.keys()].sort()) {
        if(!just.has(from))continue;
        for(const edge of links.get(from).sort((a,b)=>a.to.localeCompare(b.to))) {
          const proof=[...just.get(from),"generates:"+edge.to],prior=just.get(edge.to);
          if(!prior||score(proof)<score(prior)) {just.set(edge.to,proof);changed=true}
          const priorOwners=owners.get(edge.to)||new Set();
          const n=priorOwners.size;
          for(const owner of owners.get(from)||[])priorOwners.add(owner);
          owners.set(edge.to,priorOwners);
          if(priorOwners.size!==n)changed=true;
        }
      }
    }
  }
  const justified=[...tracked].filter(x=>just.has(x)).sort();
  const unjustified=[...tracked].filter(x=>!just.has(x)).sort();
  errors.sort((a,b)=>a.path.localeCompare(b.path)||a.code.localeCompare(b.code)||(a.target||"").localeCompare(b.target||""));
  return {ok:errors.length===0&&unjustified.length===0,justified,unjustified,errors,
    explanations:Object.fromEntries([...just.entries()].sort(([a],[b])=>a.localeCompare(b))),
    owners:Object.fromEntries([...owners.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,[...v].sort()]))};
}
