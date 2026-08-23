import { createDefaultRuleRegistry } from "./default-rule-families.mjs";
import type { ExecutionPhase, RuleRegistry } from "./rule-registry.mjs";

export interface PolicyCheckReporter {
  report(name: string, check: unknown): unknown;
}

export interface PolicyCheckOptions extends Record<string, unknown> {
  registry?: RuleRegistry;
  excludeFamilies?: readonly string[];
  executionPhase?: ExecutionPhase;
}

export function runPolicyChecks(facts: unknown, reporter: PolicyCheckReporter, options: PolicyCheckOptions = {}): void {
  const registry = options.registry || createDefaultRuleRegistry();
  const excludedFamilies = new Set(options.excludeFamilies || []);

  // Повторный proposed-policy проход использует тот же registry, но не должен повторно
  // выполнять transition/trust rules, авторитет которых принадлежит trusted base policy.
  for (const entry of registry.evaluate(facts, options)) {
    if (excludedFamilies.has(entry.family)) continue;
    reporter.report(entry.name, entry.check);
  }
}
