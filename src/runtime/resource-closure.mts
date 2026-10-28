import { normalizeDocumentFact } from "../document-facts.mjs";
import { decodeUtf8Strict } from "../utils/repository-files.mjs";
import { strictCanonicalJson, type CanonicalRequirementsResult } from "./canonical-requirements.mjs";
import type { RootedRequirementResult } from "./requirement-closure.mjs";

export interface ResourceLink { from: string; kind: "generates"; to: string; }
export interface ResourceCollectionOwnership {
  owner: string;
  predicate: string;
  manifest: string;
  schema: "repo-guard/resource-collection/v0";
  members: readonly string[];
}
export interface ResourceClosureInput {
  repository: string; revision: string;
  requirements: CanonicalRequirementsResult;
  j2: RootedRequirementResult;
  trackedPaths: readonly string[];
  resourceRelations?: readonly ResourceLink[];
  resolver: {
    resolve(
      ref: unknown,
      options?: { durable?: boolean; expectedRevision?: string },
    ): { ok: boolean; value?: unknown; error?: { code: string } };
  };
}
export interface ResourceClosureError { code: string; path: string; target?: string; }
const direct = new Set(["requires","implemented_by","verified_by","documents","generates"]);
const collectionDirect = new Set(["requires","implemented_by","verified_by","documents"]);
const collectionSchema = "repo-guard/resource-collection/v0" as const;
const norm = (path: unknown): string => {
  if (typeof path !== "string" || path.length === 0) throw new Error("path must be non-empty string");
  const normalized = normalizeDocumentFact(path,"repository_path");
  if (normalized !== path || /[*?\[\]{}]/.test(path) || path.endsWith("/"))
    throw new Error("noncanonical or wildcard resource target");
  return path;
};
const obj = (v: unknown): Record<string,unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : null;
const resolvedArtifact = (input: ResourceClosureInput, path: string): Record<string,unknown> | null => {
  const resolved=input.resolver.resolve({kind:"artifact",path});
  if(!resolved.ok) return null;
  const result=obj(resolved.value), representation=obj(result?.representation);
  if(result?.kind!=="resolved_artifact" || representation?.repository!==input.repository ||
    representation.revision!==input.revision || representation.path!==path) return null;
  return result;
};
const exactArtifact = (input: ResourceClosureInput, path: string): boolean =>
  resolvedArtifact(input,path)!==null;
