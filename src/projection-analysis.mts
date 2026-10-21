import { readFact, type FactReadContext, type FactRef } from "./document-facts.mjs";
import { evaluatePrimitiveRelation, type PrimitiveRelation } from "./checks/relation-kernel.mjs";
import {
  lowerProjectionVerification,
  projectionSourceContentFact,
  projectionTargetContentFact,
} from "./projection-lowering.mjs";
import {
  normalizeProjectionBuildRecordDetached,
  normalizeProjectionModel,
  projectionModelIdentity,
  type ProjectionBuildRecord,
  type ProjectionModel,
  type ProjectionSourceDependency,
} from "./projection-model.mjs";

export type ProjectionFreshness = "CURRENT" | "STALE" | "BROKEN";
export type ProjectionImpact = "AFFECTED" | "UNAFFECTED";

export interface ProjectionAnalysis {
  projection_id: string | null;
  freshness: ProjectionFreshness;
  impact?: ProjectionImpact;
  failed_relations: string[];
  affected_sources: string[];
}

interface RelationResultLike {
  ok?: boolean;
  data?: {
    source?: {
      ok?: boolean;
    };
  };
}

function changedSourceFact(path: string): FactRef {
  return {
    source: "diff",
    selector: {
      kind: "changed_paths",
      patterns: [path],
      include_previous_paths: true,
    },
    type: "repository_path_set",
  };
}

function projectionSourcePath(
  source: ProjectionSourceDependency,
  resolved: ProjectionResolvedSources = {},
): string {
  if (source.kind === "repository_content") return source.path;
  const resolvedSource = resolved[source.id];
  if (resolvedSource) return resolvedSource.path;
  if (source.representation) return source.representation.path;
  throw new Error(`Projection SubjectRef source "${source.id}" is unresolved`);
}

function impactOf(
  model: ProjectionModel,
  facts: FactReadContext,
  resolved: ProjectionResolvedSources = {},
): { impact: ProjectionImpact; affected_sources: string[] } {
  const affectedSources: string[] = [];
  for (const source of model.sources) {
    const changed = readFact(facts, changedSourceFact(projectionSourcePath(source, resolved)));
    if (!changed.ok) {
      throw new Error(
        `Projection analysis impact unavailable for "${model.id}": ${changed.error.message}`,
      );
    }
    if (Array.isArray(changed.value) && changed.value.length > 0) {
      affectedSources.push(source.id);
    }
  }
  return {
    impact: affectedSources.length ? "AFFECTED" : "UNAFFECTED",
    affected_sources: affectedSources,
  };
}

function relationRole(relation: PrimitiveRelation): "source" | "target" | null {
  const role = relation.parameters.projection_role;
  return role === "source" || role === "target" ? role : null;
}

function sourceReadable(result: RelationResultLike): boolean {
  return result.data?.source?.ok !== false;
}

export function analyzeProjection(
  modelValue: unknown,
  buildValue: unknown,
  facts: FactReadContext,
): ProjectionAnalysis {
  let model: ProjectionModel;
  try {
    model = normalizeProjectionModel(modelValue);
  } catch {
    return {
      projection_id: null,
      freshness: "BROKEN",
      failed_relations: [],
      affected_sources: [],
    };
  }

  const impact = impactOf(model, facts);

  let relations: PrimitiveRelation[];
  try {
    relations = lowerProjectionVerification(model, buildValue);
  } catch {
    return {
      projection_id: model.id,
      freshness: "BROKEN",
      ...impact,
      failed_relations: [],
    };
  }

  const failed: Array<{
    relation: PrimitiveRelation;
    result: RelationResultLike;
  }> = [];

  for (const relation of relations) {
    let evaluated: unknown;
    try {
      evaluated = evaluatePrimitiveRelation(facts, relation);
    } catch {
      failed.push({
        relation,
        result: { ok: false, data: { source: { ok: false } } },
      });
      continue;
    }
    const result = evaluated as RelationResultLike;
    if (!result?.ok) failed.push({ relation, result });
  }

  if (!failed.length) {
    return {
      projection_id: model.id,
      freshness: "CURRENT",
      ...impact,
      failed_relations: [],
    };
  }

  const broken = failed.some(({ relation, result }) =>
    relationRole(relation) === "target" || !sourceReadable(result)
  );

  return {
    projection_id: model.id,
    freshness: broken ? "BROKEN" : "STALE",
    ...impact,
    failed_relations: failed.map(({ relation }) => relation.relation_id),
  };
}


export interface ProjectionCurrentGeneratorIdentity {
  tool_identity: string;
  configuration_digest: string;
}

export interface ProjectionResolvedSourceIdentity {
  digest: string;
  path: string;
}

export type ProjectionResolvedSources =
  Readonly<Record<string, ProjectionResolvedSourceIdentity>>;

export interface ProjectionCurrentAnalysis extends ProjectionAnalysis {
  reasons: string[];
  impact_scope: "declared-file-exact" | "file-conservative";
  verification_scope: {
    causal_inputs: "declared-only";
    renderer_semantics: "not-proven";
  };
}

function currentImpactScope(model: ProjectionModel): ProjectionCurrentAnalysis["impact_scope"] {
  return model.sources.some(
    (source) =>
      source.kind === "repository_subject"
      && (
        source.subject.kind !== "resource"
        || source.representation?.pointer !== undefined
      ),
  )
    ? "file-conservative"
    : "declared-file-exact";
}

