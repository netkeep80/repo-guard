export interface RuleEntry {
  name: string;
  check: unknown;
}

export interface NormalizedRuleEntry extends RuleEntry {
  family: string;
}

export interface RuleFamily<Facts = unknown, Context = Record<string, unknown>> {
  id: string;
  applies?: (facts: Facts, context: Context) => unknown;
  evaluate: (facts: Facts, context: Context) => RuleEntry | readonly RuleEntry[] | null | undefined | false;
}

export interface RuleRegistry<Facts = unknown, Context = Record<string, unknown>> {
  register(family: unknown): RuleRegistry<Facts, Context>;
  list(): string[];
  evaluate(facts: Facts, context?: Context): NormalizedRuleEntry[];
}

function assertRuleFamily(family: unknown): asserts family is RuleFamily {
  if (!family || typeof family !== "object") {
    throw new TypeError("rule family must be an object");
  }
  if (!("id" in family) || !family.id || typeof family.id !== "string") {
    throw new TypeError("rule family requires a string id");
  }
  if (!("evaluate" in family) || typeof family.evaluate !== "function") {
    throw new TypeError(`rule family "${family.id}" requires an evaluate function`);
  }
}

function normalizeRuleEntries(family: RuleFamily, entries: ReturnType<RuleFamily["evaluate"]>): NormalizedRuleEntry[] {
  const list = Array.isArray(entries) ? entries : [entries];
  return list
    .filter(Boolean)
    .map((entry) => {
      if (!entry.name || !entry.check) {
        throw new TypeError(`rule family "${family.id}" returned an invalid rule entry`);
      }
      return {
        family: family.id,
        name: entry.name,
        check: entry.check,
      };
    });
}

export function createRuleRegistry<Facts = unknown, Context = Record<string, unknown>>(): RuleRegistry<Facts, Context> {
  const families: RuleFamily[] = [];
  const ids = new Set<string>();

  return {
    register(family: unknown) {
      assertRuleFamily(family);
      if (ids.has(family.id)) {
        throw new Error(`rule family "${family.id}" is already registered`);
      }
      families.push(family);
      ids.add(family.id);
      return this;
    },

    list() {
      return families.map((family) => family.id);
    },

    evaluate(facts: Facts, context = {} as Context) {
      return families.flatMap((family) => {
        if (family.applies && !family.applies(facts, context)) return [];
        return normalizeRuleEntries(family, family.evaluate(facts, context));
      });
    },
  };
}
