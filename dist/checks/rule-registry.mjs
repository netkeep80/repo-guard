function isExecutionPhase(value) {
    return value === "transaction" || value === "state" || value === "both";
}
function assertRuleFamily(family) {
    if (!family || typeof family !== "object") {
        throw new TypeError("rule family must be an object");
    }
    if (!family.id || typeof family.id !== "string") {
        throw new TypeError("rule family requires a string id");
    }
    if (!isExecutionPhase(family.phase)) {
        throw new TypeError(`rule family "${family.id}" requires phase transaction, state, or both`);
    }
    if (typeof family.evaluate !== "function") {
        throw new TypeError(`rule family "${family.id}" requires an evaluate function`);
    }
}
function requestedExecutionPhase(context) {
    if (!context || typeof context !== "object" || !("executionPhase" in context))
        return "both";
    const phase = context.executionPhase;
    if (phase === undefined)
        return "both";
    if (!isExecutionPhase(phase)) {
        throw new TypeError("execution phase must be transaction, state, or both");
    }
    return phase;
}
function appliesToExecutionPhase(family, requested) {
    return requested === "both" || family.phase === "both" || family.phase === requested;
}
function normalizeRuleEntries(family, entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    return list
        .filter(Boolean)
        .map((entry) => {
        if (!entry.name || !entry.check) {
            throw new TypeError(`rule family "${family.id}" returned an invalid rule entry`);
        }
        return {
            family: family.id,
            name: entry.name,
            check: entry.check,
        };
    });
}
export function createRuleRegistry() {
    const families = [];
    const ids = new Set();
    return {
        register(family) {
            assertRuleFamily(family);
            if (ids.has(family.id)) {
                throw new Error(`rule family "${family.id}" is already registered`);
            }
            families.push(family);
            ids.add(family.id);
            return this;
        },
        list() {
            return families.map((family) => family.id);
        },
        evaluate(facts, context = {}) {
            const executionPhase = requestedExecutionPhase(context);
            return families.flatMap((family) => {
                if (!appliesToExecutionPhase(family, executionPhase))
                    return [];
                if (family.applies && !family.applies(facts, context))
                    return [];
                return normalizeRuleEntries(family, family.evaluate(facts, context));
            });
        },
    };
}
