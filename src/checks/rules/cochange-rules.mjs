import { selectPaths } from "../../diff/classification.mjs";

export function checkCochangeRules(files, rules = []) {
  return rules.flatMap((rule) =>
    selectPaths(files, rule.if_changed).length > 0 && selectPaths(files, rule.must_change_any).length === 0
      ? [{ if_changed: rule.if_changed, must_change_any: rule.must_change_any }]
      : []);
}

export const cochangeRuleFamily = {
  id: "cochange-rules",
  evaluate(facts) {
    const violations = checkCochangeRules(facts.diff.files.checked, facts.policy.cochange_rules);
    if (violations.length === 0) return { name: "cochange-rules", check: { ok: true } };
    return violations.map((violation) => ({
      name: `cochange: ${violation.if_changed.join(",")} -> ${violation.must_change_any.join(",")}`,
      check: { ok: false, must_touch: violation.must_change_any },
    }));
  },
};
