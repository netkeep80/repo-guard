import { advisoryTextRuleFamily } from "./rules/advisory-text-rules.mjs";
import { anchorExtractionRuleFamily, traceRuleFamily } from "./rules/anchor-rules.mjs";
import { changeProfileRuleFamily } from "./rules/change-profiles.mjs";
import { constraintRuleFamily } from "./rules/constraints.mjs";
import { contentRuleFamily } from "./rules/content-rules.mjs";
import { governancePathsRuleFamily } from "./rules/governance-paths.mjs";
import { policyRelaxationRuleFamily } from "./rules/policy-delta-rules.mjs";
import { registryRuleFamily } from "./rules/registry-rules.mjs";
import { sizeRuleFamily } from "./rules/size-rules.mjs";
import { createRuleRegistry } from "./rule-registry.mjs";

export const defaultRuleFamilies = [
  constraintRuleFamily,
  governancePathsRuleFamily,
  policyRelaxationRuleFamily,
  sizeRuleFamily,
  registryRuleFamily,
  advisoryTextRuleFamily,
  anchorExtractionRuleFamily,
  traceRuleFamily,
  changeProfileRuleFamily,
  contentRuleFamily,
];

export function createDefaultRuleRegistry() {
  const registry = createRuleRegistry();
  for (const family of defaultRuleFamilies) registry.register(family);
  return registry;
}
