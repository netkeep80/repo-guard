import { selectPaths } from "../../diff/classification.mjs";

export function checkMustTouch(files, mustTouch) {
  if (!mustTouch?.length) return { ok: true };
  const changed = files.map((file) => file.path);
  const satisfied = selectPaths(files, mustTouch).length > 0;
  return {
    ok: satisfied,
    must_touch: mustTouch,
    changed,
    hint: satisfied ? undefined : "must_touch uses any-of semantics: at least one pattern must match a changed file",
  };
}

export function checkMustNotTouch(files, mustNotTouch) {
  if (!mustNotTouch?.length) return { ok: true };
  const touched = selectPaths(files, mustNotTouch);
  return { ok: touched.length === 0, touched, must_not_touch: mustNotTouch };
}

export const contractRuleFamily = {
  id: "contract-rules",
  applies: (facts) => Boolean(facts.contract),
  evaluate(facts) {
    const files = facts.diff.files.checked;
    return [
      { name: "must-touch", check: checkMustTouch(files, facts.contract.must_touch) },
      { name: "must-not-touch", check: checkMustNotTouch(files, facts.contract.must_not_touch) },
    ];
  },
};
