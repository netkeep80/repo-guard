export { parseMarkdown } from "./markdown-parser.mjs";
export type {
  MarkdownCodeBlock,
  MarkdownDocument,
  MarkdownHeading,
  MarkdownLink,
  MarkdownParseError,
  MarkdownProseLine,
} from "./markdown-parser.mjs";

export {
  insertMarkdownChild,
  listMarkdownAnchorIds,
  listMarkdownChildren,
  listMarkdownSections,
  readMarkdownNode,
  readOwnedMarkdownBlock,
  replaceOwnedMarkdownBlock,
  resolveMarkdownAnchor,
} from "./markdown-structure.mjs";
export type {
  MarkdownAddress,
  MarkdownChildSpec,
  MarkdownDocumentMode,
  MarkdownNode,
  MarkdownOwnedBlock,
  MarkdownOwnedBlockSpec,
  MarkdownSection,
  MarkdownStructureOptions,
} from "./markdown-structure.mjs";

export {
  normalizeProjectionBuildRecord,
  normalizeProjectionModel,
  projectionModelIdentity,
} from "./projection-model.mjs";
export type {
  ProjectionBuildGenerator,
  ProjectionBuildRecord,
  ProjectionEvidenceReference,
  ProjectionGeneratorContract,
  ProjectionModel,
  ProjectionOutputIdentity,
  ProjectionRepositoryContentSourceDependency,
  ProjectionRepositoryResourceSubject,
  ProjectionRepositorySubjectSourceDependency,
  ProjectionSourceDependency,
  ProjectionSourceIdentity,
  ProjectionTarget,
  ProjectionTargetLocator,
} from "./projection-model.mjs";

export {
  analyzeProjection,
  analyzeProjectionCurrent,
} from "./projection-analysis.mjs";
export type {
  ProjectionAnalysis,
  ProjectionCurrentAnalysis,
  ProjectionCurrentGeneratorIdentity,
  ProjectionFreshness,
  ProjectionImpact,
  ProjectionResolvedSourceIdentity,
  ProjectionResolvedSources,
} from "./projection-analysis.mjs";

export {
  analyzeProjectionOwnership,
} from "./projection-ownership.mjs";
export type {
  ProjectionInventoryState,
  ProjectionObservedCandidate,
  ProjectionOwnershipConflict,
  ProjectionOwnershipConflictCode,
  ProjectionOwnershipInput,
  ProjectionOwnershipReport,
} from "./projection-ownership.mjs";

export {
  evaluateProjectionCheck,
} from "./projection-check.mjs";
export type {
  ProjectionCheckDiagnostic,
  ProjectionCheckEntry,
  ProjectionCheckLiveEntry,
  ProjectionCheckReport,
  ProjectionCheckRetainedEntry,
  ProjectionRequirementResolution,
  ProjectionRequirementResolver,
} from "./projection-check.mjs";
