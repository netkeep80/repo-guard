import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ParsedDiffFile } from "./diff/parser.mjs";
import { normalizeDocumentFact, parseJson, parseYaml } from "./document-facts.mjs";
import { compareSets, evaluatePrimitiveRelation, type RelationEvaluationFacts } from "./checks/relation-kernel.mjs";
import { normalizeProjectionModel, type ProjectionModel } from "./projection-model.mjs";
import { lowerProjectionVerification } from "./projection-lowering.mjs";
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

export interface RequirementTransactionEvidenceProjection {
  changed_implementation_paths: string[];
  changed_verification_paths: string[];
  implementation_requirements: string[];
  verification_requirements: string[];
  overlap_requirements: string[];
}

export interface VNextRequirementArtifact {
  path: string;
  relations: readonly RequirementRelationKind[];
}

export interface VNextRequirementNode {
  id: string;
  derives_from?: readonly string[];
  supersedes?: readonly string[];
  artifacts?: readonly VNextRequirementArtifact[];
}

export interface VNextGenerationSource {
  id: string;
  path: string;
}

export interface VNextGenerationRelation {
  relation: "generates";
  owner_requirement: string;
  projection_id: string;
  sources: readonly VNextGenerationSource[];
  target: string;
  generator_contract: string;
  required_evidence?: readonly string[];
}

export interface VNextJustificationClosureInput {
  trustedRootIds: readonly string[];
  requirements: readonly VNextRequirementNode[];
  generationRelations?: readonly VNextGenerationRelation[];
  trackedFiles: readonly string[];
}

export interface VNextJustificationClosureVerdict {
  ok: boolean;
  reasons: string[];
  reachableRequirements: string[];
  orphanRequirements: string[];
  justifiedArtifacts: string[];
  orphanTrackedArtifacts: string[];
  missingRequiredArtifacts: string[];
  requirementExplanations: Record<string, string[]>;
  artifactExplanations: Record<string, string[][]>;
  requirementDependents: Record<string, string[]>;
  supersededRequirements: string[];
  supersededBy: Record<string, string[]>;
  generatedArtifacts: string[];
}

export interface VNextSubjectIdentity {
  id: string;
  semantic_sha256: string;
}

export interface VNextTrustedAcceptanceDecision {
  decision_id: string;
  accepts_subject: string;
  accepts_semantic_sha256: string;
}

export interface VNextExactAcceptanceVerdict {
  accepted: boolean;
  matching_decisions: string[];
  stale_decisions: string[];
}

