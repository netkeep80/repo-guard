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
  ProjectionSourceDependency,
  ProjectionSourceIdentity,
  ProjectionTarget,
  ProjectionTargetLocator,
} from "./projection-model.mjs";

export { analyzeProjection } from "./projection-analysis.mjs";
export type {
  ProjectionAnalysis,
  ProjectionFreshness,
  ProjectionImpact,
} from "./projection-analysis.mjs";
