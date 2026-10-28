import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { normalizeDocumentFact, parseYaml, resolveJsonPointer } from "../document-facts.mjs";
import { decodeUtf8Strict } from "../utils/repository-files.mjs";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ErrorClass = "invalid_canonical_source" | "duplicate_json_key" | "duplicate_requirement_id" | "malformed_requirement_id" | "unsafe_path" | "missing_fragment" | "malformed_pointer";
export interface CanonicalError { code: ErrorClass; path: string; message: string; otherPath?: string; }
export interface SemanticRequirementSubject { kind: "semantic_requirement"; repository: string; requirementId: string; digest: string; }
export interface RequirementSourceIdentity { kind: "requirement_source"; path: string; }
export interface ExactRepresentationSubject { kind: "exact_representation"; repository: string; revision: string; path: string; pointer: string; }
export interface CanonicalRequirement { id: string; value: JsonValue; semantic: SemanticRequirementSubject; source: RequirementSourceIdentity; representation: ExactRepresentationSubject; }
export interface CanonicalSnapshotInput {
  repository: string;
  revision: string;
  paths: readonly string[];
  readFile: (revision: string, path: string) => string | Buffer | null | undefined;
}
export interface CanonicalFragmentResult { ok: boolean; value?: JsonValue; identity?: ExactRepresentationSubject; error?: CanonicalError; }
export interface CanonicalRequirementsResult {
  ok: boolean;
  requirements: readonly CanonicalRequirement[];
  index: Readonly<Record<string, CanonicalRequirement>>;
  errors: readonly CanonicalError[];
  resolveFragment: (id: string, pointer: string, options?: { durable?: boolean }) => CanonicalFragmentResult;
}

const fail = (code: ErrorClass, path: string, message: string, otherPath?: string): CanonicalError =>
  ({ code, path, message, ...(otherPath ? { otherPath } : {}) });
function canonical(value: JsonValue): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  throw new Error("non-JSON or non-finite canonical Requirement semantic value");
}
export const canonicalSemanticDigest = (value: JsonValue): string =>
  createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export function strictCanonicalJson(raw: string): JsonValue {
  // JSON.parse alone loses duplicate-key evidence. Preserve its exact value semantics.
  const parsed = JSON.parse(raw) as JsonValue;
  const document = parseDocument(raw, { schema: "core", uniqueKeys: true, merge: false, prettyErrors: false });
  const diagnostics = [...document.errors, ...document.warnings];
  if (diagnostics.length) {
    const messages = diagnostics.map(e => e.message).sort();
    throw new Error(messages.some(x => /unique|duplicate|map keys/i.test(x))
      ? "duplicate JSON key: " + messages.join("; ")
      : "invalid canonical JSON: " + messages.join("; "));
  }
  return parsed;
}