export interface VNextGenerationFreshnessVerdict {
  ok: boolean;
  reasons: string[];
  projection_id: string;
  relation_results: Array<{ relation_id: string; ok: boolean }>;
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

function uniqueStrings(value: unknown, label: string): string[] {
  const values = array(value, label).map((item, index) => nonEmptyString(item, `${label}[${index}]`));
  const unique = new Set(values);
  if (unique.size !== values.length) fail(label, "must not contain duplicates");
  return [...unique].sort();
}

function normalizeVNextGenerationRelation(raw: unknown, label = "VNextGenerationRelation"): VNextGenerationRelation {
  const value = object(raw, label);
  exactFields(value, [
    "relation",
    "owner_requirement",
    "projection_id",
    "sources",
    "target",
    "generator_contract",
    "required_evidence",
  ], label);
  if (value.relation !== "generates") fail(`${label}.relation`, 'must be "generates"');
  const owner = nonEmptyString(value.owner_requirement, `${label}.owner_requirement`);
  const projectionId = nonEmptyString(value.projection_id, `${label}.projection_id`);
  const sources = array(value.sources, `${label}.sources`).map((rawSource, index) => {
    const sourceLabel = `${label}.sources[${index}]`;
    const source = object(rawSource, sourceLabel);
    exactFields(source, ["id", "path"], sourceLabel);
    return {
      id: nonEmptyString(source.id, `${sourceLabel}.id`),
      path: repositoryPath(source.path, `${sourceLabel}.path`),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!sources.length) fail(`${label}.sources`, "must contain at least one source");
  if (new Set(sources.map((item) => item.id)).size !== sources.length) fail(`${label}.sources`, "duplicate source id");
  if (new Set(sources.map((item) => item.path)).size !== sources.length) fail(`${label}.sources`, "duplicate source path");
  const requiredEvidence = value.required_evidence === undefined
    ? []
    : uniqueStrings(value.required_evidence, `${label}.required_evidence`);
  return {
    relation: "generates",
    owner_requirement: owner,
    projection_id: projectionId,
    sources,
    target: repositoryPath(value.target, `${label}.target`),
    generator_contract: nonEmptyString(value.generator_contract, `${label}.generator_contract`),
    required_evidence: requiredEvidence,
  };
}

export function lowerVNextGenerationRelation(raw: unknown): ProjectionModel {
  const relation = normalizeVNextGenerationRelation(raw);
  return normalizeProjectionModel({
    schema: "repo-guard/projection-model/v0",
    id: relation.projection_id,
    sources: relation.sources.map((source) => ({
      id: source.id,
      kind: "repository_content",
      path: source.path,
      algorithm: "sha256",
    })),
    target: {
      path: relation.target,
      ownership: "generated",
    },
    generator: {
      contract_id: relation.generator_contract,
    },
    required_evidence: relation.required_evidence || [],
  });
}

export function evaluateVNextGenerationFreshness(input: {
  relation: unknown;
  buildRecord: unknown;
  facts: RelationEvaluationFacts;
}): VNextGenerationFreshnessVerdict {
  const relation = normalizeVNextGenerationRelation(input?.relation);
  const model = lowerVNextGenerationRelation(relation);
  const lowered = lowerProjectionVerification(model, input?.buildRecord);
  const relationResults = lowered.map((primitive) => {
    const result = evaluatePrimitiveRelation(input.facts, primitive);
    return { relation_id: primitive.relation_id, ok: Boolean(result.ok) };
  });
  const reasons = relationResults.filter((result) => !result.ok)
    .map((result) => `projection_identity_mismatch:${result.relation_id}`)
    .sort();
  return {
    ok: reasons.length === 0,
    reasons,
    projection_id: relation.projection_id,
    relation_results: relationResults,
  };
}

export function evaluateVNextJustificationClosure(input: VNextJustificationClosureInput): VNextJustificationClosureVerdict {
  const trustedRootIds = uniqueStrings(input?.trustedRootIds, "VNextJustification.trustedRootIds");
  if (!Array.isArray(input?.requirements)) fail("VNextJustification.requirements", "must be an array");
  if (input?.generationRelations !== undefined && !Array.isArray(input.generationRelations)) {
    fail("VNextJustification.generationRelations", "must be an array");
  }
  const generationRelations = (input?.generationRelations || [])
    .map((relation, index) => normalizeVNextGenerationRelation(relation, `VNextJustification.generationRelations[${index}]`));
  const trackedFiles = normalizeDocumentFact(input?.trackedFiles, "repository_path_set", "VNextJustification.trackedFiles") as string[];

  const requirements = input.requirements.map((raw, index) => {
    const label = `VNextJustification.requirements[${index}]`;
    const value = object(raw, label);
    exactFields(value, ["id", "derives_from", "supersedes", "artifacts"], label);
    const id = nonEmptyString(value.id, `${label}.id`);
    const derivesFrom = value.derives_from === undefined ? [] : uniqueStrings(value.derives_from, `${label}.derives_from`);
    const supersedes = value.supersedes === undefined ? [] : uniqueStrings(value.supersedes, `${label}.supersedes`);
    if (supersedes.includes(id)) fail(`${label}.supersedes`, "requirement must not supersede itself");
    const artifacts = value.artifacts === undefined ? [] : array(value.artifacts, `${label}.artifacts`).map((rawArtifact, artifactIndex) => {
      const artifactLabel = `${label}.artifacts[${artifactIndex}]`;
      const artifact = object(rawArtifact, artifactLabel);
      exactFields(artifact, ["path", "relations"], artifactLabel);
      const path = repositoryPath(artifact.path, `${artifactLabel}.path`);
      const relations = array(artifact.relations, `${artifactLabel}.relations`).map((rawRelation, relationIndex) =>
        relationKind(rawRelation, `${artifactLabel}.relations[${relationIndex}]`));
      if (!relations.length) fail(`${artifactLabel}.relations`, "must contain at least one relation");
      if (new Set(relations).size !== relations.length) fail(`${artifactLabel}.relations`, "must not contain duplicates");
      return { path, relations: [...relations].sort() };
    });
    const artifactPaths = artifacts.map((artifact) => artifact.path);
    if (new Set(artifactPaths).size !== artifactPaths.length) fail(`${label}.artifacts`, "must not contain duplicate paths");
    return { id, derivesFrom, supersedes, artifacts };
  });

  const byId = new Map<string, typeof requirements[number]>();
  for (const requirement of requirements) {
    if (byId.has(requirement.id)) fail("VNextJustification.requirements", `duplicate requirement id "${requirement.id}"`);
    byId.set(requirement.id, requirement);
  }

  const reasons: string[] = [];
  const seenProjectionIds = new Set<string>();
  for (const relation of generationRelations) {
    if (seenProjectionIds.has(relation.projection_id)) {
      fail("VNextJustification.generationRelations", `duplicate projection id "${relation.projection_id}"`);
    }
    seenProjectionIds.add(relation.projection_id);
    if (!byId.has(relation.owner_requirement)) {
      reasons.push(`unknown_generation_owner:${relation.projection_id}:${relation.owner_requirement}`);
    }
  }
  const children = new Map<string, string[]>();
  const dependents = new Map<string, Set<string>>();
  const supersededBy = new Map<string, Set<string>>();
  const superseded = new Set<string>();
  for (const requirement of requirements) {
    for (const predecessor of requirement.supersedes) {
      if (!byId.has(predecessor)) {
        reasons.push(`unknown_superseded_requirement:${requirement.id}:${predecessor}`);
        continue;
      }
      superseded.add(predecessor);
      const successors = supersededBy.get(predecessor) || new Set<string>();
      successors.add(requirement.id);
      supersededBy.set(predecessor, successors);
    }
    for (const parent of requirement.derivesFrom) {
      if (!byId.has(parent)) {
        reasons.push(`unknown_requirement_parent:${requirement.id}:${parent}`);
        continue;
      }
      const childList = children.get(parent) || [];
      childList.push(requirement.id);
      children.set(parent, childList);
      const reverse = dependents.get(parent) || new Set<string>();
      reverse.add(requirement.id);
      dependents.set(parent, reverse);
    }
  }
  for (const values of children.values()) values.sort();

  const reachable = new Set<string>();
  const explanations = new Map<string, string[]>();
  const queue: string[] = [];
  for (const root of trustedRootIds) {
    if (!byId.has(root)) {
      reasons.push(`trusted_root_missing:${root}`);
      continue;
    }
    if (!reachable.has(root)) {
      reachable.add(root);
      explanations.set(root, [root]);
      queue.push(root);
    }
  }
  queue.sort();

  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) || []) {
      if (reachable.has(child)) continue;
      reachable.add(child);
      explanations.set(child, [...(explanations.get(parent) || [parent]), child]);
      queue.push(child);
    }
    queue.sort();
  }

