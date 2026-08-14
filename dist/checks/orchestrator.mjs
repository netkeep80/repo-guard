import { createDefaultRuleRegistry } from "./default-rule-families.mjs";
export function runPolicyChecks(facts, reporter, options = {}) {
    const registry = options.registry || createDefaultRuleRegistry();
    const excludedFamilies = new Set(options.excludeFamilies || []);
    // Повторный proposed-policy проход использует тот же registry, но не должен повторно
    // выполнять transition/trust rules, авторитет которых принадлежит trusted base policy.
    for (const entry of registry.evaluate(facts, options)) {
        if (excludedFamilies.has(entry.family))
            continue;
        reporter.report(entry.name, entry.check);
    }
}
