import { type FactFormat, type FactReadContext, type FactRef } from "../document-facts.mjs";
export type SetRelation = "equal" | "left_subset" | "right_subset";
export type RelationPhase = "transaction" | "state" | "both";
export type RelationStrictness = "incomparable";
export interface SetComparisonResult<T> {
    ok: boolean;
    missing: T[];
    extra: T[];
}
export interface RelationDocumentTarget {
    document?: string;
    path: string;
    format: FactFormat;
}
export interface PrimitiveRelation {
    relation_id: string;
    primitive: string;
    operands: Record<string, FactRef | RelationDocumentTarget>;
    parameters: Record<string, unknown>;
}
export interface RelationEvaluationFacts extends FactReadContext {
    trackedFiles?: string[];
}
export interface RelationDescriptor {
    kind: string;
    public: boolean;
    operands: readonly string[];
    documentOperands?: readonly string[];
    phase: RelationPhase;
    evaluate: (facts: RelationEvaluationFacts, relation: PrimitiveRelation) => unknown;
    strictness: RelationStrictness;
    identity: readonly string[];
    literal?: {
        source: string;
        value: string;
    };
    evidenceSource?: "repository_paths_exist";
    setComparison?: "equal" | "left_subset";
}
export declare function compareSets<T>(left?: readonly T[], right?: readonly T[], relation?: SetRelation): SetComparisonResult<T>;
export declare const implies: (trigger: unknown, evidence: unknown) => boolean;
export declare function relationDescriptors(): readonly RelationDescriptor[];
export declare function relationDescriptor(kind: string): RelationDescriptor;
export declare function relationDescriptorForSetComparison(comparison: "equal" | "left_subset"): RelationDescriptor;
export declare function evaluatePrimitiveRelation(facts: RelationEvaluationFacts, relation: PrimitiveRelation): unknown;