const artifactText = (input: ResourceClosureInput, path: string, label: string): string | null => {
  const bytes=resolvedArtifact(input,path)?.bytes;
  if(typeof bytes==="string")return bytes;
  if(bytes instanceof Uint8Array)return decodeUtf8Strict(bytes,label);
  return null;
};
const typedCollectionBytes = (raw: string): boolean => {
  try {
    const parsed=obj(JSON.parse(raw));
    return parsed?.schema===collectionSchema;
  } catch {
    return false;
  }
};
const score=(v:string[])=>v.length.toString().padStart(8,"0")+"\0"+v.join("\0");
export function evaluateTrackedResourceClosure(input: ResourceClosureInput) {
  const errors:ResourceClosureError[]=[];
  const tracked=new Set<string>();
  for(const path of input.trackedPaths) {
    try {tracked.add(norm(path));}catch {errors.push({code:"invalid_tracked_path",path:String(path)})}
  }
  const just=new Map<string,string[]>();
  const owners=new Map<string,Set<string>>();
  const links=new Map<string,{kind:string;to:string}[]>();
  const collections:ResourceCollectionOwnership[]=[];
  const collectionCache=new Map<string,
    {ok:true;members:string[]} |
    {ok:false;code:"invalid_resource_collection"|"missing_resource_target"|"nested_resource_collection";target?:string}>();
  const parseCollection=(manifest:string) => {
    const cached=collectionCache.get(manifest);
    if(cached)return cached;
    let raw:string|null=null;
    let root:Record<string,unknown>|null=null;
    try {
      raw=artifactText(input,manifest,`resource collection "${manifest}"`);
      if(raw===null) throw new Error("resource collection bytes unavailable");
      root=obj(strictCanonicalJson(raw));
    } catch {
      const failure={ok:false as const,code:"invalid_resource_collection" as const,target:manifest};
      collectionCache.set(manifest,failure); return failure;
    }
    if(!root || Object.keys(root).sort().join(",")!=="members,schema" ||
      root.schema!==collectionSchema || !Array.isArray(root.members) ||
      root.members.length>tracked.size || root.members.some(member=>typeof member!=="string")) {
      const failure={ok:false as const,code:"invalid_resource_collection" as const,target:manifest};
      collectionCache.set(manifest,failure); return failure;
    }
    const members:string[]=[];
    for(const rawMember of root.members as unknown[]) {
      let member:string;
      try {member=norm(rawMember);} catch {
        const failure={ok:false as const,code:"invalid_resource_collection" as const,target:String(rawMember)};
        collectionCache.set(manifest,failure); return failure;
      }
      members.push(member);
    }
    if(new Set(members).size!==members.length ||
      members.some((member,index)=>index>0 && members[index-1]!.localeCompare(member,"en")>=0)) {
      const failure={ok:false as const,code:"invalid_resource_collection" as const,target:manifest};
      collectionCache.set(manifest,failure); return failure;
    }
    for(const member of members) {
      if(member===manifest) {
        const failure={ok:false as const,code:"nested_resource_collection" as const,target:member};
        collectionCache.set(manifest,failure); return failure;
      }
      if(!tracked.has(member)||!exactArtifact(input,member)) {
        const failure={ok:false as const,code:"missing_resource_target" as const,target:member};
        collectionCache.set(manifest,failure); return failure;
      }
      let memberText:string|null=null;
      try {
        memberText=artifactText(input,member,`resource collection probe "${member}"`);
      } catch {
        memberText=null;
      }
      if(memberText!==null && typedCollectionBytes(memberText)) {
        const failure={ok:false as const,code:"nested_resource_collection" as const,target:member};
        collectionCache.set(manifest,failure); return failure;
      }
    }
    const result={ok:true as const,members};
    collectionCache.set(manifest,result);
    return result;
  };
  const add=(path:string,proof:string[],owner:string)=>{
    const prior=just.get(path);
    if(!prior || score(proof)<score(prior))just.set(path,proof);
    if(!owners.has(path))owners.set(path,new Set());
    owners.get(path)!.add(owner);
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
        const relation=obj(relations![key]);
        if(!relation)continue;
        const predicate=String(relation.predicate);
        const target=obj(relation.target);
        if(target?.kind==="document") {
          if(relation.collection===true) {
            errors.push({code:"invalid_resource_collection",path:id,target:key}); continue;
          }
          const resolved=input.resolver.resolve(target,{durable:true});
          if(!resolved.ok) {
            const code=typeof resolved.error?.code==="string" ? resolved.error.code : "invalid_ref";
            const path=typeof target.path==="string" ? target.path : key;
            const pointer=typeof target.pointer==="string" ? target.pointer : "";
            errors.push({code:"document_ref_"+code,path:id,target:path+pointer});
          }
          continue;
        }
        if(!direct.has(predicate))continue;
        if(relation.collection!==undefined && typeof relation.collection!=="boolean") {
          errors.push({code:"invalid_resource_collection",path:id,target:key}); continue;
        }
        if(!target || target.kind!=="artifact") {
          if(relation.collection===true)errors.push({code:"invalid_resource_collection",path:id,target:key});
          continue;
        }
        let path:string;
        try {path=norm(target.path)}catch {errors.push({code:"unsafe_resource_target",path:id,target:key});continue}
        if(!tracked.has(path) || !exactArtifact(input,path)) {
          errors.push({code:"missing_resource_target",path:id,target:path});continue;
        }
        const directProof=[...proof,predicate+":"+path];
        add(path,directProof,id);
        if(relation.collection===true) {
          if(!collectionDirect.has(predicate)) {
            errors.push({code:"invalid_resource_collection",path:id,target:key}); continue;
          }
          const parsed=parseCollection(path);
          if(!parsed.ok) {
            errors.push({code:parsed.code,path,target:parsed.target}); continue;
          }
          collections.push({owner:id,predicate,manifest:path,schema:collectionSchema,members:[...parsed.members]});
          for(const member of parsed.members)
            add(member,[...directProof,"collection:"+collectionSchema,"member:"+member],id);
        }
      }
    }
    for(const edge of input.resourceRelations||[]) {
      if(edge.kind!=="generates") {errors.push({code:"unsupported_resource_relation",path:String(edge.from)});continue}
      let from:string,to:string;
      try {from=norm(edge.from);to=norm(edge.to)}catch {errors.push({code:"unsafe_resource_target",path:String(edge.from)});continue}
      if(!tracked.has(from)||!tracked.has(to) || !exactArtifact(input,to) || !exactArtifact(input,from)) {
        errors.push({code:"missing_resource_target",path:from,target:to});continue;
      }
      if(!links.has(from))links.set(from,[]);
      links.get(from)!.push({kind:"generates",to});
    }
    let changed=true;
    while(changed) {
      changed=false;
      for(const from of [...links.keys()].sort()) {
        if(!just.has(from))continue;
        for(const edge of links.get(from)!.sort((a,b)=>a.to.localeCompare(b.to))) {
          const proof=[...just.get(from)!,"generates:"+edge.to],prior=just.get(edge.to);
          if(!prior||score(proof)<score(prior)) {just.set(edge.to,proof);changed=true}
          const priorOwners=owners.get(edge.to)||new Set<string>();
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
  collections.sort((a,b)=>
    a.owner.localeCompare(b.owner,"en") ||
    a.predicate.localeCompare(b.predicate,"en") ||
    a.manifest.localeCompare(b.manifest,"en"));
  return {ok:errors.length===0&&unjustified.length===0,justified,unjustified,errors,
    explanations:Object.fromEntries([...just.entries()].sort(([a],[b])=>a.localeCompare(b))),
    owners:Object.fromEntries([...owners.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,[...v].sort()])),
    collections};
}
