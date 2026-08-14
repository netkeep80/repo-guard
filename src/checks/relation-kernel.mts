export type SetRelation = "equal" | "left_subset" | "right_subset";

export interface SetComparisonResult<T> {
  ok: boolean;
  missing: T[];
  extra: T[];
}

const set = <T,>(values: readonly T[] = []): Set<T> => new Set(values);

export function compareSets<T>(left: readonly T[] = [], right: readonly T[] = [], relation: SetRelation = "equal"): SetComparisonResult<T> {
  const l = set(left), r = set(right);
  const missing = left.filter((value) => !r.has(value));
  const extra = right.filter((value) => !l.has(value));
  const ok = relation === "left_subset" ? !missing.length
    : relation === "right_subset" ? !extra.length
      : !missing.length && !extra.length;
  return { ok, missing, extra };
}

export const implies = (trigger: unknown, evidence: unknown): boolean => !trigger || Boolean(evidence);
export const maxBound = (actual: number, max: number | undefined): boolean => max === undefined || actual <= max;
