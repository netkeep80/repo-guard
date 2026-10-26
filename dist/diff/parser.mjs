function statusFromGit(code) {
    if (code === "A")
        return "added";
    if (code === "D")
        return "deleted";
    if (["M", "R", "C", "T"].includes(code))
        return "modified";
    throw new Error(`unsupported git diff status "${code}"`);
}
export function parseNameStatusZ(output) {
    const fields = output.split("\0");
    if (fields.at(-1) === "")
        fields.pop();
    const files = [];
    for (let index = 0; index < fields.length;) {
        const rawStatus = fields[index++];
        if (!rawStatus || !/^[ACDMRTXU][0-9]*$/.test(rawStatus)) {
            throw new Error(`malformed git --name-status -z record at field ${index - 1}`);
        }
        const code = rawStatus[0];
        if (code === "U" || code === "X")
            throw new Error(`unsupported git diff status "${rawStatus}"`);
        const firstPath = fields[index++];
        if (firstPath === undefined || firstPath === "")
            throw new Error(`missing path for git diff status "${rawStatus}"`);
        if (code === "R" || code === "C") {
            const secondPath = fields[index++];
            if (secondPath === undefined || secondPath === "")
                throw new Error(`missing destination path for git diff status "${rawStatus}"`);
            files.push({ path: secondPath, previousPath: firstPath, addedLines: [], deletedLines: [], status: statusFromGit(code) });
            continue;
        }
        files.push({ path: firstPath, ...(code === "T" ? { gitStatus: "T" } : {}), addedLines: [], deletedLines: [], status: statusFromGit(code) });
    }
    return files;
}