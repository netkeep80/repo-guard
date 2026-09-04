import { execFileSync } from "node:child_process";
import { createDocumentReader } from "../document-facts.mjs";
import { classifyNewFiles, detectTouchedSurfaces } from "../diff/classification.mjs";
import { filterOperationalPaths } from "../diff/filters.mjs";
import { parseDiff } from "../diff/parser.mjs";
import { extractAnchors } from "../extractors/anchors.mjs";
import { extractIntegration } from "../extractors/integration.mjs";
import { readFileAtRef as readGitFileAtRef } from "../git.mjs";
import { readRepositoryBufferFile } from "../utils/repository-files.mjs";
export const listTrackedFiles = (repoRoot) => execFileSync("git", ["ls-files"], { encoding: "utf-8", cwd: repoRoot }).split(/\r?\n/).filter(Boolean);
export function buildPolicyFacts(input) {
    const { mode = "check-diff", repositoryRoot, policy, basePolicy = null, headPolicy = null, baseRef = null, headRef = null, changeIntent = null, changeIntentSource = "none", governanceGrant = null, trustedGovernancePaths = null, trustedAuthorizer = null, enforcement, diffText, trackedFiles = null, diagnostics = {}, readFile = null, readFileAtRef = null, } = input;
    const allFiles = parseDiff(diffText);
    const checkedFiles = filterOperationalPaths(allFiles, policy.paths.operational_paths);
    const resolvedTrackedFiles = trackedFiles || listTrackedFiles(repositoryRoot), cache = new Map();
    const cachedReadFile = (path) => {
        if (!cache.has(path))
            cache.set(path, readRepositoryBufferFile(path, { repoRoot: repositoryRoot, readFile }));
        return cache.get(path);
    };
    const snapshotReadFile = readFileAtRef || ((ref, path) => readGitFileAtRef(ref, path, repositoryRoot));
    const documents = createDocumentReader({ repoRoot: repositoryRoot, readFile: cachedReadFile });
    const options = { repoRoot: repositoryRoot, trackedFiles: resolvedTrackedFiles, changedFiles: checkedFiles, readFile: cachedReadFile, documents };
    return {
        mode, repositoryRoot, policy, basePolicy, headPolicy, baseRef, headRef, changeIntent, changeIntentSource, governanceGrant,
        trustedGovernancePaths, trustedAuthorizer, readFile: cachedReadFile, readFileAtRef: snapshotReadFile, documents,
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
