type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
type ErrorClass = "invalid_canonical_source" | "duplicate_json_key" | "duplicate_requirement_id" | "malformed_requirement_id" | "unsafe_path" | "missing_fragment" | "malformed_pointer";
export interface CanonicalError {
    code: ErrorClass;
    path: string;
    message: string;
    otherPath?: string;
}
export interface SemanticRequirementSubject {
    kind: "semantic_requirement";
    repository: string;
    requirementId: string;
    digest: string;
}
export interface RequirementSourceIdentity {
    kind: "requirement_source";
    path: string;
}
export interface ExactRepresentationSubject {
    kind: "exact_representation";
    repository: string;
    revision: string;
    path: string;
    pointer: string;
}
export interface CanonicalRequirement {
    id: string;
    value: JsonValue;
    semantic: SemanticRequirementSubject;
    source: RequirementSourceIdentity;
    representation: ExactRepresentationSubject;
}
export interface CanonicalSnapshotInput {
    repository: string;
    revision: string;
    paths: readonly string[];
    readFile: (revision: string, path: string) => string | Buffer | null | undefined;
}
export interface CanonicalFragmentResult {
    ok: boolean;
    value?: JsonValue;
    identity?: ExactRepresentationSubject;
    error?: CanonicalError;
}
export interface CanonicalRequirementsResult {
    ok: boolean;
    requirements: readonly CanonicalRequirement[];
    index: Readonly<Record<string, CanonicalRequirement>>;
    errors: readonly CanonicalError[];
    resolveFragment: (id: string, pointer: string, options?: {
        durable?: boolean;
    }) => CanonicalFragmentResult;
}
export declare const canonicalSemanticDigest: (value: JsonValue) => string;
export declare function strictCanonicalJson(raw: string): JsonValue;
export declare function semanticRequirementSubject(repository: string, requirementId: string, semanticDigest: string): SemanticRequirementSubject;
export declare function exactRepresentationSubject(repository: string, revision: string, path: string, pointer?: string): ExactRepresentationSubject;
export declare function durablePointer(pointer: string): boolean;
export declare function loadCanonicalRequirements(input: CanonicalSnapshotInput): CanonicalRequirementsResult;
export type NativeRelationPredicate = "derives_from" | "requires" | "implemented_by" | "verified_by" | "documents" | "generates" | "depends_on" | "constrains" | "supersedes";
export type NativeResourceRef = {
    kind: "requirement";
    id: string;
} | {
    kind: "artifact";
    path: string;
} | {
    kind: "document";
    path: string;
    pointer: string;
} | {
    kind: "external_document";
    repository: string;
    revision: string;
    path: string;
    pointer: string;
};
export interface NativeRelationFact {
    source: NativeResourceRef;
    predicate: NativeRelationPredicate;
    target: NativeResourceRef;
    collection?: boolean;
}
export interface NativeLifecycle {
    accepted: boolean;
    current: boolean;
    published: boolean;
}
export interface NativeConstraintScope {
    relations: readonly NativeRelationPredicate[];
    include_generated: boolean;
}
export interface NativeConstraintMetric {
    key: string;
    max: number;
}
export interface NativeConstraintEvidence {
    class: "execution" | "domain";
    key: string;
    verifier?: NativeResourceRef;
}
export interface NativeConstraint {
    id: string;
    activation: "scoped_change" | "requirement_cause";
    scope: NativeConstraintScope;
    metric?: NativeConstraintMetric;
    evidence?: NativeConstraintEvidence;
}
export type NativeErrorCode = "invalid_native_document" | "duplicate_key" | "unknown_field" | "malformed_requirement_id" | "duplicate_requirement_id" | "unknown_predicate" | "invalid_relation" | "duplicate_relation" | "invalid_resource_ref" | "floating_external_revision" | "duplicate_constraint_id" | "invalid_constraint";
export interface NativeContractError {
    code: NativeErrorCode;
    path: string;
    message: string;
    otherPath?: string;
}
export interface NativeRequirement {
    id: string;
    normative: JsonValue;
    semantic: SemanticRequirementSubject;
    source: RequirementSourceIdentity;
    representation: ExactRepresentationSubject;
    lifecycle: NativeLifecycle;
    relations: readonly NativeRelationFact[];
    constraints: readonly NativeConstraint[];
}
export interface NativeRequirementsResult {
    ok: boolean;
    requirements: readonly NativeRequirement[];
    index: Readonly<Record<string, NativeRequirement>>;
    errors: readonly NativeContractError[];
}
export declare function loadNativeRequirements(input: CanonicalSnapshotInput): NativeRequirementsResult;
export {};
