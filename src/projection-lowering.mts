import type {
  DocumentPointerIdentityRegion,
  FactRef,
  MarkdownOwnedBlockIdentityRegion,
} from "./document-facts.mjs";
import type { PrimitiveRelation } from "./checks/relation-kernel.mjs";
import {
  normalizeProjectionBuildRecord,
  normalizeProjectionModel,
  type ProjectionBuildRecord,
  type ProjectionModel,
  type ProjectionSourceDependency,
} from "./projection-model.mjs";

type ProjectionIdentityRegion =
  | MarkdownOwnedBlockIdentityRegion
  | DocumentPointerIdentityRegion;

function contentIdentity(
  path: string,
  region?: ProjectionIdentityRegion,
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
  fact: Extract<FactRef, { source: "repository" }>,
  expectedDigest: string,
  metadata: Record<string, unknown>,
): PrimitiveRelation {
  return {
    relation_id: relationId,
    primitive: "scalar_equals_literal",
    operands: {
      source: fact,
    },
    parameters: {
      value: expectedDigest,
      ...metadata,
    },
  };
}

function documentPointerRegion(
  path: string,
  pointer: string | undefined,
): DocumentPointerIdentityRegion | undefined {
  if (pointer === undefined) return undefined;
  const lower = path.toLowerCase();
  const format = lower.endsWith(".json")
    ? "json"
    : lower.endsWith(".yaml") || lower.endsWith(".yml")
      ? "yaml"
      : null;
  if (!format) {
    throw new Error(
      `Projection repository_subject pointer requires a JSON/YAML resource path: "${path}"`,
    );
  }
  return { kind: "document_pointer", format, pointer };
}

export function projectionSourceContentFact(
  source: ProjectionSourceDependency,
): Extract<FactRef, { source: "repository" }> {
  if (source.kind === "repository_content") return contentIdentity(source.path);
  return contentIdentity(
    source.representation.path,
    documentPointerRegion(
      source.representation.path,
      source.representation.pointer,
    ),
  );
}

export function projectionTargetContentFact(
  model: ProjectionModel,
): Extract<FactRef, { source: "repository" }> {
  let region: MarkdownOwnedBlockIdentityRegion | undefined;
  if (model.target.ownership === "hybrid") {
    if (model.target.locator?.kind !== "markdown_owned_block") {
      throw new Error(
        `ProjectionModel "${model.id}" hybrid target requires a markdown_owned_block locator for address-local identity`,
      );
    }
    region = {
      kind: "markdown_owned_block",
      anchor_id: model.target.locator.anchor_id,
      block_id: model.target.locator.block_id,
      begin_marker: model.target.locator.begin_marker,
      end_marker: model.target.locator.end_marker,
    };
  }
  return contentIdentity(model.target.path, region);
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
      projectionSourceContentFact(source),
      identity.digest,
      {
        projection_id: model.id,
        projection_role: "source",
        source_id: source.id,
      },
    );
  });

  relations.push(scalarIdentityRelation(
    `${model.id}:target`,
    projectionTargetContentFact(model),
    build.output_identity.digest,
    {
      projection_id: model.id,
      projection_role: "target",
    },
  ));

  return relations;
}
