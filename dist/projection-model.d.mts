export interface ProjectionSourceDependency {
    id: string;
    kind: "repository_content";
    path: string;
    algorithm: "sha256";
}
export type ProjectionTargetLocator = {
    kind: "markdown_anchor";
    anchor_id: string;
} | {
    kind: "markdown_owned_block";
    anchor_id: string;
    block_id: string;
    begin_marker: string;
    end_marker: string;
};
export interface ProjectionTarget {
    path: string;
    ownership: "hybrid" | "generated";
    locator?: ProjectionTargetLocator;
}
export interface ProjectionGeneratorContract {
    contract_id: string;
}
export interface ProjectionModel {
    schema: "repo-guard/projection-model/v0";
    id: string;
    sources: ProjectionSourceDependency[];
    target: ProjectionTarget;
    generator: ProjectionGeneratorContract;
    required_evidence: string[];
}
export interface ProjectionSourceIdentity {
    source_id: string;
    algorithm: "sha256";
    digest: string;
}
export interface ProjectionBuildGenerator {
    contract_id: string;
    tool_identity: string;
}
export interface ProjectionOutputIdentity {
    algorithm: "sha256";
    digest: string;
}
export interface ProjectionEvidenceReference {
    class: string;
    ref: string;
}
export interface ProjectionBuildRecord {
    schema: "repo-guard/projection-build-record/v0";
    projection_id: string;
    model_identity: string;
    source_identities: ProjectionSourceIdentity[];
    generator: ProjectionBuildGenerator;
    configuration_digest: string;
    output_identity: ProjectionOutputIdentity;
    evidence: ProjectionEvidenceReference[];
}
export declare function normalizeProjectionModel(value: unknown): ProjectionModel;
export declare function projectionModelIdentity(value: unknown): string;
export declare function normalizeProjectionBuildRecord(value: unknown, modelValue: unknown): ProjectionBuildRecord;
