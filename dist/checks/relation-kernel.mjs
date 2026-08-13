const set = (values = []) => new Set(values);
export function compareSets(left = [], right = [], relation = "equal") {
    const l = set(left), r = set(right);
    const missing = left.filter((value) => !r.has(value));
    const extra = right.filter((value) => !l.has(value));
    const ok = relation === "left_subset" ? !missing.length
        : relation === "right_subset" ? !extra.length
            : !missing.length && !extra.length;
    return { ok, missing, extra };
}
export const implies = (trigger, evidence) => !trigger || Boolean(evidence);
export const maxBound = (actual, max) => max === undefined || actual <= max;
