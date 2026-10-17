const key = (s) => [s.repository, s.requirementId, s.digest].join("\0");
const valid = (s) => {
    if (!s || typeof s !== "object")
        return false;
    const v = s;
    return v.kind === "semantic_requirement" && typeof v.repository === "string" &&
        typeof v.requirementId === "string" && typeof v.digest === "string" && /^[0-9a-f]{64}$/.test(v.digest) &&
        Object.keys(v).sort().join(",") === "digest,kind,repository,requirementId";
};
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
export function evaluateRootedRequirements(input) {
    const errors = [];
    const universe = input.requirements;
    if (!universe.ok)
        errors.push(...universe.errors.map(e => ({ code: "invalid_canonical_universe", requirement: e.path })));
    const ids = Object.keys(universe.index).sort();
    const rooted = new Set();
    const paths = new Map();
    const parents = new Map();
    for (const id of ids) {
        const node = universe.index[id], relations = obj(obj(node.value)?.relations);
        const targets = [];
        for (const label of Object.keys(relations || {}).sort()) {
            const item = obj(relations[label]);
            if (!item || item.predicate !== "derives_from")
                continue;
            const target = obj(item.target);
            if (!target || target.kind !== "requirement" || typeof target.id !== "string") {
                errors.push({ code: "invalid_provenance_target", requirement: id, target: label });
                continue;
            }
            if (!Object.hasOwn(universe.index, target.id))
                errors.push({ code: "missing_requirement_target", requirement: id, target: target.id });
            else
                targets.push(target.id);
        }
        parents.set(id, [...new Set(targets)].sort());
    }
    const roots = [...input.trustedRoots].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    for (const subject of roots) {
        if (!valid(subject)) {
            errors.push({ code: "invalid_trusted_root", requirement: "" });
            continue;
        }
        const present = universe.index[subject.requirementId];
        if (!present || key(present.semantic) !== key(subject)) {
            errors.push({ code: "missing_or_stale_trusted_root", requirement: subject.requirementId });
            continue;
        }
        rooted.add(subject.requirementId);
        paths.set(subject.requirementId, [subject.requirementId]);
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const id of ids) {
            const possibilities = (parents.get(id) || []).filter(p => rooted.has(p))
                .map(p => [...(paths.get(p) || []), id]).sort((a, b) => a.length - b.length || a.join("\0").localeCompare(b.join("\0")));
            if (!possibilities.length)
                continue;
            const best = possibilities[0], prior = paths.get(id);
            if (!prior || best.length < prior.length || (best.length === prior.length && best.join("\0") < prior.join("\0"))) {
                rooted.add(id);
                paths.set(id, best);
                changed = true;
            }
        }
    }
    const unrooted = ids.filter(id => !rooted.has(id));
    const explanations = Object.fromEntries([...paths.entries()].sort(([a], [b]) => a.localeCompare(b)));
    errors.sort((a, b) => a.requirement.localeCompare(b.requirement) || a.code.localeCompare(b.code) || (a.target || "").localeCompare(b.target || ""));
    return { ok: errors.length === 0 && unrooted.length === 0, rooted: [...rooted].sort(), unrooted, errors, explanations };
}
