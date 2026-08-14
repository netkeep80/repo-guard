import type { AnchorInstance, AnchorTypeConfig } from "../extractors/anchors.mjs";
import type { buildPolicyFacts } from "../facts/input.mjs";
import { buildTraceRuleDiagnostics } from "../checks/trace-rules.mjs";

const CHANGE_INTENT_ANCHOR_FIELDS = ["affects", "implements", "verifies"] as const;

type ChangeIntentAnchorField = typeof CHANGE_INTENT_ANCHOR_FIELDS[number];
type RepositoryFacts = ReturnType<typeof buildPolicyFacts>;
type TraceFacts = Parameters<typeof buildTraceRuleDiagnostics>[0];
type AnchorTypeStats = { detected: number; changed: number };
type TraceResultProjection = {
  id: string;
  kind: string;
  fromAnchorType?: string;
  toAnchorType?: string;
  unresolved?: Array<{ value: string; instances?: AnchorInstance[] }>;
};
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

function flattenUnresolved(traceRuleResults: ReturnType<typeof buildTraceRuleDiagnostics>) {
  const unresolved: Array<{ rule: string; kind: string; fromAnchorType?: string; toAnchorType?: string; value: string; instances?: AnchorInstance[] }> = [];
  for (const result of traceRuleResults as TraceResultProjection[]) {
    for (const item of result.unresolved || []) {
      unresolved.push({
        rule: result.id,
        kind: result.kind,
        fromAnchorType: result.fromAnchorType,
        toAnchorType: result.toAnchorType,
        value: item.value,
        instances: item.instances,
      });
    }
  }
  return unresolved;
}

export function buildAnchorDiagnostics(facts: RepositoryFacts) {
  const traceRuleResults = buildTraceRuleDiagnostics(facts as unknown as TraceFacts);
  if (!facts.policy.anchors) {
    return traceRuleResults.length > 0 ? { traceRuleResults } : {};
  }

  const detected = (facts.anchors?.instances || []).map(cloneAnchorInstance);
  const changedPaths = new Set(facts.derived.changedPaths || []);
  const changed = detected
    .filter((instance) => changedPaths.has(instance.file))
    .map(cloneAnchorInstance);
  const declaredByChangeIntent = declaredChangeIntentAnchors(facts.changeIntent);
  const unresolved = flattenUnresolved(traceRuleResults);

  return {
    anchors: {
      detected,
      changed,
      declaredByChangeIntent,
      unresolved,
      stats: {
        detected: detected.length,
        changed: changed.length,
        declaredByChangeIntent: declaredByChangeIntent.all.length,
        unresolved: unresolved.length,
        extractionErrors: (facts.anchors?.errors || []).length,
        byType: groupByType(facts.policy.anchors.types, { detected, changed }),
      },
    },
    traceRuleResults,
  };
}