function canonicalPath(path: string): string {
  // Reuse existing repository path fact validation; reject aliases rather than silently normalize.
  if (typeof path !== "string" || path !== normalizeDocumentFact(path, "repository_path"))
    throw new Error("noncanonical repository path");
  if (!path.startsWith("requirements/") || !/\.(?:yaml|yml|json)$/.test(path))
    throw new Error("path is not a canonical Requirement source");
  return path;
}
function exactRevision(revision: string): void {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("exact immutable revision must be 40 lowercase hex characters");
}
function validRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("invalid repository identity");
}
export function semanticRequirementSubject(repository: string, requirementId: string, semanticDigest: string): SemanticRequirementSubject {
  validRepository(repository);
  if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(requirementId)) throw new Error("malformed RequirementId");
  if (!/^[0-9a-f]{64}$/.test(semanticDigest)) throw new Error("invalid semantic digest");
  return { kind: "semantic_requirement", repository, requirementId, digest: semanticDigest };
}
export function exactRepresentationSubject(repository: string, revision: string, path: string, pointer = ""): ExactRepresentationSubject {
  validRepository(repository);
  exactRevision(revision);
  const safePath = canonicalPath(path);
  if (pointer !== "") {
    if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) throw new Error("malformed JSON Pointer");
  }
  return { kind: "exact_representation", repository, revision, path: safePath, pointer };
}
export function durablePointer(pointer: string): boolean {
  // Numeric path segments are valid navigation, but not a durable key identity.
  return pointer === "" || pointer.split("/").slice(1).every(part => !/^(?:0|[1-9][0-9]*)$/.test(part));
}
function parseRequirement(raw: string, path: string): JsonValue {
  const value = path.endsWith(".json") ? strictCanonicalJson(raw) : parseYaml(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("canonical Requirement source requires an object");
  return value as JsonValue;
}

export function loadCanonicalRequirements(input: CanonicalSnapshotInput): CanonicalRequirementsResult {
  const errors: CanonicalError[] = [];
  const items: CanonicalRequirement[] = [];
  let identityValid = true;
  try { validRepository(input.repository); exactRevision(input.revision); }
  catch (error) { identityValid = false; errors.push(fail("invalid_canonical_source", "", String((error as Error).message))); }
  const sorted = [...input.paths].sort();
  for (const path of sorted) {
    let safePath: string;
    try { safePath = canonicalPath(path); }
    catch (error) {
      errors.push(fail("unsafe_path", String(path), (error as Error).message));
      continue;
    }
    if (!identityValid) continue;
    try {
      const content = input.readFile(input.revision, safePath);
      if (content === null || content === undefined) throw new Error("canonical source missing at exact snapshot");
      const value = parseRequirement(
        content instanceof Uint8Array
          ? decodeUtf8Strict(content, `canonical Requirement "${safePath}"`)
          : content,
        safePath,
      );
      const id = (value as Record<string, unknown>).id;
      if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(id)) {
        errors.push(fail("malformed_requirement_id", safePath, "missing or malformed RequirementId"));
        continue;
      }
      items.push({
        id, value,
        semantic: semanticRequirementSubject(input.repository, id, canonicalSemanticDigest(value)),
        source: { kind: "requirement_source", path: safePath },
        representation: exactRepresentationSubject(input.repository, input.revision, safePath),
      });
    } catch (error) {
      const message = (error as Error).message;
      errors.push(fail(/duplicate JSON key|map keys must be unique/i.test(message) ? "duplicate_json_key" : "invalid_canonical_source", safePath, message));
    }
  }
  const index: Record<string, CanonicalRequirement> = Object.create(null);
  for (const item of items) {
    if (Object.hasOwn(index, item.id)) errors.push(fail("duplicate_requirement_id", item.source.path, "duplicate RequirementId " + item.id, index[item.id].source.path));
    else index[item.id] = item;
  }
  errors.sort((a,b) => a.path.localeCompare(b.path, "en") || a.code.localeCompare(b.code,"en") || a.message.localeCompare(b.message,"en"));
  const requirements = items.sort((a,b) => a.id.localeCompare(b.id,"en") || a.source.path.localeCompare(b.source.path,"en"));
  return {
    ok: errors.length === 0, requirements, index, errors,
    resolveFragment(id, pointer, options = {}) {
      const source = index[id];
      if (errors.length || !source) return { ok: false, error: fail("missing_fragment", id, "Requirement unavailable in invalid or incomplete snapshot") };
      if (options.durable && !durablePointer(pointer)) return { ok: false, error: fail("malformed_pointer", source.source.path, "positional pointer is not durable") };
      try {
        const value = resolveJsonPointer(source.value, pointer) as JsonValue;
        return { ok: true, value, identity: exactRepresentationSubject(input.repository, input.revision, source.source.path, pointer) };
      } catch (error) {
        const message = (error as Error).message;
        return { ok: false, error: fail(/invalid json_pointer/i.test(message) ? "malformed_pointer" : "missing_fragment", source.source.path, message) };
      }
    }
  };
}


export type NativeRelationPredicate =
  | "derives_from"
  | "requires"
  | "implemented_by"
  | "verified_by"
  | "documents"
  | "generates"
  | "depends_on"
  | "constrains"
  | "supersedes";

export type NativeResourceRef =
  | { kind: "requirement"; id: string }
  | { kind: "artifact"; path: string }
  | { kind: "document"; path: string; pointer: string }
  | { kind: "external_document"; repository: string; revision: string; path: string; pointer: string };

export interface NativeRelationFact {
  source: NativeResourceRef;
  predicate: NativeRelationPredicate;
  target: NativeResourceRef;
  collection?: boolean;
}

export interface NativeLifecycle {
  accepted: boolean;
  current: boolean;
  published: boolean;
}

export interface NativeConstraintScope {
  relations: readonly NativeRelationPredicate[];
  include_generated: boolean;
}

export interface NativeConstraintMetric {
  key: "git.changed_lines" | "git.changed_resources";
  max: number;
}

export interface NativeConstraintEvidence {
  class: "execution" | "domain";
  key: string;
  verifier?: NativeResourceRef;
}