  const allRequirementIds = [...byId.keys()].sort();
  const reachableRequirements = [...reachable].sort();
  const requirementComparison = compareSets(allRequirementIds, reachableRequirements, "equal");
  const orphanRequirements = [...requirementComparison.missing].sort();
  for (const id of orphanRequirements) reasons.push(`orphan_requirement:${id}`);

  const justified = new Set<string>();
  const artifactExplanations = new Map<string, string[][]>();
  for (const requirementId of reachableRequirements) {
    const requirement = byId.get(requirementId)!;
    for (const artifact of requirement.artifacts) {
      if (!artifact.relations.includes("requires")) continue;
      justified.add(artifact.path);
      const paths = artifactExplanations.get(artifact.path) || [];
      paths.push([...(explanations.get(requirementId) || [requirementId]), `requires:${artifact.path}`]);
      artifactExplanations.set(artifact.path, paths);
    }
  }
  const generatedArtifacts = new Set<string>();
  for (const relation of generationRelations) {
    if (!reachable.has(relation.owner_requirement)) {
      if (byId.has(relation.owner_requirement)) {
        reasons.push(`unreachable_generation_owner:${relation.projection_id}:${relation.owner_requirement}`);
      }
      continue;
    }
    justified.add(relation.target);
    generatedArtifacts.add(relation.target);
    const paths = artifactExplanations.get(relation.target) || [];
    paths.push([
      ...(explanations.get(relation.owner_requirement) || [relation.owner_requirement]),
      `generates:${relation.projection_id}:${relation.target}`,
    ]);
    artifactExplanations.set(relation.target, paths);
  }
  for (const relation of generationRelations) {
    if (!reachable.has(relation.owner_requirement)) continue;
    for (const source of relation.sources) {
      if (!justified.has(source.path)) {
        reasons.push(`projection_source_not_justified:${relation.projection_id}:${source.path}`);
      }
    }
  }

