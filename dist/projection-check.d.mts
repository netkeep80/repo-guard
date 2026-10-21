import { type FactReadContext } from "./document-facts.mjs";
import { type ProjectionCurrentAnalysis, type ProjectionCurrentGeneratorIdentity } from "./projection-analysis.mjs";
import { type ProjectionBuildRecord, type ProjectionModel } from "./projection-model.mjs";
import { type ProjectionOwnershipReport } from "./projection-ownership.mjs";
export interface ProjectionCheckLiveEntry {
    state: "live";
    model: ProjectionModel;
    build: ProjectionBuildRecord;
    current_generator: ProjectionCurrentGeneratorIdentity;
}
export interface ProjectionCheckRetainedEntry {
    state: "retained";
    model: ProjectionModel;
}
export type ProjectionCheckEntry = ProjectionCheckLiveEntry | ProjectionCheckRetainedEntry;
export interface ProjectionCheckState {
    schema: "repo-guard/projection-check/v0";
    entries: ProjectionCheckEntry[];
    present: boolean;
}
export interface ProjectionCheckDiagnostic {
    code: string;
    subject: string;
    detail?: string;
}
export interface ProjectionCheckReport {
    ok: boolean;
    present: boolean;
    ownership: ProjectionOwnershipReport;
    analyses: ProjectionCurrentAnalysis[];
    diagnostics: ProjectionCheckDiagnostic[];
}
export interface ProjectionRequirementResolution {
    digest: string;
    path: string;
}
export type ProjectionRequirementResolver = (requirementId: string) => ProjectionRequirementResolution | null;
export declare function parseProjectionCheckState(raw: string | Uint8Array | null | undefined): ProjectionCheckState;
export declare function evaluateProjectionCheck(input: {
    baseRaw: string | Uint8Array | null | undefined;
    headRaw: string | Uint8Array | null | undefined;
    readHead: (path: string) => unknown;
    facts: FactReadContext;
    resolveRequirement?: ProjectionRequirementResolver;
}): ProjectionCheckReport;
