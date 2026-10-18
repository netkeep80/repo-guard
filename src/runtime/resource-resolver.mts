import { normalizeDocumentFact, parseJson, parseYaml, resolveJsonPointer } from "../document-facts.mjs";
import { canonicalSemanticDigest, durablePointer, exactRepresentationSubject, semanticRequirementSubject, strictCanonicalJson, type CanonicalRequirementsResult, type ExactRepresentationSubject, type RequirementSourceIdentity, type SemanticRequirementSubject } from "./canonical-requirements.mjs";

export type ResourceRef =
  | { kind: "requirement"; id: string }
  | { kind: "artifact"; path: string }
  | { kind: "document"; path: string; pointer?: string }
  | { kind: "external_document"; repository: string; revision: string; path: string; pointer?: string };
export interface ResolverContext {
  repository: string;
  revision: string;
  requirements: CanonicalRequirementsResult;
  readers: Readonly<Record<string, (revision: string, path: string) => string | Buffer | null | undefined>>;
}
export interface ResolveError { code: string; subject: string; message: string; }
export type ResolveResult = { ok: true; value: unknown } | { ok: false; error: ResolveError };
const sha = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const definitions: Readonly<Record<ResourceRef["kind"], readonly string[]>> = {
  requirement: ["kind", "id"], artifact: ["kind", "path"],
  document: ["kind", "path", "pointer"], external_document: ["kind", "repository", "revision", "path", "pointer"],
};
const error = (code: string, subject: string, message: string): ResolveResult => ({ ok: false, error: { code, subject, message } });
const safePath = (p: unknown): string => {
  if (typeof p !== "string") throw new Error("repository path must be a string");
  const norm = normalizeDocumentFact(p, "repository_path");
  if (norm !== p) throw new Error("noncanonical repository path alias");
  return norm;
};
const exactIdentity = (repository: string, revision: string, path: string, pointer = ""): ExactRepresentationSubject =>
  ({ kind: "exact_representation", repository, revision, path, pointer });