export interface NativeConstraint {
  id: string;
  activation: "scoped_change" | "requirement_cause";
  scope: NativeConstraintScope;
  metric?: NativeConstraintMetric;
  evidence?: NativeConstraintEvidence;
}

export type NativeErrorCode =
  | "invalid_native_document"
  | "duplicate_key"
  | "unknown_field"
  | "malformed_requirement_id"
  | "duplicate_requirement_id"
  | "unknown_predicate"
  | "invalid_relation"
  | "duplicate_relation"
  | "invalid_resource_ref"
  | "floating_external_revision"
  | "duplicate_constraint_id"
  | "invalid_constraint";

export interface NativeContractError {
  code: NativeErrorCode;
  path: string;
  message: string;
  otherPath?: string;
}

export interface NativeRequirement {
  id: string;
  normative: JsonValue;
  semantic: SemanticRequirementSubject;
  source: RequirementSourceIdentity;
  representation: ExactRepresentationSubject;
  lifecycle: NativeLifecycle;
  relations: readonly NativeRelationFact[];
  constraints: readonly NativeConstraint[];
}

export interface NativeRequirementsResult {
  ok: boolean;
  requirements: readonly NativeRequirement[];
  index: Readonly<Record<string, NativeRequirement>>;
  errors: readonly NativeContractError[];
}

const nativePredicates = new Set<NativeRelationPredicate>([
  "derives_from", "requires", "implemented_by", "verified_by", "documents",
  "generates", "depends_on", "constrains", "supersedes",
]);

const nativeScopePredicates = new Set<NativeRelationPredicate>([
  "requires", "implemented_by", "verified_by", "documents", "constrains",
]);

export const compiledConstraintIdPattern = /^[A-Za-z][A-Za-z0-9._-]*$/;
export type CompiledConstraintMetric = "changed_lines" | "changed_resources";
export interface CompiledConstraintEvidence {
  kind: "execution" | "domain";
  key: string;
  providerId?: string;
  verifierPath?: string;
}
export interface CompiledConstraint {
  id: string;
  activation?: "scoped_change" | "requirement_cause";
  relations: readonly NativeRelationPredicate[];
  includeGenerated?: boolean;
  metric?: CompiledConstraintMetric;
  max?: number;
  evidence?: CompiledConstraintEvidence;
}
export type CompiledConstraintValidation =
  | { ok: true; value: CompiledConstraint }
  | { ok: false; error: string };

export function validateCompiledConstraint(value: unknown): CompiledConstraintValidation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "compiled Constraint must be an object" };
  const input = value as Record<string, unknown>;
  const allowed = new Set(["id", "activation", "relations", "includeGenerated", "metric", "max", "evidence"]);
  if (Object.keys(input).some(key => !allowed.has(key)))
    return { ok: false, error: "compiled Constraint has unknown field" };
  if (typeof input.id !== "string" || !compiledConstraintIdPattern.test(input.id))
    return { ok: false, error: "compiled Constraint id is invalid" };
  if (input.activation !== undefined && input.activation !== "scoped_change" && input.activation !== "requirement_cause")
    return { ok: false, error: "compiled Constraint activation is invalid" };
  if (!Array.isArray(input.relations) || input.relations.length === 0 ||
      input.relations.some(item => typeof item !== "string" || !nativeScopePredicates.has(item as NativeRelationPredicate)) ||
      new Set(input.relations).size !== input.relations.length)
    return { ok: false, error: "compiled Constraint relations are invalid" };
  if (input.includeGenerated !== undefined && typeof input.includeGenerated !== "boolean")
    return { ok: false, error: "compiled Constraint includeGenerated is invalid" };
  if (input.metric !== undefined && input.metric !== "changed_lines" && input.metric !== "changed_resources")
    return { ok: false, error: "compiled Constraint metric is invalid" };
  if (input.metric === undefined && input.max !== undefined)
    return { ok: false, error: "compiled Constraint max requires metric" };
  if (input.metric !== undefined && (!Number.isSafeInteger(input.max) || (input.max as number) < 0))
    return { ok: false, error: "compiled Constraint max is invalid" };

  let evidence: CompiledConstraintEvidence | undefined;
  if (input.evidence !== undefined) {
    if (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence))
      return { ok: false, error: "compiled Constraint evidence is invalid" };
    const raw = input.evidence as Record<string, unknown>;
    const evidenceAllowed = new Set(["kind", "key", "providerId", "verifierPath"]);
    if (Object.keys(raw).some(key => !evidenceAllowed.has(key)) ||
        (raw.kind !== "execution" && raw.kind !== "domain") ||
        typeof raw.key !== "string" || raw.key.length === 0 ||
        (raw.providerId !== undefined && (typeof raw.providerId !== "string" || raw.providerId.length === 0)) ||
        (raw.verifierPath !== undefined && (typeof raw.verifierPath !== "string" || raw.verifierPath.length === 0)) ||
        (raw.kind === "execution" && typeof raw.verifierPath !== "string"))
      return { ok: false, error: "compiled Constraint evidence is invalid" };
    evidence = {
      kind: raw.kind,
      key: raw.key,
      ...(typeof raw.providerId === "string" ? { providerId: raw.providerId } : {}),
      ...(typeof raw.verifierPath === "string" ? { verifierPath: raw.verifierPath } : {}),
    };
  }
  if (input.metric === undefined && evidence === undefined)
    return { ok: false, error: "compiled Constraint requires metric or evidence" };

  return {
    ok: true,
    value: {
      id: input.id,
      ...(input.activation !== undefined ? { activation: input.activation as "scoped_change" | "requirement_cause" } : {}),
      relations: [...input.relations] as NativeRelationPredicate[],
      ...(input.includeGenerated !== undefined ? { includeGenerated: input.includeGenerated as boolean } : {}),
      ...(input.metric !== undefined ? {
        metric: input.metric as CompiledConstraintMetric,
        max: input.max as number,
      } : {}),
      ...(evidence ? { evidence } : {}),
    },
  };
}

