import { type FactReadContext } from "./document-facts.mjs";
export type ProjectionFreshness = "CURRENT" | "STALE" | "BROKEN";
export type ProjectionImpact = "AFFECTED" | "UNAFFECTED";
export interface ProjectionAnalysis {
    projection_id: string | null;
    freshness: ProjectionFreshness;
    impact?: ProjectionImpact;
    failed_relations: string[];
    affected_sources: string[];
}
export declare function analyzeProjection(modelValue: unknown, buildValue: unknown, facts: FactReadContext): ProjectionAnalysis;