export function normalizeResourceRef(value: unknown): ResourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ResourceRef object");
  const obj = value as Record<string, unknown>, kind = obj.kind;
  if (typeof kind !== "string" || !Object.hasOwn(definitions, kind)) throw new Error("unknown ResourceRef kind");
  const keys = definitions[kind as ResourceRef["kind"]];
  if (Object.keys(obj).some(k => !keys.includes(k))) throw new Error("extra ResourceRef fields forbidden");
  if (kind === "requirement") {
    if (typeof obj.id !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(obj.id)) throw new Error("invalid RequirementId");
  } else {
    safePath(obj.path);
    if (kind !== "artifact" && obj.pointer !== undefined && typeof obj.pointer !== "string") throw new Error("invalid JSON pointer");
    if (kind === "external_document" &&
      (typeof obj.repository !== "string" || !repositoryPattern.test(obj.repository) ||
       typeof obj.revision !== "string" || !sha.test(obj.revision))) throw new Error("invalid external repository or revision");
  }
  return obj as unknown as ResourceRef;
}
function parsedDocument(raw: string, path: string): unknown {
  if (path.endsWith(".json")) return parseJson(raw);
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return parseYaml(raw);
  throw new Error("unsupported document format");
}
export function createResourceResolver(context: ResolverContext) {
  if (!repositoryPattern.test(context.repository) || !sha.test(context.revision)) throw new Error("resolver context requires exact repository and revision");
  if (!context.requirements.ok || context.requirements.requirements.some(r => r.representation.repository !== context.repository || r.representation.revision !== context.revision))
    throw new Error("inconsistent I1 exact snapshot");
  return {
    resolve(rawRef: unknown, options: { durable?: boolean; expectedRevision?: string } = {}): ResolveResult {
      let ref: ResourceRef;
      try { ref = normalizeResourceRef(rawRef); }
      catch (e) { const message = (e as Error).message; return error(/path|noncanonical/i.test(message) ? "unsafe_path" : /invalid external repository or revision/.test(message) ? "invalid_revision" : "invalid_ref", "", message); }
      const subject = JSON.stringify(ref);
      if (ref.kind === "requirement") {
        const found = context.requirements.index[ref.id];
        if (!found || context.requirements.errors.length) return error("unknown_requirement", subject, "Requirement absent or ambiguous in exact I1 index");
        return { ok: true, value: { kind: "resolved_requirement", semantic: found.semantic, source: found.source, representation: found.representation, value: found.value } };
      }
      let repository = context.repository, revision = context.revision;
      if (ref.kind === "external_document") { repository = ref.repository; revision = ref.revision; }
      if (options.expectedRevision && revision !== options.expectedRevision)
        return error("inconsistent_snapshot", subject, "revision differs from expected exact snapshot");
      const reader = Object.hasOwn(context.readers, repository) ? context.readers[repository] : undefined;
      if (typeof reader !== "function") return error("unknown_repository", subject, "repository exact reader not registered");
      let path: string;
      try { path = safePath(ref.path); }
      catch (e) { return error("unsafe_path", subject, (e as Error).message); }
      const pointer = ref.kind === "artifact" ? "" : ref.pointer || "";
      if (pointer && (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)))
        return error("malformed_pointer", subject, "invalid JSON pointer");
      if (options.durable && !durablePointer(pointer))
        return error("non_durable_pointer", subject, "positional fragment cannot be durable identity");
      const identity = exactIdentity(repository, revision, path, pointer);
      try {
        const raw = reader(revision, path);
        if (raw === undefined || raw === null) return error("missing_path", subject, "exact snapshot path does not exist");
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (ref.kind === "artifact")
          return { ok: true, value: { kind: "resolved_artifact", representation: identity, bytes } };
        const document = parsedDocument(bytes.toString("utf8"), path);
        const value = resolveJsonPointer(document, pointer);
        return { ok: true, value: { kind: "resolved_document", representation: identity, value } };
      } catch (e) {
        const message = (e as Error).message;
        return error(/invalid json_pointer/.test(message) ? "malformed_pointer" :
          /does not exist/.test(message) ? "missing_fragment" : "invalid_document", subject, message);
      }
    }
  };
}


type NativeJsonValue = null | boolean | number | string | NativeJsonValue[] | { [key: string]: NativeJsonValue };
export type NativePredicate = "derives_from" | "requires" | "implemented_by" | "verified_by" | "documents" | "generates" | "depends_on" | "constrains" | "supersedes";
export type NativeConstraintActivation = "scoped_change" | "requirement_cause";
export interface NativeLifecycle { accepted: boolean; current: boolean; published: boolean; }
export interface NativeRelation { source: ResourceRef; predicate: NativePredicate; target: ResourceRef; }
export interface NativeConstraint {
  id: string;
  activation: NativeConstraintActivation;
  scope: { relations: readonly NativePredicate[]; includeGenerated: boolean };
  metric?: { key: string; max: number };
  evidence?: { class: "execution" | "domain"; key: string; verifier?: ResourceRef };
}
export interface NativeRequirement {
  id: string;
  normative: NativeJsonValue;
  lifecycle: NativeLifecycle;
  relations: readonly NativeRelation[];
  constraints: readonly NativeConstraint[];
  semantic: SemanticRequirementSubject;
  source: RequirementSourceIdentity;
  representation: ExactRepresentationSubject;
}
export interface NativeContractError { code: string; path: string; message: string; otherPath?: string; }
export interface NativeRequirementsResult {
  ok: boolean;
  requirements: readonly NativeRequirement[];
  index: Readonly<Record<string, NativeRequirement>>;
  errors: readonly NativeContractError[];
}
export interface NativeSnapshotInput {
  repository: string;
  revision: string;
  paths: readonly string[];
  readFile: (revision: string, path: string) => string | Buffer | null | undefined;
}