class NativeContractFailure extends Error {
  readonly code: NativeErrorCode;
  constructor(code: NativeErrorCode, message: string) {
    super(message);
    this.name = "NativeContractFailure";
    this.code = code;
  }
}

const nativeFailure = (code: NativeErrorCode, message: string): never => {
  throw new NativeContractFailure(code, message);
};

const nativeError = (code: NativeErrorCode, path: string, message: string, otherPath?: string): NativeContractError =>
  ({ code, path, message, ...(otherPath ? { otherPath } : {}) });

function nativeObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    nativeFailure("invalid_native_document", label + " must be an object");
  return value as Record<string, unknown>;
}

function nativeExactFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (unknown.length) nativeFailure("unknown_field", label + " contains unknown field(s): " + unknown.join(", "));
}

function nativeRequirementId(value: unknown, label = "RequirementId"): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(value))
    return nativeFailure("malformed_requirement_id", "invalid " + label);
  return value as string;
}

function nativePath(value: unknown, label: string): string {
  if (typeof value !== "string") return nativeFailure("invalid_resource_ref", label + " path must be a string");
  const path = value as string;
  try {
    const normalized = normalizeDocumentFact(path, "repository_path");
    if (normalized !== path) return nativeFailure("invalid_resource_ref", label + " path is noncanonical");
    return normalized as string;
  } catch (error) {
    if (error instanceof NativeContractFailure) throw error;
    return nativeFailure("invalid_resource_ref", label + " path is invalid: " + (error as Error).message);
  }
}

function nativePointer(value: unknown, label: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || (value !== "" && (!value.startsWith("/") || /~(?:[^01]|$)/.test(value))))
    return nativeFailure("invalid_resource_ref", label + " pointer is malformed");
  const pointer = value as string;
  if (!durablePointer(pointer)) return nativeFailure("invalid_resource_ref", label + " pointer is positional and not durable");
  return pointer;
}

