import { createHash } from "node:crypto";
import { normalizeDocumentFact, parseJson, parseYaml } from "./document-facts.mjs";
import { matchesAny } from "./utils/path-patterns.mjs";

export const REQUIREMENT_RELATION_KINDS = [
  "requires",
  "implements",
  "verifies",
  "documents",
  "immutable",
] as const;

export type RequirementRelationKind = typeof REQUIREMENT_RELATION_KINDS[number];
export type RequirementAuthoritySnapshot = "base" | "head";
export type RequirementAuthorityFormat = "json" | "yaml";

export interface RequirementAuthoritySource {
  path: string;
  format: RequirementAuthorityFormat;
  content: string;
}

export interface RequirementAuthorityScopeEntry {
  glob: string;
  format: RequirementAuthorityFormat;
}

export interface RequirementAuthorityInput {
  snapshot: RequirementAuthoritySnapshot;
  revision: string;
  scope?: readonly RequirementAuthorityScopeEntry[];
  sources: readonly RequirementAuthoritySource[];
}

export interface RequirementRelationProvenance {
  source_path: string;
  subject_pointer: "/id";
  artifact_pointer: string;
  relation_pointer: string;
  relation_origin: "explicit" | "legacy_artifact_presence";
  snapshot: RequirementAuthoritySnapshot;
  revision: string;
}

export interface RequirementRelationTuple {
  subject: string;
  relation: RequirementRelationKind;
  object: string;
  provenance: RequirementRelationProvenance;
}

export interface RequirementAuthorityManifestEntry {
  path: string;
  format: RequirementAuthorityFormat;
  sha256: string;
}

export interface RequirementRelationGraph {
  snapshot: RequirementAuthoritySnapshot;
  revision: string;
  authority_scope: RequirementAuthorityScopeEntry[];
  authority_scope_sha256: string;
  authority_manifest: RequirementAuthorityManifestEntry[];
  authority_sha256: string;
  graph_sha256: string;
  relations: RequirementRelationTuple[];
}

export interface RequirementRelationIdentity {
  subject: string;
  relation: RequirementRelationKind;
  object: string;
}

export interface RequirementRelationDelta {
  add: RequirementRelationIdentity[];
  remove: RequirementRelationIdentity[];
}

export interface RequirementTransitionGrant {
  base_authority_sha256: string;
  expected_head_authority_sha256: string;
  add: RequirementRelationIdentity[];
  remove: RequirementRelationIdentity[];
}

export interface RequirementTransitionAuthorizer {
  trusted?: unknown;
  source?: unknown;
}

export interface RequirementTransitionCheck {
  ok: boolean;
  required: boolean;
  authorized: boolean;
  reasons: string[];
  actual_delta: RequirementRelationDelta;
  base_authority_sha256: string;
  head_authority_sha256: string;
  authority_scope_changed: boolean;
}

type JsonObject = Record<string, unknown>;
const RELATION_KINDS = new Set<string>(REQUIREMENT_RELATION_KINDS);
const EXACT_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

function fail(label: string, message: string): never {
  throw new Error(`${label}: ${message}`);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(label, "must be an object");
  return value as JsonObject;
}

function exactFields(value: JsonObject, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const field of Object.keys(value)) if (!set.has(field)) fail(label, `unknown field "${field}" not allowed`);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) return fail(label, "must be an array");
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) return fail(label, "must be a non-empty string");
  return value.trim();
}

function repositoryPath(value: unknown, label: string): string {
  try {
    return normalizeDocumentFact(value, "repository_path", label) as string;
  } catch (error) {
    return fail(label, error instanceof Error ? error.message : String(error));
  }
}

