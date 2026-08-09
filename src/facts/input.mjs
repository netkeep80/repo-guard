import { execFileSync } from "node:child_process";
import { classifyNewFiles, detectTouchedSurfaces } from "../diff/classification.mjs";
import { filterOperationalPaths } from "../diff/filters.mjs";
import { parseDiff } from "../diff/parser.mjs";
import { extractAnchors } from "../extractors/anchors.mjs";
import { extractIntegration } from "../extractors/integration.mjs";
import { readRepositoryBufferFile } from "../utils/repository-files.mjs";

export function listTrackedFiles(repoRoot) {
  return execFileSync("git", ["ls-files"], { encoding: "utf-8", cwd: repoRoot }).split(/\r?\n/).filter(Boolean);
}

export function buildPolicyFacts(input) {
  const {
    mode = "check-diff", repositoryRoot, policy, basePolicy = null, headPolicy = null,
    contract = null, contractSource = "none", issueAuthorization = null,
    trustedGovernancePaths = null, trustedAuthorizer = null, enforcement, diffText,
    trackedFiles = null, diagnostics = {}, readFile = null,
  } = input;
  const allFiles = parseDiff(diffText);
  const checkedFiles = filterOperationalPaths(allFiles, policy.paths.operational_paths);
  const resolvedTrackedFiles = trackedFiles || listTrackedFiles(repositoryRoot);
  const cache = new Map();
  const cachedReadFile = (path) => {
    if (!cache.has(path)) cache.set(path, readRepositoryBufferFile(path, { repoRoot: repositoryRoot, readFile }));
    return cache.get(path);
  };
  const options = { repoRoot: repositoryRoot, trackedFiles: resolvedTrackedFiles, changedFiles: checkedFiles, readFile: cachedReadFile };
  const touchedSurfaces = policy.surfaces ? detectTouchedSurfaces(checkedFiles, policy.surfaces) : null;
  const newFileClasses = policy.new_file_classes ? classifyNewFiles(checkedFiles, policy.new_file_classes) : null;

  return {
    mode, repositoryRoot, policy, basePolicy, headPolicy, contract, contractSource,
    issueAuthorization, trustedGovernancePaths, trustedAuthorizer,
    readFile: cachedReadFile, enforcementMode: enforcement.mode, enforcement,
    diff: {
      files: {
        all: allFiles,
        checked: checkedFiles,
        skippedOperational: allFiles.filter((file) => !checkedFiles.includes(file)),
      },
    },
    anchors: extractAnchors(policy, options),
    integration: extractIntegration(policy, options),
    trackedFiles: resolvedTrackedFiles,
    derived: {
      changedPaths: checkedFiles.map((file) => file.path),
      touchedSurfaces,
      newFileClasses,
    },
    diagnostics: {
      ...diagnostics,
      skippedOperationalFiles: allFiles.length - checkedFiles.length,
    },
  };
}
