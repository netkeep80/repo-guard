import { normalizeDocumentFact } from "../document-facts.mjs";
import type { CanonicalRequirementsResult } from "./canonical-requirements.mjs";
import type { RootedRequirementResult } from "./requirement-closure.mjs";
import type { ParsedDiffFile } from "../diff/parser.mjs";

export type TransitionDeltaKind =
  | "requirement_add" | "requirement_modify" | "requirement_remove" | "requirement_relocate"
  | "relation_add" | "relation_remove" | "relation_replace"
  | "resource_add" | "resource_modify" | "resource_delete" | "resource_rename" | "resource_type_change"
  | "lifecycle";

export interface ResourceDeltaObservation {
  kind: "add" | "modify" | "delete" | "rename" | "type_change";
  path: string;
  previousPath?: string;
  beforeType?: string;
  afterType?: string;
}
export interface TransitionReceipt {
  authorityBaseRevision: string;
  baseRevision: string;
  headRevision: string;
  permissions: readonly string[];
}
export interface TransitionEvidenceFact {
  authorityBaseRevision: string;
  baseRevision: string;
  headRevision: string;
  key: string;
  status: "pass" | "fail";
}
export interface TransitionCauseRule {
  authorityRevision: string;
  requirementId: string;
  deltaKinds?: readonly TransitionDeltaKind[];
  relationPredicates?: readonly string[];
  paths?: readonly string[];
  requireAddressed?: boolean;
  evidenceKeys?: readonly string[];
}
export interface WorkIntentFact { id: string; addresses: readonly string[]; [key: string]: unknown; }
export interface TransitionResourceLink { from: string; kind: "generates"; to: string; }
export interface TransitionState {
  revision: string;
  requirements: CanonicalRequirementsResult;
  j2: RootedRequirementResult;
  j1: { ok: boolean; owners: Readonly<Record<string, readonly string[]>> };
  resourceRelations?: readonly TransitionResourceLink[];
}
export interface TrustedAuthorityState {
  revision: string;
  requirements: CanonicalRequirementsResult;
  j2: RootedRequirementResult;
}
export type LifecycleValue = null | boolean | number | string;
export type LifecycleState = Readonly<Record<string, Readonly<Record<string, LifecycleValue>>>>;
export interface TransitionClosureInput {
  repository: string;
  base: TransitionState;
  head: TransitionState;
  trustedAuthorityBase: TrustedAuthorityState;
  resourceDeltas?: readonly ResourceDeltaObservation[];
  baseLifecycle?: LifecycleState;
  headLifecycle?: LifecycleState;
  workIntent?: WorkIntentFact | null;
  trustedReceipts?: readonly TransitionReceipt[];
  protectedResources?: readonly string[];
  evidenceFacts?: readonly TransitionEvidenceFact[];
}

interface RelationFact {
  key: string;
  origin: "requirement" | "resource";
  from: string;
  predicate: string;
  targetKey: string;
  targetRequirement?: string;
  targetPath?: string;
}
interface Delta {
  id: string;
  kind: TransitionDeltaKind;
  subject: string;
  requirementId?: string;
  beforePath?: string;
  afterPath?: string;
  relation?: RelationFact;
  beforeRelation?: RelationFact;
  afterRelation?: RelationFact;
  field?: string;
  before?: LifecycleValue;
  after?: LifecycleValue;
}

const sha = /^[0-9a-f]{40}$/;
const strongRequirementRelations = new Set(["derives_from", "depends_on", "constrains", "supersedes"]);
const protectedLifecycleFields = new Set(["accepted", "current", "published"]);
const allDeltaKinds = new Set<TransitionDeltaKind>([
  "requirement_add", "requirement_modify", "requirement_remove", "requirement_relocate",
  "relation_add", "relation_remove", "relation_replace",
  "resource_add", "resource_modify", "resource_delete", "resource_rename", "resource_type_change", "lifecycle",
]);
const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const normPath = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("path must be a string");
  const normalized = normalizeDocumentFact(value, "repository_path");
  if (normalized !== value || /[*?\[\]{}]/.test(value) || value.endsWith("/")) throw new Error("noncanonical or wildcard path");
  return value;
};
function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const record = obj(value);
  if (record) return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stable(record[key])).join(",") + "}";
  throw new Error("non-canonical transition value");
}
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort((a,b)=>a.localeCompare(b,"en"));
const exactRevision = (value: unknown): value is string => typeof value === "string" && sha.test(value);
const permissionToken = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value !== "*";

