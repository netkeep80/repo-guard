export type ProjectionInventoryState = "live" | "retained" | "base";
export type ProjectionOwnershipConflictCode = "invalid_projection" | "duplicate_projection_id" | "multiple_writers" | "live_retained_overlap" | "locator_alias" | "locator_drift" | "insufficient_locator" | "unreadable_target" | "malformed_target" | "containment" | "managed_overlap" | "unknown_origin";
export interface ProjectionOwnershipConflict {
    code: ProjectionOwnershipConflictCode;
    subject: string;
    path?: string;
    detail?: string;
}
export interface ProjectionObservedCandidate {
    identity: string;
    path: string;
    target_key?: string;
    detail?: string;
}
export interface ProjectionOwnershipReport {
    ok: boolean;
    ownership_closed: false;
    coverage: {
        status: "incomplete";
        expected_from: "live-and-retained-declarations";
        observed_from: "live-retained-and-base-declarations";
        candidate_marker_detection: "caller-supplied-only";
        arbitrary_undeclared_marker_scan: false;
    };
    live_expected: string[];
    retained: string[];
    base: string[];
    observed: string[];
    missing: string[];
    orphan: string[];
    unknown_origin: string[];
    conflicts: ProjectionOwnershipConflict[];
}
export interface ProjectionOwnershipInput {
    live: readonly unknown[];
    retained?: readonly unknown[];
    base?: readonly unknown[];
    observedCandidates?: readonly ProjectionObservedCandidate[];
    readHead: (path: string) => unknown;
}
export declare function analyzeProjectionOwnership(input: ProjectionOwnershipInput): ProjectionOwnershipReport;