const nativePredicates = new Set<NativePredicate>(["derives_from","requires","implemented_by","verified_by","documents","generates","depends_on","constrains","supersedes"]);
const nativeRequirementSourcePredicates = new Set<NativePredicate>(["derives_from","requires","implemented_by","verified_by","documents","depends_on","constrains","supersedes"]);
const nativeResourceScopePredicates = new Set<NativePredicate>(["requires","implemented_by","verified_by","documents","constrains"]);
const nativeRequirementTargets = new Set<NativePredicate>(["derives_from","depends_on","supersedes"]);
const nativeArtifactTargets = new Set<NativePredicate>(["implemented_by","verified_by"]);
const nativeDocumentTargets = new Set<NativePredicate>(["documents"]);
const nativeObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nativeExtraField = (value: Record<string, unknown>, fields: readonly string[]): string | null =>
  Object.keys(value).find(key => !fields.includes(key)) || null;
const nativeError = (code: string, path: string, message: string, otherPath?: string): NativeContractError =>
  ({ code, path, message, ...(otherPath ? { otherPath } : {}) });
const nativeToken = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value || value.trim() !== value) throw new Error("invalid " + label);
  return value;
};
const nativeRequirementId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(value)) throw new Error("invalid RequirementId");
  return value;
};
export function isNativeRequirementPath(path: string): boolean {
  try {
    if (!/^requirements\/(?:[^/]+\/)*[^/]+\.rg\.(?:yaml|json)$/.test(path)) return false;
    safePath(path);
    return true;
  } catch { return false; }
}
function parseNativeRequirement(raw: string, path: string): Record<string, unknown> {
  const value = path.endsWith(".json") ? strictCanonicalJson(raw) : parseYaml(raw);
  const result = nativeObject(value);
  if (!result) throw new Error("native Requirement source requires an object");
  return result;
}
function normalizeNativeLifecycle(value: unknown): NativeLifecycle {
  if (value === undefined) return { accepted: false, current: false, published: false };
  const item = nativeObject(value);
  if (!item) throw new Error("invalid lifecycle");
  const extra = nativeExtraField(item, ["accepted","current","published"]);
  if (extra) throw new Error("unknown lifecycle field " + extra);
  for (const key of ["accepted","current","published"] as const) {
    if (item[key] !== undefined && typeof item[key] !== "boolean") throw new Error("invalid lifecycle." + key);
  }
  return { accepted: item.accepted === true, current: item.current === true, published: item.published === true };
}
function normalizeNativePredicateList(value: unknown, scope = false): NativePredicate[] {
  if (!Array.isArray(value) || !value.length) throw new Error("predicates must be a non-empty array");
  const out: NativePredicate[] = [], seen = new Set<string>();
  for (const raw of value) {
    const predicate = nativeToken(raw, "predicate") as NativePredicate;
    if (!nativePredicates.has(predicate)) throw new Error("unknown predicate " + predicate);
    if (scope && !nativeResourceScopePredicates.has(predicate)) throw new Error("predicate " + predicate + " cannot define a Resource scope");
    if (seen.has(predicate)) throw new Error("duplicate predicate " + predicate);
    seen.add(predicate); out.push(predicate);
  }
  return out.sort();
}
const nativeRelationKey = (relation: NativeRelation): string => JSON.stringify([relation.source, relation.predicate, relation.target]);
function validateNativeRelationDomain(id: string, source: ResourceRef, predicate: NativePredicate, target: ResourceRef): void {
  if (predicate === "generates") {
    if (source.kind !== "artifact" || target.kind !== "artifact") throw new Error("generates requires ArtifactRef -> ArtifactRef");
    return;
  }
  if (!nativeRequirementSourcePredicates.has(predicate) || source.kind !== "requirement" || source.id !== id)
    throw new Error(predicate + " requires enclosing Requirement source");
  if (nativeRequirementTargets.has(predicate) && target.kind !== "requirement")
    throw new Error(predicate + " requires RequirementRef target");
  if (nativeArtifactTargets.has(predicate) && target.kind !== "artifact")
    throw new Error(predicate + " requires ArtifactRef target");
  if (nativeDocumentTargets.has(predicate) && !["artifact","document","external_document"].includes(target.kind))
    throw new Error(predicate + " requires document-capable target");
  if (predicate === "requires" && target.kind === "requirement")
    throw new Error("requires target must be a non-Requirement ResourceRef");
  if (predicate === "constrains" && !["requirement","artifact"].includes(target.kind))
    throw new Error("constrains target must be RequirementRef or ArtifactRef");
}
function normalizeNativeRelations(id: string, value: unknown): NativeRelation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("relations must be an array");
  const out: NativeRelation[] = [], seen = new Set<string>();
  for (const raw of value) {
    const item = nativeObject(raw);
    if (!item) throw new Error("invalid relation declaration");
    const extra = nativeExtraField(item, ["source","predicates","target"]);
    if (extra) throw new Error("unknown relation field " + extra);
    const source = item.source === undefined ? normalizeResourceRef({ kind: "requirement", id }) : normalizeResourceRef(item.source);
    const target = normalizeResourceRef(item.target);
    for (const predicate of normalizeNativePredicateList(item.predicates)) {
      validateNativeRelationDomain(id, source, predicate, target);
      const relation = { source, predicate, target };
      const key = nativeRelationKey(relation);
      if (seen.has(key)) throw new Error("duplicate relation " + key);
      seen.add(key); out.push(relation);
    }
  }
  return out.sort((a,b) => nativeRelationKey(a).localeCompare(nativeRelationKey(b), "en"));
}
function normalizeNativeConstraint(value: unknown): NativeConstraint {
  const item = nativeObject(value);
  if (!item) throw new Error("invalid Constraint");
  const extra = nativeExtraField(item, ["id","activation","scope","metric","evidence"]);
  if (extra) throw new Error("unknown Constraint field " + extra);
  const id = nativeToken(item.id, "ConstraintId");
  const activation = (item.activation === undefined ? "scoped_change" : nativeToken(item.activation, "Constraint activation")) as NativeConstraintActivation;
  if (!["scoped_change","requirement_cause"].includes(activation)) throw new Error("invalid Constraint activation");
  const scope = nativeObject(item.scope);
  if (!scope) throw new Error("invalid Constraint scope");
  const scopeExtra = nativeExtraField(scope, ["relations","include_generated"]);
  if (scopeExtra) throw new Error("unknown Constraint scope field " + scopeExtra);
  const relations = normalizeNativePredicateList(scope.relations, true);
  if (scope.include_generated !== undefined && typeof scope.include_generated !== "boolean") throw new Error("invalid include_generated");
  const normalized: NativeConstraint = { id, activation, scope: { relations, includeGenerated: scope.include_generated === true } };
  if (item.metric !== undefined) {
    const metric = nativeObject(item.metric);
    if (!metric) throw new Error("invalid metric");
    const metricExtra = nativeExtraField(metric, ["key","max"]);
    if (metricExtra) throw new Error("unknown metric field " + metricExtra);
    const key = nativeToken(metric.key, "metric key");
    if (typeof metric.max !== "number" || !Number.isFinite(metric.max)) throw new Error("invalid metric max");
    normalized.metric = { key, max: metric.max };
  }
  if (item.evidence !== undefined) {
    const evidence = nativeObject(item.evidence);
    if (!evidence) throw new Error("invalid evidence");
    const evidenceExtra = nativeExtraField(evidence, ["class","key","verifier"]);
    if (evidenceExtra) throw new Error("unknown evidence field " + evidenceExtra);
    const klass = nativeToken(evidence.class, "evidence class");
    if (!["execution","domain"].includes(klass)) throw new Error("invalid evidence class");
    const key = nativeToken(evidence.key, "evidence key");
    const verifier = evidence.verifier === undefined ? undefined : normalizeResourceRef(evidence.verifier);
    if (klass === "execution" && (!verifier || verifier.kind !== "artifact")) throw new Error("execution evidence requires ArtifactRef verifier");
    normalized.evidence = { class: klass as "execution" | "domain", key, ...(verifier ? { verifier } : {}) };
  }
  if (!normalized.metric && !normalized.evidence) throw new Error("Constraint requires metric or evidence");
  return normalized;
}
function normalizeNativeConstraints(value: unknown): NativeConstraint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("constraints must be an array");
  const out: NativeConstraint[] = [], seen = new Set<string>();
  for (const raw of value) {
    const constraint = normalizeNativeConstraint(raw);
    if (seen.has(constraint.id)) throw new Error("duplicate ConstraintId " + constraint.id);
    seen.add(constraint.id); out.push(constraint);
  }
  return out.sort((a,b) => a.id.localeCompare(b.id, "en"));
}
function nativeErrorCode(message: string): string {
  if (/duplicate JSON key|map keys must be unique|duplicate key/i.test(message)) return "duplicate_key";
  if (/unknown predicate/.test(message)) return "unknown_predicate";
  if (/unknown .*field/.test(message)) return /Constraint|metric|evidence/.test(message) ? "invalid_constraint" : "unknown_field";
  if (/duplicate relation/.test(message)) return "duplicate_relation";
  if (/duplicate ConstraintId/.test(message)) return "duplicate_constraint_id";
  if (/ResourceRef|repository path|external repository|revision|invalid RequirementId/.test(message)) return "invalid_resource_ref";
  if (/requires enclosing Requirement|requires .* target|target must be|generates requires/.test(message)) return "invalid_relation_domain";
  if (/Constraint|scope|metric|evidence|include_generated/.test(message)) return "invalid_constraint";
  if (/normative|non-JSON|non-finite/.test(message)) return "invalid_normative_value";
  return "invalid_native_document";
}
export function loadNativeRequirements(input: NativeSnapshotInput): NativeRequirementsResult {
  const errors: NativeContractError[] = [], items: NativeRequirement[] = [];
  const paths = [...input.paths].filter(isNativeRequirementPath).sort();
  for (const path of paths) {
    try {
      const representation = exactRepresentationSubject(input.repository, input.revision, path);
      const raw = input.readFile(input.revision, path);
      if (raw === null || raw === undefined) throw new Error("native source missing at exact snapshot");
      const value = parseNativeRequirement(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw, path);
      const extra = nativeExtraField(value, ["format","id","normative","lifecycle","relations","constraints"]);
      if (extra) throw new Error("unknown top-level field " + extra);
      if (value.format !== "repo-guard/requirement-v1") throw new Error("invalid native format");
      const id = nativeRequirementId(value.id);
      if (!Object.hasOwn(value, "normative")) throw new Error("missing normative value");
      const normative = value.normative as NativeJsonValue;
      const semantic = semanticRequirementSubject(input.repository, id, canonicalSemanticDigest(normative));
      items.push({
        id, normative,
        lifecycle: normalizeNativeLifecycle(value.lifecycle),
        relations: normalizeNativeRelations(id, value.relations),
        constraints: normalizeNativeConstraints(value.constraints),
        semantic,
        source: { kind: "requirement_source", path },
        representation,
      });
    } catch (error) {
      const message = (error as Error).message;
      errors.push(nativeError(nativeErrorCode(message), path, message));
    }
  }
  const index: Record<string, NativeRequirement> = Object.create(null);
  for (const item of items) {
    if (Object.hasOwn(index, item.id))
      errors.push(nativeError("duplicate_requirement_id", item.source.path, "duplicate RequirementId " + item.id, index[item.id]!.source.path));
    else index[item.id] = item;
  }
  for (const item of items) {
    for (const relation of item.relations) {
      for (const ref of [relation.source, relation.target]) {
        if (ref.kind === "requirement" && !Object.hasOwn(index, ref.id))
          errors.push(nativeError("missing_requirement_target", item.source.path, "missing Requirement target " + ref.id));
      }
    }
  }
  errors.sort((a,b) => a.path.localeCompare(b.path, "en") || a.code.localeCompare(b.code, "en") || a.message.localeCompare(b.message, "en"));
  const requirements = items.sort((a,b) => a.id.localeCompare(b.id, "en") || a.source.path.localeCompare(b.source.path, "en"));
  return { ok: errors.length === 0, requirements, index, errors };
}
