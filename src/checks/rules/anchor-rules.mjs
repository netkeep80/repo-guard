import { checkAnchorExtraction } from "../../extractors/anchors.mjs";

export const anchorExtractionRuleFamily = {
  id: "anchor-extraction",
  applies: (facts) => Boolean(facts.policy.anchors),
  evaluate: (facts) => ({ name: "anchor-extraction", check: checkAnchorExtraction(facts.anchors) }),
};
