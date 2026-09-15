import { createDefaultRuleRegistry } from "./default-rule-families.mjs";
export function runPolicyChecks(facts, reporter, options = {}) {
    const registry = options.registry || createDefaultRuleRegistry();
    // Повторный proposed-policy проход использует тот же registry, но не должен повторно
    // выполнять transition/trust rules, авторитет которых принадлежит trusted base policy.
    for (const entry of registry.evaluate(facts, options))
        reporter.report(entry.name, entry.check);
}
