import type { FactRef } from "./document-facts.mjs";
import type { PrimitiveRelation } from "./checks/relation-kernel.mjs";
import { type ProjectionModel, type ProjectionSourceDependency } from "./projection-model.mjs";
export declare function projectionSourceContentFact(source: ProjectionSourceDependency): Extract<FactRef, {
    source: "repository";
}>;
export declare function projectionTargetContentFact(model: ProjectionModel): Extract<FactRef, {
    source: "repository";
}>;
export declare function lowerProjectionVerification(modelValue: unknown, buildValue: unknown): PrimitiveRelation[];
