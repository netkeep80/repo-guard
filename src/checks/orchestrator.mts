import { createDefaultRuleRegistry } from "./default-rule-families.mjs";
import type { RuleRegistry } from "./rule-registry.mjs";

export interface PolicyCheckReporter {
  report(name: string, check: unknown): unknown;
}

export interface PolicyCheckOptions extends Record<string, unknown> {
  registry?: RuleRegistry;
}

export function runPolicyChecks(facts: unknown, reporter: PolicyCheckReporter, options: PolicyCheckOptions = {}): void {
  const registry = options.registry || createDefaultRuleRegistry();

  for (const entry of registry.evaluate(facts, options)) {
    reporter.report(entry.name, entry.check);
  }
}