function requirementCore(value: unknown): string {
  const root = obj(value);
  if (!root) return stable(value);
  return stable(Object.fromEntries(Object.entries(root).filter(([key]) => key !== "relations")));
}
function targetIdentity(value: unknown): { key: string; requirement?: string; path?: string } {
  const target = obj(value);
  if (!target || typeof target.kind !== "string") throw new Error("relation target must be a typed object");
  if (target.kind === "requirement") {
    if (typeof target.id !== "string" || !target.id) throw new Error("requirement relation target requires id");
    return { key: stable({ kind: "requirement", id: target.id }), requirement: target.id };
  }
  if (target.kind === "artifact") {
    const path = normPath(target.path);
    return { key: stable({ kind: "artifact", path }), path };
  }
  return { key: stable(target) };
}
function relationFactKey(fact: Omit<RelationFact,"key">): string {
  return stable({ origin: fact.origin, from: fact.from, predicate: fact.predicate, target: fact.targetKey });
}
function relations(state: TransitionState): { facts: RelationFact[]; errors: string[] } {
  const facts: RelationFact[] = [], errors: string[] = [];
  for (const id of Object.keys(state.requirements.index).sort((a,b)=>a.localeCompare(b,"en"))) {
    const root = obj(state.requirements.index[id]?.value);
    const relationMap = obj(root?.relations);
    if (root?.relations !== undefined && !relationMap) {
      errors.push("invalid_relation_map:" + id);
      continue;
    }
    for (const label of Object.keys(relationMap || {}).sort((a,b)=>a.localeCompare(b,"en"))) {
      const item = obj(relationMap![label]);
      if (!item || typeof item.predicate !== "string" || item.predicate.length === 0) {
        errors.push(`invalid_relation:${id}:${label}`);
        continue;
      }
      try {
        const target = targetIdentity(item.target);
        const factBase = { origin: "requirement" as const, from: id, predicate: item.predicate, targetKey: target.key,
          ...(target.requirement ? { targetRequirement: target.requirement } : {}), ...(target.path ? { targetPath: target.path } : {}) };
        facts.push({ ...factBase, key: relationFactKey(factBase) });
      } catch (error) {
        errors.push(`invalid_relation:${id}:${label}:${(error as Error).message}`);
      }
    }
  }
  for (const [index, edge] of (state.resourceRelations || []).entries()) {
    if (edge.kind !== "generates") {
      errors.push(`invalid_resource_relation:${index}:unsupported_kind`);
      continue;
    }
    try {
      const from = normPath(edge.from), to = normPath(edge.to);
      const factBase = { origin: "resource" as const, from, predicate: "generates", targetKey: stable({ kind: "artifact", path: to }), targetPath: to };
      facts.push({ ...factBase, key: relationFactKey(factBase) });
    } catch (error) {
      errors.push(`invalid_resource_relation:${index}:${(error as Error).message}`);
    }
  }
  const dedup = new Map<string,RelationFact>();
  for (const fact of facts) {
    if (dedup.has(fact.key)) errors.push("duplicate_relation:" + fact.key);
    else dedup.set(fact.key,fact);
  }
  return { facts: [...dedup.values()].sort((a,b)=>a.key.localeCompare(b.key,"en")), errors: sorted(errors) };
}
function relationDeltas(base: RelationFact[], head: RelationFact[]): Delta[] {
  const before = new Map(base.map(x=>[x.key,x])), after = new Map(head.map(x=>[x.key,x]));
  const removed = base.filter(x=>!after.has(x.key)), added = head.filter(x=>!before.has(x.key));
  const byGroup = (items: RelationFact[]) => {
    const map = new Map<string,RelationFact[]>();
    for (const item of items) {
      const key = stable({origin:item.origin,from:item.from,predicate:item.predicate});
      const values = map.get(key) || []; values.push(item); map.set(key,values);
    }
    for (const values of map.values()) values.sort((a,b)=>a.key.localeCompare(b.key,"en"));
    return map;
  };
  const rGroups=byGroup(removed), aGroups=byGroup(added), usedR=new Set<string>(), usedA=new Set<string>(), out:Delta[]=[];
  for (const group of sorted(new Set([...rGroups.keys(),...aGroups.keys()]))) {
    const rs=rGroups.get(group)||[], as=aGroups.get(group)||[];
    if (rs.length===1 && as.length===1) {
      const r=rs[0]!, a=as[0]!; usedR.add(r.key); usedA.add(a.key);
      out.push({id:"relation_replace:"+r.key+"->"+a.key,kind:"relation_replace",subject:r.from,beforeRelation:r,afterRelation:a,relation:a});
    }
  }
  for (const fact of removed.filter(x=>!usedR.has(x.key))) out.push({id:"relation_remove:"+fact.key,kind:"relation_remove",subject:fact.from,relation:fact});
  for (const fact of added.filter(x=>!usedA.has(x.key))) out.push({id:"relation_add:"+fact.key,kind:"relation_add",subject:fact.from,relation:fact});
  return out.sort((a,b)=>a.id.localeCompare(b.id,"en"));
}
function requirementDeltas(base: TransitionState, head: TransitionState): Delta[] {
  const out:Delta[]=[];
  const ids=sorted(new Set([...Object.keys(base.requirements.index),...Object.keys(head.requirements.index)]));
  for (const id of ids) {
    const before=base.requirements.index[id], after=head.requirements.index[id];
    if (!before) out.push({id:"requirement_add:"+id,kind:"requirement_add",subject:id,requirementId:id});
    else if (!after) out.push({id:"requirement_remove:"+id,kind:"requirement_remove",subject:id,requirementId:id});
    else {
      if (requirementCore(before.value)!==requirementCore(after.value)) out.push({id:"requirement_modify:"+id,kind:"requirement_modify",subject:id,requirementId:id});
      if (before.source.path!==after.source.path) out.push({id:`requirement_relocate:${id}:${before.source.path}->${after.source.path}`,kind:"requirement_relocate",subject:id,requirementId:id,beforePath:before.source.path,afterPath:after.source.path});
    }
  }
  return out;
}
function resourceDeltas(input: readonly ResourceDeltaObservation[]): { deltas: Delta[]; errors: string[] } {
  const out:Delta[]=[], errors:string[]=[];
  for (const raw of input) {
    try {
      const path=normPath(raw.path);
      if (raw.kind==="add" || raw.kind==="modify" || raw.kind==="delete") {
        if (raw.previousPath!==undefined) throw new Error("previousPath is only valid for rename");
        out.push({id:`resource_${raw.kind}:${path}`,kind:`resource_${raw.kind}` as TransitionDeltaKind,subject:path,afterPath:raw.kind!=="delete"?path:undefined,beforePath:raw.kind!=="add"?path:undefined});
      } else if (raw.kind==="rename") {
        const previous=normPath(raw.previousPath);
        if (previous===path) throw new Error("rename requires distinct paths");
        out.push({id:`resource_rename:${previous}->${path}`,kind:"resource_rename",subject:path,beforePath:previous,afterPath:path});
      } else if (raw.kind==="type_change") {
        if (raw.previousPath!==undefined && normPath(raw.previousPath)!==path) throw new Error("type change previousPath must equal path");
        if (raw.beforeType!==undefined && raw.afterType!==undefined && raw.beforeType===raw.afterType) throw new Error("type change requires different types");
        out.push({id:`resource_type_change:${path}`,kind:"resource_type_change",subject:path,beforePath:path,afterPath:path});
      } else throw new Error("unsupported resource delta kind");
    } catch (error) { errors.push(`invalid_resource_delta:${String(raw.path)}:${(error as Error).message}`); }
  }
  const ids=new Set<string>();
  for (const delta of out) { if(ids.has(delta.id)) errors.push("duplicate_resource_delta:"+delta.id); ids.add(delta.id); }
  return {deltas:out.sort((a,b)=>a.id.localeCompare(b.id,"en")),errors:sorted(errors)};
}
export function resourceDeltasFromParsedDiff(files: readonly ParsedDiffFile[]): ResourceDeltaObservation[] {
  return files.map((file) => {
    if (file.previousPath) return { kind: "rename" as const, previousPath: file.previousPath, path: file.path };
    if (file.gitStatus === "T") return { kind: "type_change" as const, path: file.path };
    if (file.status === "added") return { kind: "add" as const, path: file.path };
    if (file.status === "deleted") return { kind: "delete" as const, path: file.path };
    return { kind: "modify" as const, path: file.path };
  });
}