function nativeResourceRef(value: unknown, label: string): NativeResourceRef {
  const input = nativeObject(value, label);
  const kind = input.kind;
  if (kind === "requirement") {
    nativeExactFields(input, ["kind", "id"], label);
    return { kind, id: nativeRequirementId(input.id, label + ".id") };
  }
  if (kind === "artifact") {
    nativeExactFields(input, ["kind", "path"], label);
    return { kind, path: nativePath(input.path, label) };
  }
  if (kind === "document") {
    nativeExactFields(input, ["kind", "path", "pointer"], label);
    return { kind, path: nativePath(input.path, label), pointer: nativePointer(input.pointer, label) };
  }
  if (kind === "external_document") {
    nativeExactFields(input, ["kind", "repository", "revision", "path", "pointer"], label);
    if (typeof input.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
      return nativeFailure("invalid_resource_ref", label + " repository is invalid");
    if (typeof input.revision !== "string" || !/^[0-9a-f]{40}$/.test(input.revision))
      return nativeFailure("floating_external_revision", label + " revision must be an exact immutable SHA");
    const repository = input.repository as string;
    const revision = input.revision as string;
    return {
      kind,
      repository,
      revision,
      path: nativePath(input.path, label),
      pointer: nativePointer(input.pointer, label),
    };
  }
  return nativeFailure("invalid_resource_ref", label + " has unknown ResourceRef kind");
}

function nativeRefKey(value: NativeResourceRef): string {
  return JSON.stringify(canonical(value as unknown as JsonValue));
}

function nativeRelationDomain(source: NativeResourceRef, predicate: NativeRelationPredicate, target: NativeResourceRef): void {
  const sourceRequirement = source.kind === "requirement";
  if (predicate === "generates") {
    if (source.kind !== "artifact" || target.kind !== "artifact")
      nativeFailure("invalid_relation", "generates requires explicit local ArtifactRef source and ArtifactRef target");
    return;
  }
  if (!sourceRequirement) nativeFailure("invalid_relation", predicate + " requires RequirementRef source");
  if (predicate === "derives_from" || predicate === "depends_on" || predicate === "supersedes") {
    if (target.kind !== "requirement") nativeFailure("invalid_relation", predicate + " requires RequirementRef target");
    return;
  }
  if (predicate === "implemented_by" || predicate === "verified_by" || predicate === "documents") {
    if (target.kind === "requirement") nativeFailure("invalid_relation", predicate + " requires non-Requirement Resource target");
  }
}

function nativeRelations(value: unknown, requirementId: string): NativeRelationFact[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return nativeFailure("invalid_relation", "relations must be an array");
  const declarations = value as unknown[];
  const facts: NativeRelationFact[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = nativeObject(declarations[index], "relations[" + index + "]");
    nativeExactFields(declaration, ["source", "predicates", "target", "collection"], "relations[" + index + "]");
    if (declaration.collection !== undefined && typeof declaration.collection !== "boolean")
      return nativeFailure("invalid_relation", "relations[" + index + "].collection must be boolean");
    if (!Array.isArray(declaration.predicates) || declaration.predicates.length === 0)
      return nativeFailure("invalid_relation", "relations[" + index + "].predicates must be a non-empty array");
    const predicateValues = declaration.predicates as unknown[];
    const predicates: NativeRelationPredicate[] = [];
    const local = new Set<string>();
    for (const raw of predicateValues) {
      if (typeof raw !== "string" || !nativePredicates.has(raw as NativeRelationPredicate))
        return nativeFailure("unknown_predicate", "unknown native relation predicate " + String(raw));
      const predicate = raw as NativeRelationPredicate;
      if (local.has(predicate)) return nativeFailure("duplicate_relation", "duplicate predicate " + predicate + " in one relation declaration");
      local.add(predicate);
      predicates.push(predicate);
    }
    predicates.sort();
    const source = declaration.source === undefined
      ? { kind: "requirement" as const, id: requirementId }
      : nativeResourceRef(declaration.source, "relations[" + index + "].source");
    const target = nativeResourceRef(declaration.target, "relations[" + index + "].target");
    const collection = declaration.collection === true;
    if (declaration.source !== undefined && predicates.some(predicate => predicate !== "generates"))
      nativeFailure("invalid_relation", "explicit relation source is only supported for generates in native v1");
    if (collection) {
      if (target.kind !== "artifact")
        nativeFailure("invalid_relation", "collection:true requires an exact local ArtifactRef target");
      if (predicates.some(predicate => !["requires", "implemented_by", "verified_by", "documents"].includes(predicate)))
        nativeFailure("invalid_relation", "collection:true requires a J1 direct Requirement-to-Artifact predicate");
    }
    for (const predicate of predicates) {
      nativeRelationDomain(source, predicate, target);
      const fact = { source, predicate, target, ...(collection ? { collection: true } : {}) };
      const key = nativeRefKey(source) + "\0" + predicate + "\0" + nativeRefKey(target);
      if (seen.has(key)) nativeFailure("duplicate_relation", "duplicate normalized Relation fact");
      seen.add(key);
      facts.push(fact);
    }
  }
  return facts.sort((a, b) =>
    a.predicate.localeCompare(b.predicate, "en") ||
    nativeRefKey(a.source).localeCompare(nativeRefKey(b.source), "en") ||
    nativeRefKey(a.target).localeCompare(nativeRefKey(b.target), "en"));
}

function nativeLifecycle(value: unknown): NativeLifecycle {
  if (value === undefined) return { accepted: false, current: false, published: false };
  const input = nativeObject(value, "lifecycle");
  nativeExactFields(input, ["accepted", "current", "published"], "lifecycle");
  for (const key of ["accepted", "current", "published"] as const)
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      nativeFailure("invalid_native_document", "lifecycle." + key + " must be boolean");
  return {
    accepted: input.accepted === true,
    current: input.current === true,
    published: input.published === true,
  };
}

function nativeConstraintScope(value: unknown, label: string): NativeConstraintScope {
  const input = nativeObject(value, label);
  nativeExactFields(input, ["relations", "include_generated"], label);
  if (!Array.isArray(input.relations) || input.relations.length === 0)
    return nativeFailure("invalid_constraint", label + ".relations must be a non-empty array");
  const relationValues = input.relations as unknown[];
  const relations: NativeRelationPredicate[] = [];
  const seen = new Set<string>();
  for (const raw of relationValues) {
    if (typeof raw !== "string" || !nativePredicates.has(raw as NativeRelationPredicate))
      return nativeFailure("unknown_predicate", "unknown Constraint scope predicate " + String(raw));
    const predicate = raw as NativeRelationPredicate;
    if (!nativeScopePredicates.has(predicate))
      return nativeFailure("invalid_constraint", "predicate " + predicate + " cannot seed Requirement-derived Constraint scope");
    if (seen.has(predicate)) return nativeFailure("invalid_constraint", "duplicate Constraint scope predicate " + predicate);
    seen.add(predicate);
    relations.push(predicate);
  }
  if (input.include_generated !== undefined && typeof input.include_generated !== "boolean")
    nativeFailure("invalid_constraint", label + ".include_generated must be boolean");
  return { relations: relations.sort(), include_generated: input.include_generated === true };
}

function nativeConstraintMetric(value: unknown, label: string): NativeConstraintMetric {
  const input = nativeObject(value, label);
  nativeExactFields(input, ["key", "max"], label);
  if (input.key !== "git.changed_lines" && input.key !== "git.changed_resources")
    nativeFailure("invalid_constraint", label + ".key must be git.changed_lines or git.changed_resources");
  if (!Number.isSafeInteger(input.max) || (input.max as number) < 0)
    nativeFailure("invalid_constraint", label + ".max must be a non-negative safe integer");
  return { key: input.key as NativeConstraintMetric["key"], max: input.max as number };
}

function nativeConstraintEvidence(value: unknown, label: string): NativeConstraintEvidence {
  const input = nativeObject(value, label);
  nativeExactFields(input, ["class", "key", "verifier"], label);
  if (input.class !== "execution" && input.class !== "domain")
    nativeFailure("invalid_constraint", label + ".class must be execution or domain");
  if (typeof input.key !== "string" || input.key.length === 0)
    nativeFailure("invalid_constraint", label + ".key must be a non-empty string");
  const verifier = input.verifier === undefined ? undefined : nativeResourceRef(input.verifier, label + ".verifier");
  const evidenceClass = input.class as "execution" | "domain";
  const key = input.key as string;
  if (evidenceClass === "execution" && (!verifier || verifier.kind !== "artifact"))
    return nativeFailure("invalid_constraint", label + " execution evidence requires an ArtifactRef verifier");
  if (verifier && verifier.kind !== "artifact")
    return nativeFailure("invalid_constraint", label + " verifier must be an ArtifactRef in native v1");
  return { class: evidenceClass, key, ...(verifier ? { verifier } : {}) };
}

function nativeConstraints(value: unknown): NativeConstraint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return nativeFailure("invalid_constraint", "constraints must be an array");
  const values = value as unknown[];
  const constraints: NativeConstraint[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const label = "constraints[" + index + "]";
    const input = nativeObject(values[index], label);
    nativeExactFields(input, ["id", "activation", "scope", "metric", "evidence"], label);
    if (typeof input.id !== "string" || !compiledConstraintIdPattern.test(input.id))
      nativeFailure("invalid_constraint", label + ".id is invalid");
    const id = input.id as string;
    if (ids.has(id)) return nativeFailure("duplicate_constraint_id", "duplicate Constraint id " + id);
    ids.add(id);
    const rawActivation = input.activation === undefined ? "scoped_change" : input.activation;
    if (rawActivation !== "scoped_change" && rawActivation !== "requirement_cause")
      return nativeFailure("invalid_constraint", label + ".activation is invalid");
    const activation = rawActivation as "scoped_change" | "requirement_cause";
    const scope = nativeConstraintScope(input.scope, label + ".scope");
    const metric = input.metric === undefined ? undefined : nativeConstraintMetric(input.metric, label + ".metric");
    const evidence = input.evidence === undefined ? undefined : nativeConstraintEvidence(input.evidence, label + ".evidence");
    if (!metric && !evidence) nativeFailure("invalid_constraint", label + " requires metric or evidence");
    constraints.push({
      id,
      activation,
      scope,
      ...(metric ? { metric } : {}),
      ...(evidence ? { evidence } : {}),
    });
  }
  return constraints.sort((a, b) => a.id.localeCompare(b.id, "en"));
}

