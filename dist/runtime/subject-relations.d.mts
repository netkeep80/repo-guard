export type SubjectRef = {
    kind: "requirement";
    id: string;
} | {
    kind: "resource";
    path: string;
    pointer?: string;
} | {
    kind: "relation";
    id: string;
};
export type RelationMeaning = "depends_on" | "derives_from" | "requires" | "trace";
export interface SubjectRelation {
    id?: string;
    meaning: RelationMeaning;
    role?: string;
    source: SubjectRef;
    target: SubjectRef;
}
export interface AcyclicRelationSelection {
    meaning: "depends_on";
    roles: readonly string[];
}
export interface SubjectRelationInput {
    subjects: readonly SubjectRef[];
    relations: readonly SubjectRelation[];
    roles?: readonly string[];
    acyclic?: readonly AcyclicRelationSelection[];
}
export interface SubjectRelationError {
    code: "invalid_subject" | "duplicate_subject" | "duplicate_relation_id" | "duplicate_relation" | "missing_subject" | "unknown_meaning" | "unknown_role" | "invalid_domain" | "invalid_acyclic_selection" | "relation_cycle";
    subject: string;
    detail?: string;
}
export interface SubjectRelationResult {
    ok: boolean;
    subjects: readonly SubjectRef[];
    relations: readonly SubjectRelation[];
    errors: readonly SubjectRelationError[];
}
export declare function normalizeSubjectRef(raw: SubjectRef): SubjectRef;
export declare function subjectRefKey(ref: SubjectRef): string;
export declare function evaluateSubjectRelations(input: SubjectRelationInput): SubjectRelationResult;
export declare function reverseImpact(relations: readonly SubjectRelation[], changed: SubjectRef, options?: {
    roles?: readonly string[];
}): SubjectRef[];