function exactRevision(value: unknown, label: string): string {
  const revision = nonEmptyString(value, label).toLowerCase();
  if (!EXACT_COMMIT_SHA.test(revision)) return fail(label, "must be an exact 40-hex commit SHA");
  return revision;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Value(value: unknown, label: string): string {
  const digest = nonEmptyString(value, label).toLowerCase();
  if (!SHA256.test(digest)) return fail(label, "must be a 64-hex sha256 digest");
  return digest;
}

function relationKind(value: unknown, label: string): RequirementRelationKind {
  const relation = nonEmptyString(value, label);
  if (!RELATION_KINDS.has(relation)) return fail(label, `unknown relation "${relation}"`);
  return relation as RequirementRelationKind;
}

function relationIdentity(value: Pick<RequirementRelationTuple, "subject" | "relation" | "object">): RequirementRelationIdentity {
  return { subject: value.subject, relation: value.relation, object: value.object };
}

function identityKey(value: RequirementRelationIdentity): string {
  return JSON.stringify([value.subject, value.relation, value.object]);
}

function compareIdentities(left: RequirementRelationIdentity, right: RequirementRelationIdentity): number {
  return identityKey(left).localeCompare(identityKey(right));
}

function canonicalIdentities(values: readonly RequirementRelationIdentity[]): RequirementRelationIdentity[] {
  return [...values].map((value) => ({ ...value })).sort(compareIdentities);
}

function normalizeAuthorityScope(values: readonly RequirementAuthorityScopeEntry[] | undefined): RequirementAuthorityScopeEntry[] {
  const byGlob = new Map<string, RequirementAuthorityFormat>();
  for (const [index, value] of (values || []).entries()) {
    const glob = nonEmptyString(value?.glob, `RequirementAuthority.scope[${index}].glob`);
    const format = value?.format;
    if (format !== "json" && format !== "yaml") fail(`RequirementAuthority.scope[${index}].format`, "must be json or yaml");
    const previous = byGlob.get(glob);
    if (previous && previous !== format) fail(`RequirementAuthority.scope[${index}]`, `glob "${glob}" has conflicting formats`);
    byGlob.set(glob, format);
  }
  return [...byGlob.entries()].map(([glob, format]) => ({ glob, format })).sort((left, right) => left.glob.localeCompare(right.glob) || left.format.localeCompare(right.format));
}

function parseSource(source: RequirementAuthoritySource): unknown {
  if (source.format === "json") return parseJson(source.content);
  if (source.format === "yaml") return parseYaml(source.content);
  const exhaustive: never = source.format;
  return fail(source.path, `unsupported format "${String(exhaustive)}"`);
}

function normalizeSourceRelations(source: RequirementAuthoritySource, snapshot: RequirementAuthoritySnapshot, revision: string): { subject: string; relations: RequirementRelationTuple[] } {
  const root = object(parseSource(source), source.path);
  const subject = nonEmptyString(root.id, `${source.path}#/id`);
  const artifacts = root.artifacts === undefined ? [] : array(root.artifacts, `${source.path}#/artifacts`);
  const seenPaths = new Set<string>();
  const relations: RequirementRelationTuple[] = [];

  for (const [artifactIndex, artifactValue] of artifacts.entries()) {
    const artifactPointer = `/artifacts/${artifactIndex}`;
    const artifact = object(artifactValue, `${source.path}#${artifactPointer}`);
    exactFields(artifact, ["path", "relations", "role"], `${source.path}#${artifactPointer}`);
    const path = repositoryPath(artifact.path, `${source.path}#${artifactPointer}/path`);
    if (seenPaths.has(path)) fail(`${source.path}#${artifactPointer}/path`, `duplicate artifact path "${path}"`);
    seenPaths.add(path);
    if (artifact.relations === undefined) {
      relations.push({
        subject,
        relation: "requires",
        object: path,
        provenance: {
          source_path: source.path,
          subject_pointer: "/id",
          artifact_pointer: `${artifactPointer}/path`,
          relation_pointer: `${artifactPointer}/path`,
          relation_origin: "legacy_artifact_presence",
          snapshot,
          revision,
        },
      });
      continue;
    }
    const rawRelations = array(artifact.relations, `${source.path}#${artifactPointer}/relations`);
    if (!rawRelations.length) fail(`${source.path}#${artifactPointer}/relations`, "must contain at least one relation");
    const seenRelations = new Set<RequirementRelationKind>();
    for (const [relationIndex, relationValue] of rawRelations.entries()) {
      const relationPointer = `${artifactPointer}/relations/${relationIndex}`;
      const relation = relationKind(relationValue, `${source.path}#${relationPointer}`);
      if (seenRelations.has(relation)) fail(`${source.path}#${relationPointer}`, `duplicate relation "${relation}"`);
      seenRelations.add(relation);
      relations.push({
        subject,
        relation,
        object: path,
        provenance: {
          source_path: source.path,
          subject_pointer: "/id",
          artifact_pointer: `${artifactPointer}/path`,
          relation_pointer: relationPointer,
          relation_origin: "explicit",
          snapshot,
          revision,
        },
      });
    }
    if (!seenRelations.has("requires")) {
      fail(`${source.path}#${artifactPointer}/relations`, `artifact "${path}" must explicitly include "requires"`);
    }
  }
  return { subject, relations };
}

export function normalizeRequirementAuthority(input: RequirementAuthorityInput): RequirementRelationGraph {
  const snapshot = input?.snapshot;
  if (snapshot !== "base" && snapshot !== "head") fail("RequirementAuthority.snapshot", "must be base or head");
  const revision = exactRevision(input?.revision, "RequirementAuthority.revision");
  const scope = normalizeAuthorityScope(input?.scope);
  if (!Array.isArray(input?.sources)) fail("RequirementAuthority.sources", "must be an array");

  const sources = input.sources.map((value, index) => {
    const label = `RequirementAuthority.sources[${index}]`;
    const path = repositoryPath(value.path, `${label}.path`);
    if (value.format !== "json" && value.format !== "yaml") fail(`${label}.format`, "must be json or yaml");
    if (typeof value.content !== "string") fail(`${label}.content`, "must be UTF-8 text");
    return { path, format: value.format, content: value.content } as RequirementAuthoritySource;
  }).sort((left, right) => left.path.localeCompare(right.path));

  const seenSourcePaths = new Set<string>();
  const seenSubjects = new Map<string, string>();
  const relations: RequirementRelationTuple[] = [];
  const manifest: RequirementAuthorityManifestEntry[] = [];

  for (const source of sources) {
    if (seenSourcePaths.has(source.path)) fail(source.path, "duplicate authority source path");
    seenSourcePaths.add(source.path);
    const normalized = normalizeSourceRelations(source, snapshot, revision);
    const previous = seenSubjects.get(normalized.subject);
    if (previous) fail(source.path, `duplicate requirement id "${normalized.subject}" also declared by "${previous}"`);
    seenSubjects.set(normalized.subject, source.path);
    relations.push(...normalized.relations);
    manifest.push({ path: source.path, format: source.format, sha256: sha256(source.content) });
  }

  relations.sort((left, right) => compareIdentities(relationIdentity(left), relationIdentity(right)));
  const identities = relations.map(relationIdentity);
  const authorityScopeSha256 = sha256(JSON.stringify(scope));
  return {
    snapshot,
    revision,
    authority_scope: scope,
    authority_scope_sha256: authorityScopeSha256,
    authority_manifest: manifest,
    authority_sha256: sha256(JSON.stringify({ scope, manifest })),
    graph_sha256: sha256(JSON.stringify(identities)),
    relations,
  };
}

interface RequirementAuthorityPolicyProjection {
  anchors?: { types?: any };
  document_relations?: any;
}

export function requirementAuthorityScopeFromPolicy(policy: RequirementAuthorityPolicyProjection | null | undefined): RequirementAuthorityScopeEntry[] {
  const closed = policy?.document_relations?.rules?.some((rule: Record<string, unknown>) => rule.id === "requirements-strict:closed-repository" && rule.kind === "set_equal") === true;
  if (!closed) return [];
  const sources = policy?.anchors?.types?.requirement_artifact_path?.sources || [];
  return normalizeAuthorityScope(sources.flatMap((source: Record<string, unknown>) => {
    if (source.kind !== "structured_pointer" || source.pointer !== "/artifacts" || source.item_field !== "path") return [];
    if ((source.format !== "json" && source.format !== "yaml") || typeof source.glob !== "string") return [];
    return [{ glob: source.glob, format: source.format }];
  }));
}

export function buildRequirementAuthorityFromSnapshot(input: {
  policy: RequirementAuthorityPolicyProjection | null | undefined;
  snapshot: RequirementAuthoritySnapshot;
  revision: string;
  trackedFiles: readonly string[];
  readFileAtRef: (revision: string, path: string) => unknown;
}): RequirementRelationGraph | null {
  const scope = requirementAuthorityScopeFromPolicy(input.policy);
  if (!scope.length) return null;
  const sources: RequirementAuthoritySource[] = [];
  for (const pathValue of [...new Set(input.trackedFiles)].sort()) {
    const path = repositoryPath(pathValue, "RequirementAuthority.trackedFiles");
    const matching = scope.filter((entry) => matchesAny(path, [entry.glob]));
    if (!matching.length) continue;
    const formats = [...new Set(matching.map((entry) => entry.format))];
    if (formats.length !== 1) fail(path, "matches requirement authority globs with conflicting formats");
    const raw = input.readFileAtRef(input.revision, path);
    if (raw === null || raw === undefined) fail(path, `${input.snapshot.toUpperCase()} requirement authority source is unavailable`);
    sources.push({ path, format: formats[0]!, content: String(raw) });
  }
  return normalizeRequirementAuthority({ snapshot: input.snapshot, revision: input.revision, scope, sources });
}

export function compareRequirementRelationGraphs(base: RequirementRelationGraph, head: RequirementRelationGraph): RequirementRelationDelta {
  const baseMap = new Map(base.relations.map((relation) => [identityKey(relationIdentity(relation)), relationIdentity(relation)]));
  const headMap = new Map(head.relations.map((relation) => [identityKey(relationIdentity(relation)), relationIdentity(relation)]));
  return {
    add: canonicalIdentities([...headMap.entries()].filter(([key]) => !baseMap.has(key)).map(([, value]) => value)),
    remove: canonicalIdentities([...baseMap.entries()].filter(([key]) => !headMap.has(key)).map(([, value]) => value)),
  };
}

function normalizeGrantIdentity(value: unknown, label: string): RequirementRelationIdentity {
  const input = object(value, label);
  exactFields(input, ["subject", "relation", "object"], label);
  return {
    subject: nonEmptyString(input.subject, `${label}.subject`),
    relation: relationKind(input.relation, `${label}.relation`),
    object: repositoryPath(input.object, `${label}.object`),
  };
}

function normalizeGrantIdentities(value: unknown, label: string): RequirementRelationIdentity[] {
  if (value === undefined) return [];
  const normalized = array(value, label).map((item, index) => normalizeGrantIdentity(item, `${label}[${index}]`)).sort(compareIdentities);
  const seen = new Set<string>();
  for (const item of normalized) {
    const key = identityKey(item);
    if (seen.has(key)) fail(label, `duplicate relation tuple ${key}`);
    seen.add(key);
  }
  return normalized;
}

export function normalizeRequirementTransitionGrant(value: unknown): RequirementTransitionGrant {
  const input = object(value, "RequirementTransitionGrant");
  exactFields(input, ["base_authority_sha256", "expected_head_authority_sha256", "add", "remove"], "RequirementTransitionGrant");
  return {
    base_authority_sha256: sha256Value(input.base_authority_sha256, "RequirementTransitionGrant.base_authority_sha256"),
    expected_head_authority_sha256: sha256Value(input.expected_head_authority_sha256, "RequirementTransitionGrant.expected_head_authority_sha256"),
    add: normalizeGrantIdentities(input.add, "RequirementTransitionGrant.add"),
    remove: normalizeGrantIdentities(input.remove, "RequirementTransitionGrant.remove"),
  };
}

function sameIdentities(left: readonly RequirementRelationIdentity[], right: readonly RequirementRelationIdentity[]): boolean {
  return JSON.stringify(canonicalIdentities(left)) === JSON.stringify(canonicalIdentities(right));
}

export function checkRequirementTransition(input: {
  base: RequirementRelationGraph;
  head: RequirementRelationGraph;
  grant?: unknown;
  trustedAuthorizer?: RequirementTransitionAuthorizer | null;
}): RequirementTransitionCheck {
  const actual = compareRequirementRelationGraphs(input.base, input.head);
  const authorityScopeChanged = input.base.authority_scope_sha256 !== input.head.authority_scope_sha256;
  const required = authorityScopeChanged || actual.add.length > 0 || actual.remove.length > 0;
  const reasons: string[] = [];

  if (!required) {
    if (input.grant !== undefined && input.grant !== null) reasons.push("requirement_transition_grant_without_relation_delta");
    return {
      ok: reasons.length === 0,
      required: false,
      authorized: false,
      reasons,
      actual_delta: actual,
      base_authority_sha256: input.base.authority_sha256,
      head_authority_sha256: input.head.authority_sha256,
      authority_scope_changed: authorityScopeChanged,
    };
  }

  let grant: RequirementTransitionGrant | null = null;
  if (input.grant === undefined || input.grant === null) reasons.push("requirement_transition_grant_missing");
  else {
    try { grant = normalizeRequirementTransitionGrant(input.grant); }
    catch (error) { reasons.push(`requirement_transition_grant_invalid:${error instanceof Error ? error.message : String(error)}`); }
  }

  const trusted = input.trustedAuthorizer?.trusted === true && input.trustedAuthorizer?.source === "repository_permission";
  if (!trusted) reasons.push("requirement_transition_authorizer_untrusted");

  if (grant) {
    if (grant.base_authority_sha256 !== input.base.authority_sha256) reasons.push("requirement_transition_base_authority_mismatch");
    if (grant.expected_head_authority_sha256 !== input.head.authority_sha256) reasons.push("requirement_transition_head_authority_mismatch");
    if (!sameIdentities(grant.add, actual.add)) reasons.push("requirement_transition_added_relations_mismatch");
    if (!sameIdentities(grant.remove, actual.remove)) reasons.push("requirement_transition_removed_relations_mismatch");
  }

  return {
    ok: reasons.length === 0,
    required: true,
    authorized: reasons.length === 0,
    reasons,
    actual_delta: actual,
    base_authority_sha256: input.base.authority_sha256,
    head_authority_sha256: input.head.authority_sha256,
    authority_scope_changed: authorityScopeChanged,
  };
}
