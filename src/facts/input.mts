import { execFileSync } from "node:child_process";
import { createDocumentReader } from "../document-facts.mjs";
import { classifyNewFiles, detectTouchedSurfaces } from "../diff/classification.mjs";
import { filterOperationalPaths } from "../diff/filters.mjs";
import { parseDiff } from "../diff/parser.mjs";
import type { AnchorPolicyProjection } from "../extractors/anchors.mjs";
import { extractAnchors } from "../extractors/anchors.mjs";
import { extractIntegration } from "../extractors/integration.mjs";
import { readRepositoryBufferFile } from "../utils/repository-files.mjs";

type PathSelectorMap = Readonly<Record<string, readonly string[]>>;

export interface RepositoryFactsPolicyProjection extends AnchorPolicyProjection {
  paths: { operational_paths?: readonly string[] | null };
  surfaces?: PathSelectorMap | null;
  new_file_classes?: PathSelectorMap | null;
  integration?: unknown;
}

export interface RepositoryFactsEnforcement {
  mode: string;
  [key: string]: unknown;
}

export interface RepositoryFactsInput {
  mode?: string;
  repositoryRoot: string;
  policy: RepositoryFactsPolicyProjection;
  basePolicy?: unknown;
  headPolicy?: unknown;
  changeIntent?: unknown;
  changeIntentSource?: string;
  governanceGrant?: unknown;
  trustedGovernancePaths?: unknown;
  trustedAuthorizer?: unknown;
  enforcement: RepositoryFactsEnforcement;
  diffText: string;
  trackedFiles?: string[] | null;
  diagnostics?: Readonly<Record<string, unknown>>;
  readFile?: ((filePath: string) => unknown) | null;
}

export const listTrackedFiles = (repoRoot: string): string[] => execFileSync("git", ["ls-files"], { encoding: "utf-8", cwd: repoRoot }).split(/\r?\n/).filter(Boolean);

export function buildPolicyFacts(input: RepositoryFactsInput) {
  const {
    mode = "check-diff", repositoryRoot, policy, basePolicy = null, headPolicy = null,
    changeIntent = null, changeIntentSource = "none", governanceGrant = null,
    trustedGovernancePaths = null, trustedAuthorizer = null, enforcement, diffText,
    trackedFiles = null, diagnostics = {}, readFile = null,
  } = input;
  const allFiles = parseDiff(diffText);
  const checkedFiles = filterOperationalPaths(allFiles, policy.paths.operational_paths);
  const resolvedTrackedFiles = trackedFiles || listTrackedFiles(repositoryRoot), cache = new Map<string, Buffer | null>();
  const cachedReadFile = (path: string): Buffer | null => {
    if (!cache.has(path)) cache.set(path, readRepositoryBufferFile(path, { repoRoot: repositoryRoot, readFile } as Parameters<typeof readRepositoryBufferFile>[1]));
    return cache.get(path)!;
  };
  const documents = createDocumentReader({ repoRoot: repositoryRoot, readFile: cachedReadFile });
  const options = { repoRoot: repositoryRoot, trackedFiles: resolvedTrackedFiles, changedFiles: checkedFiles, readFile: cachedReadFile, documents };
  return {
    mode, repositoryRoot, policy, basePolicy, headPolicy, changeIntent, changeIntentSource, governanceGrant,
    trustedGovernancePaths, trustedAuthorizer, readFile: cachedReadFile, documents,
    enforcementMode: enforcement.mode, enforcement,
    diff: { files: { all: allFiles, checked: checkedFiles, skippedOperational: allFiles.filter((file) => !checkedFiles.includes(file)) } },
    anchors: extractAnchors(policy, options), integration: extractIntegration(policy, options), trackedFiles: resolvedTrackedFiles,
    derived: {
      changedPaths: checkedFiles.map((file) => file.path),
      touchedSurfaces: policy.surfaces ? detectTouchedSurfaces(checkedFiles, policy.surfaces) : null,
      newFileClasses: policy.new_file_classes ? classifyNewFiles(checkedFiles, policy.new_file_classes) : null,
    },
    diagnostics: { ...diagnostics, skippedOperationalFiles: allFiles.length - checkedFiles.length },
  };
}