function readIdentity(
  facts: FactReadContext,
  fact: FactRef,
): { ok: true; digest: string } | { ok: false } {
  try {
    const result = readFact(facts, fact);
    if (!result.ok || typeof result.value !== "string") return { ok: false };
    return { ok: true, digest: result.value };
  } catch {
    return { ok: false };
  }
}

function requiredEvidenceMissing(
  model: ProjectionModel,
  build: ProjectionBuildRecord,
): string[] {
  const present = new Set(build.evidence.map((item) => item.class));
  return model.required_evidence.filter((required) => !present.has(required)).sort();
}

export function analyzeProjectionCurrent(
  modelValue: unknown,
  buildValue: unknown,
  facts: FactReadContext,
  current: ProjectionCurrentGeneratorIdentity,
  resolvedSources: ProjectionResolvedSources = {},
): ProjectionCurrentAnalysis {
  let model: ProjectionModel;
  try {
    model = normalizeProjectionModel(modelValue);
  } catch {
    return {
      projection_id: null,
      freshness: "BROKEN",
      failed_relations: [],
      affected_sources: [],
      reasons: ["invalid_model"],
      impact_scope: "declared-file-exact",
      verification_scope: {
        causal_inputs: "declared-only",
        renderer_semantics: "not-proven",
      },
    };
  }

  let impact: ReturnType<typeof impactOf>;
  try {
    impact = impactOf(model, facts, resolvedSources);
  } catch {
    return {
      projection_id: model.id,
      freshness: "BROKEN",
      failed_relations: [],
      affected_sources: [],
      reasons: ["impact_unavailable"],
      impact_scope: currentImpactScope(model),
      verification_scope: {
        causal_inputs: "declared-only",
        renderer_semantics: "not-proven",
      },
    };
  }

  let build: ProjectionBuildRecord;
  try {
    build = normalizeProjectionBuildRecordDetached(buildValue);
  } catch {
    return {
      projection_id: model.id,
      freshness: "BROKEN",
      ...impact,
      failed_relations: [],
      reasons: ["build_record_invalid"],
      impact_scope: currentImpactScope(model),
      verification_scope: {
        causal_inputs: "declared-only",
        renderer_semantics: "not-proven",
      },
    };
  }

  const reasons: string[] = [];
  const failedRelations: string[] = [];
  let broken = false;
  let stale = false;

  if (build.projection_id !== model.id) {
    broken = true;
    reasons.push("projection_id_mismatch");
  }

  if (build.model_identity !== projectionModelIdentity(model)) {
    stale = true;
    reasons.push("model_changed");
  }

  if (build.generator.contract_id !== model.generator.contract_id) {
    stale = true;
    reasons.push("generator_contract_changed");
  }
  if (build.generator.tool_identity !== current.tool_identity) {
    stale = true;
    reasons.push("tool_identity_changed");
  }
  if (build.configuration_digest !== current.configuration_digest) {
    stale = true;
    reasons.push("configuration_changed");
  }

  for (const required of requiredEvidenceMissing(model, build)) {
    broken = true;
    reasons.push("required_evidence_missing:" + required);
  }

  const recordedSources = new Map(
    build.source_identities.map((identity) => [identity.source_id, identity]),
  );
  const currentSourceIds = new Set(model.sources.map((source) => source.id));

  for (const source of model.sources) {
    let identity: { ok: true; digest: string } | { ok: false };
    const resolved = resolvedSources[source.id];
    if (resolved) {
      identity = { ok: true, digest: resolved.digest };
    } else {
      try {
        identity = readIdentity(facts, projectionSourceContentFact(source));
      } catch {
        identity = { ok: false };
      }
    }
    if (!identity.ok) {
      broken = true;
      reasons.push("source_unresolved:" + source.id);
      failedRelations.push(`${model.id}:source:${source.id}`);
      continue;
    }

    const recorded = recordedSources.get(source.id);
    if (!recorded) {
      stale = true;
      reasons.push("source_set_changed:" + source.id);
      continue;
    }
    if (recorded.digest !== identity.digest) {
      stale = true;
      reasons.push("source_changed:" + source.id);
      failedRelations.push(`${model.id}:source:${source.id}`);
    }
  }

  for (const recorded of build.source_identities) {
    if (!currentSourceIds.has(recorded.source_id)) {
      stale = true;
      reasons.push("source_set_changed:" + recorded.source_id);
    }
  }

  let targetIdentity;
  try {
    targetIdentity = readIdentity(facts, projectionTargetContentFact(model));
  } catch {
    targetIdentity = { ok: false } as const;
  }
  if (!targetIdentity.ok) {
    broken = true;
    reasons.push("target_unresolved");
    failedRelations.push(`${model.id}:target`);
  } else if (targetIdentity.digest !== build.output_identity.digest) {
    broken = true;
    reasons.push("output_changed");
    failedRelations.push(`${model.id}:target`);
  }

  return {
    projection_id: model.id,
    freshness: broken ? "BROKEN" : stale ? "STALE" : "CURRENT",
    ...impact,
    failed_relations: [...new Set(failedRelations)].sort(),
    reasons: [...new Set(reasons)].sort(),
    impact_scope: currentImpactScope(model),
    verification_scope: {
      causal_inputs: "declared-only",
      renderer_semantics: "not-proven",
    },
  };
}
