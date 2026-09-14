import { matchesAny } from "../utils/path-patterns.mjs";
export function diffFilePathIdentities(file) {
    return file.previousPath ? [file.previousPath, file.path] : [file.path];
}
export function filterOperationalPaths(files, operationalPaths, preservedPaths = []) {
    if (!operationalPaths || operationalPaths.length === 0)
        return files;
    return files.filter((file) => {
        const identities = diffFilePathIdentities(file);
        if (preservedPaths?.length && identities.some((path) => matchesAny(path, preservedPaths)))
            return true;
        return !identities.every((path) => matchesAny(path, operationalPaths));
    });
}
