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
        files.push({ path: firstPath, addedLines: [], deletedLines: [], status: statusFromGit(code) });
    }
    return files;
}
export function parseDiff(diffText) {
    const files = [];
    let current = null;
    for (const line of diffText.split("\n")) {
        if (line.startsWith("diff --git")) {
            if (current)
                files.push(current);
            const match = line.match(/diff --git a\/.+ b\/(.+)/);
            current = { path: match ? match[1] : "", addedLines: [], deletedLines: [], status: "modified" };
            continue;
        }
        if (!current)
            continue;
        if (line.startsWith("new file"))
            current.status = "added";
        else if (line.startsWith("deleted file"))
            current.status = "deleted";
        else if (line.startsWith("rename from "))
            current.previousPath = line.slice("rename from ".length);
        else if (line.startsWith("rename to "))
            current.path = line.slice("rename to ".length);
        else if (line.startsWith("+") && !line.startsWith("+++"))
            current.addedLines.push(line.slice(1));
        else if (line.startsWith("-") && !line.startsWith("---"))
            current.deletedLines.push(line.slice(1));
    }
    if (current)
        files.push(current);
    return files;
}
export function mergeDiffIdentity(diffText, identity) {
    const content = parseDiff(diffText);
    if (content.length !== identity.length) {
        throw new Error(`git diff identity/content mismatch: ${identity.length} identity record(s), ${content.length} patch record(s)`);
    }
    return identity.map((file, index) => ({
        ...file,
        addedLines: content[index].addedLines,
        deletedLines: content[index].deletedLines,
    }));
}
export function parseMachineDiff(diffText, nameStatusZ) {
    return mergeDiffIdentity(diffText, parseNameStatusZ(nameStatusZ));
}
