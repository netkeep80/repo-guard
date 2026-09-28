import { readFact, type FactReadContext, type FactRef } from "./document-facts.mjs";
import { evaluatePrimitiveRelation, type PrimitiveRelation } from "./checks/relation-kernel.mjs";
import { lowerProjectionVerification } from "./projection-lowering.mjs";
import {
  normalizeProjectionModel,
  type ProjectionModel,
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

function impactOf(
  model: ProjectionModel,
  facts: FactReadContext,
): { impact: ProjectionImpact; affected_sources: string[] } {
  const affectedSources: string[] = [];
  for (const source of model.sources) {
    const changed = readFact(facts, changedSourceFact(source.path));
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
