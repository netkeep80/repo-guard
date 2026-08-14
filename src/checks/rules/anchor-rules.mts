import type { AnchorExtraction } from "../../extractors/anchors.mjs";
import { checkAnchorExtraction } from "../../extractors/anchors.mjs";
import type { RuleFamily } from "../rule-registry.mjs";

interface AnchorRuleFacts {
  policy: { anchors?: unknown };
  anchors: AnchorExtraction;
}

export const anchorExtractionRuleFamily: RuleFamily = {
  id: "anchor-extraction",
  applies: (facts) => Boolean((facts as AnchorRuleFacts).policy.anchors),
  evaluate: (facts) => ({ name: "anchor-extraction", check: checkAnchorExtraction((facts as AnchorRuleFacts).anchors) }),
};
