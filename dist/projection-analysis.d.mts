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
export interface ProjectionCurrentGeneratorIdentity {
    tool_identity: string;
    configuration_digest: string;
}
export interface ProjectionResolvedSourceIdentity {
    digest: string;
    path: string;
}
export type ProjectionResolvedSources = Readonly<Record<string, ProjectionResolvedSourceIdentity>>;
export interface ProjectionCurrentAnalysis extends ProjectionAnalysis {
    reasons: string[];
    impact_scope: "declared-file-exact" | "file-conservative";
    verification_scope: {
        causal_inputs: "declared-only";
        renderer_semantics: "not-proven";
    };
}
export declare function analyzeProjectionCurrent(modelValue: unknown, buildValue: unknown, facts: FactReadContext, current: ProjectionCurrentGeneratorIdentity, resolvedSources?: ProjectionResolvedSources): ProjectionCurrentAnalysis;