function nativeRequirementSourcePath(path: string): string {
  if (!/\.rg\.(?:yaml|json)$/.test(path))
    nativeFailure("invalid_native_document", "path is not a native Requirement source");
  const normalized = nativePath(path, "native Requirement source");
  if (!normalized.startsWith("requirements/"))
    nativeFailure("invalid_native_document", "native Requirement source must be under requirements/");
  return normalized;
}

function parseNativeRequirement(raw: string, path: string): Record<string, unknown> {
  const value = path.endsWith(".json") ? strictCanonicalJson(raw) : parseYaml(raw);
  return nativeObject(value, "native Requirement");
}

export function loadNativeRequirements(input: CanonicalSnapshotInput): NativeRequirementsResult {
  const errors: NativeContractError[] = [];
  const items: NativeRequirement[] = [];
  let identityValid = true;
  try {
    validRepository(input.repository);
    exactRevision(input.revision);
  } catch (error) {
    identityValid = false;
    errors.push(nativeError("invalid_native_document", "", (error as Error).message));
  }
  const candidatePaths = [...input.paths].filter(path => /\.rg\.(?:yaml|json)$/.test(path)).sort();
  for (const candidatePath of candidatePaths) {
    let path = String(candidatePath);
    try {
      path = nativeRequirementSourcePath(path);
      if (!identityValid) continue;
      const content = input.readFile(input.revision, path);
      if (content === null || content === undefined) nativeFailure("invalid_native_document", "native source missing at exact snapshot");
      const exactContent = content as string | Buffer;
      const raw = exactContent instanceof Uint8Array
        ? decodeUtf8Strict(exactContent, `native Requirement "${path}"`)
        : exactContent;
      const value = parseNativeRequirement(raw, path);
      nativeExactFields(value, ["format", "id", "normative", "lifecycle", "relations", "constraints"], "native Requirement");
      if (value.format !== "repo-guard/requirement-v1")
        nativeFailure("invalid_native_document", "format must be repo-guard/requirement-v1");
      const id = nativeRequirementId(value.id);
      if (!Object.hasOwn(value, "normative"))
        nativeFailure("invalid_native_document", "native Requirement requires normative");
      const normative = canonical(value.normative as JsonValue);
      const lifecycle = nativeLifecycle(value.lifecycle);
      const relations = nativeRelations(value.relations, id);
      const constraints = nativeConstraints(value.constraints);
      items.push({
        id,
        normative,
        semantic: semanticRequirementSubject(input.repository, id, canonicalSemanticDigest(normative)),
        source: { kind: "requirement_source", path },
        representation: exactRepresentationSubject(input.repository, input.revision, path),
        lifecycle,
        relations,
        constraints,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof NativeContractFailure) errors.push(nativeError(error.code, path, message));
      else if (/duplicate JSON key|map keys must be unique/i.test(message)) errors.push(nativeError("duplicate_key", path, message));
      else errors.push(nativeError("invalid_native_document", path, message));
    }
  }
  const index: Record<string, NativeRequirement> = Object.create(null);
  for (const item of items) {
    if (Object.hasOwn(index, item.id))
      errors.push(nativeError("duplicate_requirement_id", item.source.path, "duplicate RequirementId " + item.id, index[item.id].source.path));
    else
      index[item.id] = item;
  }
  errors.sort((a, b) =>
    a.path.localeCompare(b.path, "en") ||
    a.code.localeCompare(b.code, "en") ||
    a.message.localeCompare(b.message, "en"));
  const requirements = items.sort((a, b) =>
    a.id.localeCompare(b.id, "en") ||
    a.source.path.localeCompare(b.source.path, "en"));
  return { ok: errors.length === 0, requirements, index, errors };
}

export function lowerNativeRequirements(native: NativeRequirementsResult) {
  const errors: CanonicalError[] = native.errors.map(error => ({
    code: "invalid_canonical_source",
    path: error.path,
    message: "native:" + error.code + ":" + error.message,
    ...(error.otherPath ? { otherPath: error.otherPath } : {}),
  }));
  const requirements: CanonicalRequirement[] = [];
  const lifecycle: Record<string, Record<string, boolean>> = {};
  const resourceRelations: Array<{ from: string; kind: "generates"; to: string }> = [];
  const generatedSeen = new Set<string>();

  for (const item of native.requirements) {
    const relations: Record<string, unknown> = {};
    let relationIndex = 0;
    for (const relation of item.relations) {
      if (relation.predicate === "generates") {
        if (relation.source.kind !== "artifact" || relation.target.kind !== "artifact") {
          errors.push({ code: "invalid_canonical_source", path: item.source.path, message: "native:invalid generates lowering" });
          continue;
        }
        const key = relation.source.path + "\0" + relation.target.path;
        if (generatedSeen.has(key)) {
          errors.push({ code: "invalid_canonical_source", path: item.source.path, message: "native:duplicate global generates relation" });
          continue;
        }
        generatedSeen.add(key);
        resourceRelations.push({ from: relation.source.path, kind: "generates", to: relation.target.path });
        continue;
      }
      if (relation.source.kind !== "requirement" || relation.source.id !== item.id) {
        errors.push({ code: "invalid_canonical_source", path: item.source.path, message: "native:non-generates relation must originate from enclosing Requirement" });
        continue;
      }
      const label = "native_" + String(relationIndex++).padStart(6, "0");
      relations[label] = {
        predicate: relation.predicate,
        target: relation.target,
        ...(relation.collection === true ? { collection: true } : {}),
      };
    }
    const constraints: CompiledConstraint[] = [];
    for (const constraint of item.constraints) {
      const candidate: CompiledConstraint = {
        id: constraint.id,
        activation: constraint.activation,
        relations: [...constraint.scope.relations],
        includeGenerated: constraint.scope.include_generated,
        ...(constraint.metric ? {
          metric: constraint.metric.key === "git.changed_lines" ? "changed_lines" : "changed_resources",
          max: constraint.metric.max,
        } : {}),
        ...(constraint.evidence ? {
          evidence: {
            kind: constraint.evidence.class,
            key: constraint.evidence.key,
            ...(constraint.evidence.verifier?.kind === "artifact" ? { verifierPath: constraint.evidence.verifier.path } : {}),
          },
        } : {}),
      };
      const validated = validateCompiledConstraint(candidate);
      if (!validated.ok) {
        errors.push({ code: "invalid_canonical_source", path: item.source.path, message: "native:compiled_constraint:" + validated.error });
        continue;
      }
      constraints.push(validated.value);
    }
    const value = { id: item.id, normative: item.normative, relations, constraints } as unknown as CanonicalRequirement["value"];
    requirements.push({ ...item, value, semantic: item.semantic });
    lifecycle[item.id] = { ...item.lifecycle };
  }

  requirements.sort((a, b) => a.id.localeCompare(b.id, "en"));
  resourceRelations.sort((a, b) => a.from.localeCompare(b.from, "en") || a.to.localeCompare(b.to, "en"));
  errors.sort((a, b) => a.path.localeCompare(b.path, "en") || a.code.localeCompare(b.code, "en") || a.message.localeCompare(b.message, "en"));
  const index: Record<string, CanonicalRequirement> = Object.create(null);
  for (const item of requirements) index[item.id] = item;
  const result: CanonicalRequirementsResult = {
    ok: errors.length === 0,
    requirements,
    index,
    errors,
    resolveFragment(id, pointer, options = {}) {
      const source = index[id];
      if (errors.length || !source) return { ok: false, error: { code: "missing_fragment", path: id, message: "native Requirement unavailable in invalid or incomplete lowering" } };
      if (options.durable && !durablePointer(pointer))
        return { ok: false, error: { code: "malformed_pointer", path: source.source.path, message: "positional pointer is not durable" } };
      try {
        const value = resolveJsonPointer(source.value, pointer) as CanonicalRequirement["value"];
        return {
          ok: true,
          value,
          identity: exactRepresentationSubject(source.semantic.repository, source.representation.revision, source.source.path, pointer),
        };
      } catch (error) {
        const message = (error as Error).message;
        return { ok: false, error: { code: /invalid json_pointer/i.test(message) ? "malformed_pointer" : "missing_fragment", path: source.source.path, message } };
      }
    },
  };
  return { requirements: result, lifecycle, resourceRelations };
}

