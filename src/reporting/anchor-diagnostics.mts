import type { AnchorInstance, AnchorTypeConfig } from "../extractors/anchors.mjs";
import type { buildPolicyFacts } from "../facts/input.mjs";

const CHANGE_INTENT_ANCHOR_FIELDS = ["affects", "implements", "verifies"] as const;

type ChangeIntentAnchorField = typeof CHANGE_INTENT_ANCHOR_FIELDS[number];
type RepositoryFacts = ReturnType<typeof buildPolicyFacts>;
type AnchorTypeStats = { detected: number; changed: number };
type ChangeIntentProjection = {
  anchors?: Partial<Record<ChangeIntentAnchorField, unknown>>;
};

function cloneAnchorInstance(instance: AnchorInstance): AnchorInstance {
  return { ...instance };
}

function sortedUnique(values: readonly unknown[] | null | undefined): string[] {
  return [...new Set((values || []).map((value) => String(value)))].sort();
}

function groupByType(anchorTypes: Readonly<Record<string, AnchorTypeConfig>> | null | undefined, instances: { detected: AnchorInstance[]; changed: AnchorInstance[] }): Record<string, AnchorTypeStats> {
  const byType: Record<string, AnchorTypeStats> = {};
  for (const anchorType of Object.keys(anchorTypes || {}).sort()) {
    byType[anchorType] = { detected: 0, changed: 0 };
  }
  for (const instance of instances.detected) {
    if (!byType[instance.anchorType]) byType[instance.anchorType] = { detected: 0, changed: 0 };
    byType[instance.anchorType].detected++;
  }
  for (const instance of instances.changed) {
    if (!byType[instance.anchorType]) byType[instance.anchorType] = { detected: 0, changed: 0 };
    byType[instance.anchorType].changed++;
  }
  return byType;
}

function declaredChangeIntentAnchors(changeIntent: unknown) {
  const changeIntentAnchors = (changeIntent as ChangeIntentProjection | null | undefined)?.anchors || {};
  const declared: Partial<Record<ChangeIntentAnchorField, string[]>> & { all?: Array<{ relation: ChangeIntentAnchorField; value: string }> } = {};
  const all: Array<{ relation: ChangeIntentAnchorField; value: string }> = [];

  for (const field of CHANGE_INTENT_ANCHOR_FIELDS) {
    const values = sortedUnique(changeIntentAnchors[field] as readonly unknown[] | null | undefined);
    declared[field] = values;
    for (const value of values) {
      all.push({ relation: field, value });
    }
  }

  declared.all = all;
  return declared as Record<ChangeIntentAnchorField, string[]> & { all: Array<{ relation: ChangeIntentAnchorField; value: string }> };
}

export function buildAnchorDiagnostics(facts: RepositoryFacts) {
  if (!facts.policy.anchors) return {};

  const detected = (facts.anchors?.instances || []).map(cloneAnchorInstance);
  const changedPaths = new Set(facts.derived.changedPaths || []);
  const changed = detected
    .filter((instance) => changedPaths.has(instance.file))
    .map(cloneAnchorInstance);
  const declaredByChangeIntent = declaredChangeIntentAnchors(facts.changeIntent);

  return {
    anchors: {
      detected,
      changed,
      declaredByChangeIntent,
      stats: {
        detected: detected.length,
        changed: changed.length,
        declaredByChangeIntent: declaredByChangeIntent.all.length,
        extractionErrors: (facts.anchors?.errors || []).length,
        byType: groupByType(facts.policy.anchors.types, { detected, changed }),
      },
    },
  };
}