function lifecycleDeltas(base: LifecycleState, head: LifecycleState): Delta[] {
  const out:Delta[]=[];
  for (const subject of sorted(new Set([...Object.keys(base),...Object.keys(head)]))) {
    const before=base[subject]||{}, after=head[subject]||{};
    for (const field of sorted(new Set([...Object.keys(before),...Object.keys(after)]))) {
      const hasBefore=Object.hasOwn(before,field), hasAfter=Object.hasOwn(after,field);
      const b=before[field], a=after[field];
      if (hasBefore===hasAfter && (!hasBefore || stable(b)===stable(a))) continue;
      out.push({id:`lifecycle:${subject}:${field}`,kind:"lifecycle",subject,field,
        ...(hasBefore?{before:b}:{}),...(hasAfter?{after:a}:{}),requirementId:subject});
    }
  }
  return out;
}
function owners(state: TransitionState, path: string | undefined): string[] {
  return path ? sorted(state.j1.owners[path] || []) : [];
}
function directCandidates(delta: Delta, base: TransitionState, head: TransitionState): Set<string> {
  const result=new Set<string>();
  if (delta.kind.startsWith("requirement_") || delta.kind==="lifecycle") {
    if (delta.requirementId) result.add(delta.requirementId);
  } else if (delta.kind.startsWith("resource_")) {
    for (const id of owners(base,delta.beforePath)) result.add(id);
    for (const id of owners(head,delta.afterPath)) result.add(id);
  } else if (delta.kind.startsWith("relation_")) {
    const facts=[delta.beforeRelation,delta.afterRelation,delta.relation].filter(Boolean) as RelationFact[];
    for (const fact of facts) {
      if (fact.origin==="requirement") result.add(fact.from);
      if (fact.targetRequirement) result.add(fact.targetRequirement);
      if (fact.origin==="resource") {
        for (const id of owners(base,fact.from)) result.add(id);
        for (const id of owners(head,fact.from)) result.add(id);
      }
      if (fact.targetPath) {
        for (const id of owners(base,fact.targetPath)) result.add(id);
        for (const id of owners(head,fact.targetPath)) result.add(id);
      }
    }
  }
  return result;
}
function requirementImpact(seed: Iterable<string>, relationFacts: readonly RelationFact[], ids: Set<string>): Set<string> {
  const impacted=new Set([...seed].filter(id=>ids.has(id)));
  let changed=true;
  while(changed) {
    changed=false;
    for (const relation of relationFacts) {
      if (relation.origin!=="requirement" || !relation.targetRequirement || !ids.has(relation.from) || !ids.has(relation.targetRequirement)) continue;
      const target=relation.targetRequirement;
      if (relation.predicate==="derives_from") {
        if (impacted.has(relation.from) && !impacted.has(target)) {impacted.add(target);changed=true;}
        if (impacted.has(target) && !impacted.has(relation.from)) {impacted.add(relation.from);changed=true;}
      } else if ((relation.predicate==="depends_on" || relation.predicate==="constrains") && impacted.has(target) && !impacted.has(relation.from)) {
        impacted.add(relation.from);changed=true;
      }
    }
  }
  return impacted;
}
function affected(delta: Delta, base: TransitionState, head: TransitionState, baseRelations: RelationFact[], headRelations: RelationFact[]): string[] {
  const seed=directCandidates(delta,base,head);
  const baseIds=new Set(Object.keys(base.requirements.index)), headIds=new Set(Object.keys(head.requirements.index));
  return sorted(new Set([...requirementImpact(seed,baseRelations,baseIds),...requirementImpact(seed,headRelations,headIds)]));
}
function deltaPaths(delta: Delta): string[] {
  const paths=[delta.beforePath,delta.afterPath,delta.relation?.targetPath,delta.beforeRelation?.targetPath,delta.afterRelation?.targetPath];
  return sorted(paths.filter((x):x is string=>typeof x==="string"));
}
function deltaPredicate(delta: Delta): string | null {
  return delta.relation?.predicate || delta.afterRelation?.predicate || delta.beforeRelation?.predicate || null;
}
function matchesRule(rule: TransitionCauseRule, delta: Delta): boolean {
  if (rule.deltaKinds && !rule.deltaKinds.includes(delta.kind)) return false;
  const predicate=deltaPredicate(delta);
  if (rule.relationPredicates && (!predicate || !rule.relationPredicates.includes(predicate))) return false;
  if (rule.paths && !deltaPaths(delta).some(path=>rule.paths!.includes(path))) return false;
  return true;
}
function transitionRules(authority: TrustedAuthorityState): { rules: TransitionCauseRule[]; errors: string[] } {
  const rules:TransitionCauseRule[]=[], errors:string[]=[];
  const allowed=new Set(["deltaKinds","relationPredicates","paths","requireAddressed","evidenceKeys"]);
  for (const requirementId of authority.j2.rooted.slice().sort((a,b)=>a.localeCompare(b,"en"))) {
    const requirement=authority.requirements.index[requirementId];
    const raw=obj(obj(requirement?.value)?.transition);
    if (obj(requirement?.value)?.transition===undefined) continue;
    if (!raw) { errors.push("invalid_transition_rule:"+requirementId+":not_object"); continue; }
    const unknown=Object.keys(raw).filter(key=>!allowed.has(key)).sort();
    if (unknown.length) { errors.push("invalid_transition_rule:"+requirementId+":unknown_field:"+unknown[0]); continue; }
    const arrayOfStrings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==="string"&&item.length>0);
    if (raw.deltaKinds!==undefined && (!arrayOfStrings(raw.deltaKinds)||raw.deltaKinds.some(kind=>!allDeltaKinds.has(kind as TransitionDeltaKind)))) {
      errors.push("invalid_transition_rule:"+requirementId+":deltaKinds"); continue;
    }
    if (raw.relationPredicates!==undefined && !arrayOfStrings(raw.relationPredicates)) {
      errors.push("invalid_transition_rule:"+requirementId+":relationPredicates"); continue;
    }
    if (raw.paths!==undefined && !arrayOfStrings(raw.paths)) {
      errors.push("invalid_transition_rule:"+requirementId+":paths"); continue;
    }
    if (raw.requireAddressed!==undefined && typeof raw.requireAddressed!=="boolean") {
      errors.push("invalid_transition_rule:"+requirementId+":requireAddressed"); continue;
    }
    if (raw.evidenceKeys!==undefined && !arrayOfStrings(raw.evidenceKeys)) {
      errors.push("invalid_transition_rule:"+requirementId+":evidenceKeys"); continue;
    }
    if (raw.deltaKinds===undefined && raw.relationPredicates===undefined && raw.paths===undefined) {
      errors.push("invalid_transition_rule:"+requirementId+":unscoped"); continue;
    }
    try { for (const path of (raw.paths as string[]|undefined)||[]) normPath(path); }
    catch { errors.push("invalid_transition_rule:"+requirementId+":path"); continue; }
    rules.push({authorityRevision:authority.revision,requirementId,
      ...(raw.deltaKinds!==undefined?{deltaKinds:[...(raw.deltaKinds as string[])] as TransitionDeltaKind[]}:{}),
      ...(raw.relationPredicates!==undefined?{relationPredicates:[...(raw.relationPredicates as string[])]}:{}),
      ...(raw.paths!==undefined?{paths:[...(raw.paths as string[])]}:{}),
      ...(raw.requireAddressed!==undefined?{requireAddressed:raw.requireAddressed as boolean}:{}),
      ...(raw.evidenceKeys!==undefined?{evidenceKeys:[...(raw.evidenceKeys as string[])]}:{}),
    });
  }
  return {rules:rules.sort((a,b)=>a.requirementId.localeCompare(b.requirementId,"en")),errors:sorted(errors)};
}
function workIntentAddresses(value: WorkIntentFact | null | undefined): { addresses: string[]; errors: string[] } {
  if (value===null || value===undefined) return {addresses:[],errors:[]};
  if (!Array.isArray(value.addresses) || value.addresses.some(id=>typeof id!=="string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(id)))
    return {addresses:[],errors:["invalid_work_intent_addresses"]};
  return {addresses:sorted(value.addresses),errors:[]};
}
function validReceipts(input: TransitionClosureInput): { receipts: TransitionReceipt[]; errors: string[] } {
  const receipts:TransitionReceipt[]=[],errors:string[]=[];
  for(const item of input.trustedReceipts||[]) {
    if (!exactRevision(item.authorityBaseRevision)||!exactRevision(item.baseRevision)||!exactRevision(item.headRevision)||
      !Array.isArray(item.permissions)||item.permissions.some(x=>!permissionToken(x))) {
      errors.push("invalid_trusted_receipt");continue;
    }
    receipts.push(item);
  }
  return {receipts,errors:sorted(errors)};
}
function granted(input: TransitionClosureInput, receipts: readonly TransitionReceipt[], permission: string): boolean {
  return receipts.some(receipt=>receipt.authorityBaseRevision===input.trustedAuthorityBase.revision && receipt.baseRevision===input.base.revision &&
    receipt.headRevision===input.head.revision && receipt.permissions.includes(permission));
}
function validEvidence(input: TransitionClosureInput): { facts: TransitionEvidenceFact[]; errors: string[] } {
  const facts:TransitionEvidenceFact[]=[],errors:string[]=[];
  for(const item of input.evidenceFacts||[]) {
    if (!exactRevision(item.authorityBaseRevision)||!exactRevision(item.baseRevision)||!exactRevision(item.headRevision)||
      typeof item.key!=="string"||!item.key||!['pass','fail'].includes(item.status)) {errors.push("invalid_evidence_fact");continue;}
    facts.push(item);
  }
  return {facts,errors:sorted(errors)};
}
function evidencePass(input: TransitionClosureInput, facts: readonly TransitionEvidenceFact[], key: string): boolean {
  return facts.some(fact=>fact.authorityBaseRevision===input.trustedAuthorityBase.revision && fact.baseRevision===input.base.revision &&
    fact.headRevision===input.head.revision && fact.key===key && fact.status==="pass");
}
function authorityPermissions(delta: Delta, input: TransitionClosureInput, protectedSet: ReadonlySet<string>): string[] {
  const result=new Set<string>();
  if (delta.kind==="requirement_add"||delta.kind==="requirement_modify"||delta.kind==="requirement_remove") result.add("requirement:"+delta.subject);
  if (delta.kind.startsWith("relation_")) {
    const facts=[delta.beforeRelation,delta.afterRelation,delta.relation].filter(Boolean) as RelationFact[];
    const predicate=deltaPredicate(delta);
    const from=facts[0]?.from;
    if (predicate && from && strongRequirementRelations.has(predicate) && facts.some(f=>f.targetRequirement)) {
      result.add("requirement:"+from);
    }
    if (predicate==="requires" && (delta.kind==="relation_remove"||delta.kind==="relation_replace") && from) result.add("requirement:"+from);
  }
  if (delta.kind==="lifecycle" && delta.field && protectedLifecycleFields.has(delta.field) && (delta.before===true || delta.after===true))
    result.add(`lifecycle:${delta.subject}:${delta.field}`);
  for(const path of deltaPaths(delta)) if(protectedSet.has(path) && delta.kind.startsWith("resource_")) result.add("resource:"+path);
  return sorted(result);
}
function snapshotErrors(label:string,state:TrustedAuthorityState|TransitionState,repository:string):string[]{
  const errors:string[]=[];
  if(!exactRevision(state.revision))errors.push(`${label}:invalid_revision`);
  if(!state.requirements.ok)errors.push(`${label}:invalid_requirements`);
  for(const req of state.requirements.requirements) if(req.representation.repository!==repository||req.representation.revision!==state.revision) {errors.push(`${label}:snapshot_mismatch`);break;}
  if(!state.j2.ok)errors.push(`${label}:j2_not_rooted`);
  return errors;
}

export function evaluateTransitionCauseClosure(input: TransitionClosureInput) {
  const reasons:string[]=[];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) reasons.push("input:invalid_repository");
  reasons.push(...snapshotErrors("base",input.base,input.repository));
  reasons.push(...snapshotErrors("head",input.head,input.repository));
  reasons.push(...snapshotErrors("authority_base",input.trustedAuthorityBase,input.repository));
  if(!input.head.j1.ok) reasons.push("head:j1_not_closed");

  const normalizedResources=resourceDeltas(input.resourceDeltas||[]); reasons.push(...normalizedResources.errors.map(x=>"input:"+x));
  const protectedSet=new Set<string>();
  for (const raw of input.protectedResources||[]) {
    try { protectedSet.add(normPath(raw)); } catch (error) { reasons.push("input:invalid_protected_resource:"+String(raw)+":"+(error as Error).message); }
  }
  const baseRelationState=relations(input.base), headRelationState=relations(input.head);
  reasons.push(...baseRelationState.errors.map(x=>"base:"+x),...headRelationState.errors.map(x=>"head:"+x));
  const baseRelations=baseRelationState.facts, headRelations=headRelationState.facts;
  const deltas=[...requirementDeltas(input.base,input.head),...relationDeltas(baseRelations,headRelations),...normalizedResources.deltas,
    ...lifecycleDeltas(input.baseLifecycle||{},input.headLifecycle||{})].sort((a,b)=>a.id.localeCompare(b.id,"en"));

  const ruleState=transitionRules(input.trustedAuthorityBase), rules=ruleState.rules;
  reasons.push(...ruleState.errors.map(x=>"authority_base:"+x));
  const receiptState=validReceipts(input), evidenceState=validEvidence(input), intentState=workIntentAddresses(input.workIntent);
  reasons.push(...receiptState.errors.map(x=>"input:"+x),...evidenceState.errors.map(x=>"input:"+x),...intentState.errors.map(x=>"input:"+x));
  const addresses=new Set(intentState.addresses);
  const authorityRooted=new Set(input.trustedAuthorityBase.j2.rooted);
  const whyChanged:any[]=[]; const affectedAll=new Set<string>();

  for(const delta of deltas) {
    const matchedRules=rules.filter(rule=>matchesRule(rule,delta)).sort((a,b)=>a.requirementId.localeCompare(b.requirementId,"en"));
    const affectedIds=affected(delta,input.base,input.head,baseRelations,headRelations); for(const id of affectedIds)affectedAll.add(id);
    const candidates=directCandidates(delta,input.base,input.head); for(const rule of matchedRules)candidates.add(rule.requirementId);
    const candidateIds=sorted(candidates);
    const causes=candidateIds.filter(id=>addresses.has(id)&&(authorityRooted.has(id)||granted(input,receiptState.receipts,"requirement:"+id)));
    if(!causes.length) reasons.push("J3:no_cause:"+delta.id);

    const permissions=authorityPermissions(delta,input,protectedSet);
    for(const permission of permissions) if(!granted(input,receiptState.receipts,permission)) reasons.push(`J3:missing_authority:${permission}:${delta.id}`);

    const evidenceKeys=sorted(matchedRules.flatMap(rule=>rule.evidenceKeys||[]));
    for(const key of evidenceKeys) if(!evidencePass(input,evidenceState.facts,key)) reasons.push(`J3:missing_evidence:${key}:${delta.id}`);
    for(const rule of matchedRules) if(rule.requireAddressed===true && !addresses.has(rule.requirementId)) reasons.push(`J3:unacknowledged_impact:${rule.requirementId}:${delta.id}`);

    whyChanged.push({id:delta.id,kind:delta.kind,subject:delta.subject,affected:affectedIds,applicable:sorted(new Set([...affectedIds,...matchedRules.map(r=>r.requirementId)])),
      causalCandidates:candidateIds,causes:sorted(causes),requiredAuthority:permissions,requiredEvidence:evidenceKeys});
  }
  const normalizedReasons=sorted(reasons);
  return {ok:normalizedReasons.length===0,reasons:normalizedReasons,deltas:deltas.map(delta=>({id:delta.id,kind:delta.kind,subject:delta.subject,
    ...(delta.beforePath?{beforePath:delta.beforePath}:{}),...(delta.afterPath?{afterPath:delta.afterPath}:{}),...(delta.field?{field:delta.field}:{} )})),
    affectedRequirements:sorted(affectedAll),explanations:{whyChanged:whyChanged.sort((a,b)=>a.id.localeCompare(b.id,"en"))}};
}
