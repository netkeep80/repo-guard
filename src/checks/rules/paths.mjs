import { selectPaths } from "../../diff/classification.mjs";

export function checkForbiddenPaths(files, forbidden) {
  return selectPaths(files, forbidden, { excludeStatuses: ["deleted"] });
}

export const forbiddenPathsRuleFamily = {
  id: "forbidden-paths",
  evaluate(facts) {
    const files = checkForbiddenPaths(facts.diff.files.checked, facts.policy.paths.forbidden);
    return { name: "forbidden-paths", check: { ok: files.length === 0, files } };
  },
};