  const justifiedArtifacts = [...justified].sort();
  const artifactComparison = compareSets(trackedFiles, justifiedArtifacts, "equal");
  const orphanTrackedArtifacts = [...artifactComparison.missing].sort();
  const missingRequiredArtifacts = [...artifactComparison.extra].sort();
  for (const path of orphanTrackedArtifacts) reasons.push(`orphan_tracked_artifact:${path}`);
  for (const path of missingRequiredArtifacts) reasons.push(`required_artifact_not_tracked:${path}`);

  const requirementExplanations = Object.fromEntries(
    [...explanations.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const artifactExplanationObject = Object.fromEntries(
    [...artifactExplanations.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, paths]) => [path, paths.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]),
  );
  const requirementDependents = Object.fromEntries(
    [...dependents.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, values]) => [id, [...values].sort()]),
  );
  const supersededByObject = Object.fromEntries(
    [...supersededBy.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, values]) => [id, [...values].sort()]),
  );
  const uniqueReasons = [...new Set(reasons)].sort();
  return {
    ok: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    reachableRequirements,
    orphanRequirements,
    justifiedArtifacts,
    orphanTrackedArtifacts,
    missingRequiredArtifacts,
    requirementExplanations,
    artifactExplanations: artifactExplanationObject,
    requirementDependents,
    supersededRequirements: [...superseded].sort(),
    supersededBy: supersededByObject,
    generatedArtifacts: [...generatedArtifacts].sort(),
  };
}

export function evaluateVNextExactAcceptance(input: {
  subject: VNextSubjectIdentity;
  trustedDecisions: readonly VNextTrustedAcceptanceDecision[];
}): VNextExactAcceptanceVerdict {
  const subjectValue = object(input?.subject, "VNextAcceptance.subject");
  exactFields(subjectValue, ["id", "semantic_sha256"], "VNextAcceptance.subject");
  const subjectId = nonEmptyString(subjectValue.id, "VNextAcceptance.subject.id");
  const subjectDigest = sha256Value(subjectValue.semantic_sha256, "VNextAcceptance.subject.semantic_sha256");
  if (!Array.isArray(input?.trustedDecisions)) fail("VNextAcceptance.trustedDecisions", "must be an array");

  const seenDecisionIds = new Set<string>();
  const matching: string[] = [];
  const stale: string[] = [];
  for (const [index, raw] of input.trustedDecisions.entries()) {
    const label = `VNextAcceptance.trustedDecisions[${index}]`;
    const decision = object(raw, label);
    exactFields(decision, ["decision_id", "accepts_subject", "accepts_semantic_sha256"], label);
    const decisionId = nonEmptyString(decision.decision_id, `${label}.decision_id`);
    if (seenDecisionIds.has(decisionId)) fail(`${label}.decision_id`, `duplicate decision id "${decisionId}"`);
    seenDecisionIds.add(decisionId);
    const acceptedSubject = nonEmptyString(decision.accepts_subject, `${label}.accepts_subject`);
    const acceptedDigest = sha256Value(decision.accepts_semantic_sha256, `${label}.accepts_semantic_sha256`);
    if (acceptedSubject !== subjectId) continue;
    if (acceptedDigest === subjectDigest) matching.push(decisionId);
    else stale.push(decisionId);
  }
  matching.sort();
  stale.sort();
  return {
    accepted: matching.length > 0,
    matching_decisions: matching,
    stale_decisions: stale,
  };
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
  paths?: { governance_paths?: unknown };
}

