import type { FactRef, MarkdownOwnedBlockIdentityRegion } from "./document-facts.mjs";
import type { PrimitiveRelation } from "./checks/relation-kernel.mjs";
import {
  normalizeProjectionBuildRecord,
  normalizeProjectionModel,
  type ProjectionBuildRecord,
  type ProjectionModel,
} from "./projection-model.mjs";

function contentIdentity(
  path: string,
  region?: MarkdownOwnedBlockIdentityRegion,
): Extract<FactRef, { source: "repository" }> {
  return {
    source: "repository",
    selector: {
      kind: "content_identity",
      path,
      snapshot: "state",
      algorithm: "sha256",
      ...(region ? { region } : {}),
    },
    type: "scalar",
  };
}

function scalarIdentityRelation(
  relationId: string,
  path: string,
  expectedDigest: string,
  metadata: Record<string, unknown>,
  region?: MarkdownOwnedBlockIdentityRegion,
): PrimitiveRelation {
  return {
    relation_id: relationId,
    primitive: "scalar_equals_literal",
    operands: {
      source: contentIdentity(path, region),
    },
    parameters: {
      value: expectedDigest,
      ...metadata,
    },
  };
}

function buildRecordFor(
  modelValue: unknown,
  buildValue: unknown,
): { model: ProjectionModel; build: ProjectionBuildRecord } {
  const model = normalizeProjectionModel(modelValue);
  const build = normalizeProjectionBuildRecord(buildValue, model);
  return { model, build };
}

export function lowerProjectionVerification(
  modelValue: unknown,
  buildValue: unknown,
): PrimitiveRelation[] {
  const { model, build } = buildRecordFor(modelValue, buildValue);
  const identities = new Map(build.source_identities.map((identity) => [identity.source_id, identity]));
  const relations = model.sources.map((source) => {
    const identity = identities.get(source.id);
    if (!identity) {
      throw new Error(`ProjectionBuildRecord missing normalized source identity "${source.id}"`);
    }
    return scalarIdentityRelation(
      `${model.id}:source:${source.id}`,
      source.path,
      identity.digest,
      {
        projection_id: model.id,
        projection_role: "source",
        source_id: source.id,
      },
    );
  });

  let targetRegion: MarkdownOwnedBlockIdentityRegion | undefined;
  if (model.target.ownership === "hybrid") {
    if (model.target.locator?.kind !== "markdown_owned_block") {
      throw new Error(
        `ProjectionModel "${model.id}" hybrid target requires a markdown_owned_block locator for address-local identity`,
      );
    }
    targetRegion = {
      kind: "markdown_owned_block",
      anchor_id: model.target.locator.anchor_id,
      block_id: model.target.locator.block_id,
      begin_marker: model.target.locator.begin_marker,
      end_marker: model.target.locator.end_marker,
    };
  }

  relations.push(scalarIdentityRelation(
    `${model.id}:target`,
    model.target.path,
    build.output_identity.digest,
    {
      projection_id: model.id,
      projection_role: "target",
    },
    targetRegion,
  ));

  return relations;
}
