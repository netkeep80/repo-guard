export function uniqueSorted<T>(values: readonly T[] = []): T[] {
  return [...new Set(values)].sort();
}

export function formatList(values: readonly unknown[] | null | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "(none)";
}