export function requirementAuthorityScopeFromPolicy(policy: RequirementAuthorityPolicyProjection | null | undefined): RequirementAuthorityScopeEntry[] {
  const closed = policy?.document_relations?.rules?.some((rule: Record<string, unknown>) => rule.id === "requirements-strict:closed-repository" && rule.kind === "set_equal") === true;
  const governed = Array.isArray(policy?.paths?.governance_paths) ? policy.paths.governance_paths : [];
  if (!closed && !governed.length) return [];
  const sources = closed ? policy?.anchors?.types?.requirement_artifact_path?.sources || [] : policy?.anchors?.types?.requirement_id?.sources || [];
  return normalizeAuthorityScope(sources.flatMap((source: Record<string, unknown>) => {
    if (typeof source.glob !== "string") return [];
    if (closed && source.kind === "structured_pointer" && source.pointer === "/artifacts" && source.item_field === "path"
      && (source.format === "json" || source.format === "yaml")) return [{ glob: source.glob, format: source.format }];
    if (!closed && source.kind === "structured_pointer" && source.pointer === "/id" && source.format === "yaml") return [{ glob: source.glob, format: "yaml" }];
    if (!closed && source.kind === "json_field" && source.field === "id") return [{ glob: source.glob, format: "json" }];
    return [];
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
  const closed = input.policy?.document_relations?.rules?.some((rule: Record<string, unknown>) => rule.id === "requirements-strict:closed-repository") === true;
  const patterns = input.policy?.paths?.governance_paths;
  const governed = (Array.isArray(patterns) ? patterns : []).filter((value): value is string => typeof value === "string").map((pattern) => pattern.endsWith("/") ? `${pattern}**` : pattern);
  const sources: RequirementAuthoritySource[] = [];
  for (const pathValue of [...new Set(input.trackedFiles)].sort()) {
    const path = repositoryPath(pathValue, "RequirementAuthority.trackedFiles");
    if (!closed && !matchesAny(path, governed)) continue;
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

function uniqueSortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function projectRequirementTransactionEvidence(input: {
  base: RequirementRelationGraph;
  head: RequirementRelationGraph;
  changedFiles: readonly ParsedDiffFile[];
}): RequirementTransactionEvidenceProjection {
  const changedIdentityPaths = new Set<string>();
  const changedHeadPaths = new Set<string>();
  for (const file of input.changedFiles) {
    changedIdentityPaths.add(file.path);
    if (file.previousPath) changedIdentityPaths.add(file.previousPath);
    if (file.status !== "deleted") changedHeadPaths.add(file.path);
  }

  const implementationRelations = [...input.base.relations, ...input.head.relations].filter((relation) =>
    relation.relation === "implements"
    && relation.object.startsWith("src/")
    && changedIdentityPaths.has(relation.object));
  const verificationRelations = input.head.relations.filter((relation) =>
    relation.relation === "verifies"
    && relation.object.startsWith("tests/")
    && changedHeadPaths.has(relation.object));

  const implementationRequirements = uniqueSortedStrings(implementationRelations.map((relation) => relation.subject));
  const verificationRequirements = uniqueSortedStrings(verificationRelations.map((relation) => relation.subject));
  const verificationSet = new Set(verificationRequirements);
  return {
    changed_implementation_paths: uniqueSortedStrings(implementationRelations.map((relation) => relation.object)),
    changed_verification_paths: uniqueSortedStrings(verificationRelations.map((relation) => relation.object)),
    implementation_requirements: implementationRequirements,
    verification_requirements: verificationRequirements,
    overlap_requirements: implementationRequirements.filter((subject) => verificationSet.has(subject)),
  };
}

export function evaluateVNextRequirementVerificationCoverage(input: {
  base: RequirementRelationGraph;
  head: RequirementRelationGraph;
  changedFiles: readonly ParsedDiffFile[];
}): RequirementTransactionEvidenceProjection & { ok: boolean; missing_verification_requirements: string[] } {
  const projection = projectRequirementTransactionEvidence(input);
  const coverage = compareSets(
    projection.implementation_requirements,
    projection.verification_requirements,
    "left_subset",
  );
  return {
    ...projection,
    ok: coverage.ok,
    missing_verification_requirements: [...coverage.missing].sort(),
  };
}

export function compareRequirementRelationGraphs(base: RequirementRelationGraph, head: RequirementRelationGraph): RequirementRelationDelta {
  const baseMap = new Map(base.relations.map((relation) => [identityKey(relationIdentity(relation)), relationIdentity(relation)]));
  const headMap = new Map(head.relations.map((relation) => [identityKey(relationIdentity(relation)), relationIdentity(relation)]));
  return {
    add: canonicalIdentities([...headMap.entries()].filter(([key]) => !baseMap.has(key)).map(([, value]) => value)),
    remove: canonicalIdentities([...baseMap.entries()].filter(([key]) => !headMap.has(key)).map(([, value]) => value)),
  };
}

/**
 * A derived BASE-authorized trace transition, never an external GovernanceGrant.
 * Normative fields and existing artifact metadata must be identical.
 */
export function checkRoutineRequirementTransition(input: {
  base: RequirementRelationGraph;
  head: RequirementRelationGraph;
  changedFiles: readonly ParsedDiffFile[];
  headTrackedFiles: readonly string[];
  readFileAtRef: (revision: string, path: string) => unknown;
  governancePaths: readonly string[];
  forbiddenPaths: readonly string[];
  closedRepository: boolean;
}): { ok: boolean; reasons: string[]; requirement_paths: string[] } {
  const reasons: string[] = [];
  const delta = compareRequirementRelationGraphs(input.base, input.head);
  const basePaths = input.base.authority_manifest.map((entry) => entry.path);
  const headPaths = input.head.authority_manifest.map((entry) => entry.path);
  if (input.base.authority_scope_sha256 !== input.head.authority_scope_sha256) reasons.push("routine_authority_scope_changed");
  if (!isDeepStrictEqual(basePaths, headPaths)) reasons.push("routine_requirement_sources_changed");
  if (!delta.add.length || delta.remove.length) reasons.push("routine_requires_additive_relation_delta");
  const changed = new Map(input.changedFiles.map((file) => [file.path, file]));
  const tracked = new Set(input.headTrackedFiles);
  const expand = (patterns: readonly string[]) => patterns.map((pattern) => pattern.endsWith("/") ? `${pattern}**` : pattern);
  const governance = expand(input.governancePaths), forbidden = expand(input.forbiddenPaths);
  const typed = new Set(delta.add.filter((edge) => ["implements", "verifies", "documents"].includes(edge.relation)).map((edge) => edge.object));
  if (!typed.size) reasons.push("routine_requires_typed_evidence");
  const grouped = new Map<string, Set<RequirementRelationKind>>();
  for (const edge of delta.add) {
    const kinds = grouped.get(edge.object) || new Set<RequirementRelationKind>();
    kinds.add(edge.relation);
    grouped.set(edge.object, kinds);
    const file = changed.get(edge.object);
    if (!file || file.status === "deleted" || file.previousPath || !tracked.has(edge.object)) {
      reasons.push(`routine_target_not_exact_changed_file:${edge.object}`);
    }
    if (edge.relation === "immutable" || matchesAny(edge.object, governance) || matchesAny(edge.object, forbidden)) {
      reasons.push(`routine_target_protected:${edge.object}`);
    }
  }
  if (input.closedRepository) for (const [path, kinds] of grouped) {
    if (![...kinds].some((kind) => kind === "implements" || kind === "verifies" || kind === "documents")) {
      reasons.push(`routine_untyped_closed_repository_justification:${path}`);
    }
  }
  for (const path of basePaths) {
    const rawBase = input.readFileAtRef(input.base.revision, path);
    const rawHead = input.readFileAtRef(input.head.revision, path);
    const format = input.base.authority_manifest.find((entry) => entry.path === path)!.format;
    if (typeof rawBase !== "string" || typeof rawHead !== "string") {
      reasons.push(`routine_requirement_snapshot_unavailable:${path}`);
      continue;
    }
    const before = object(parseSource({ path, format, content: rawBase }), `${path}:base`);
    const after = object(parseSource({ path, format, content: rawHead }), `${path}:head`);
    const normative = (root: JsonObject) => Object.fromEntries(Object.entries(root).filter(([key]) => key !== "artifacts"));
    if (!isDeepStrictEqual(normative(before), normative(after))) {
      reasons.push(`routine_normative_semantics_changed:${path}`);
    }
    const metadata = (root: JsonObject) => new Map(
      (root.artifacts === undefined ? [] : array(root.artifacts, `${path}#/artifacts`)).map((value, index) => {
        const artifact = object(value, `${path}#/artifacts/${index}`);
        const name = repositoryPath(artifact.path, `${path}#/artifacts/${index}/path`);
        return [name, Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "relations"))] as const;
      })
    );
    const oldMetadata = metadata(before), newMetadata = metadata(after);
    for (const [artifactPath, oldValue] of oldMetadata) {
      if (newMetadata.has(artifactPath) && !isDeepStrictEqual(oldValue, newMetadata.get(artifactPath))) {
        reasons.push(`routine_artifact_authority_changed:${artifactPath}`);
      }
    }
    for (const [artifactPath, current] of newMetadata) {
      if (!oldMetadata.has(artifactPath) && ["governance", "requirement", "immutable", "authority", "contract"].includes(String(current.role ?? "").toLowerCase())) {
        reasons.push(`routine_new_protected_artifact_role:${artifactPath}`);
      }
    }
  }
  const requirementPaths = basePaths.filter((path) => changed.has(path));
  if (!requirementPaths.length) reasons.push("routine_requirement_diff_missing");
  return { ok: reasons.length === 0, reasons, requirement_paths: reasons.length === 0 ? requirementPaths : [] };
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
