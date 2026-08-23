export type ExecutionPhase = "transaction" | "state" | "both";

export interface RuleEntry {
  name: string;
  check: unknown;
}

export interface NormalizedRuleEntry extends RuleEntry {
  family: string;
}

export interface RuleFamily {
  id: string;
  phase?: ExecutionPhase;
  applies?: (facts: unknown, context: unknown) => unknown;
  evaluate: (facts: unknown, context: unknown) => RuleEntry | readonly RuleEntry[] | null | undefined | false;
}

interface ClassifiedRuleFamily extends RuleFamily {
  phase: ExecutionPhase;
}

export interface RuleRegistry<Facts = unknown, Context = Record<string, unknown>> {
  register(family: unknown): RuleRegistry<Facts, Context>;
  list(): string[];
  evaluate(facts: Facts, context?: Context): NormalizedRuleEntry[];
}

function isExecutionPhase(value: unknown): value is ExecutionPhase {
  return value === "transaction" || value === "state" || value === "both";
}

function assertRuleFamily(family: unknown): asserts family is ClassifiedRuleFamily {
  if (!family || typeof family !== "object") {
    throw new TypeError("rule family must be an object");
  }
  if (!(family as Partial<RuleFamily>).id || typeof (family as Partial<RuleFamily>).id !== "string") {
    throw new TypeError("rule family requires a string id");
  }
  if (!isExecutionPhase((family as Partial<RuleFamily>).phase)) {
    throw new TypeError(`rule family "${(family as Partial<RuleFamily>).id}" requires phase transaction, state, or both`);
  }
  if (typeof (family as Partial<RuleFamily>).evaluate !== "function") {
    throw new TypeError(`rule family "${(family as Partial<RuleFamily>).id}" requires an evaluate function`);
  }
}

function requestedExecutionPhase(context: unknown): ExecutionPhase {
  if (!context || typeof context !== "object" || !("executionPhase" in context)) return "both";
  const phase = (context as { executionPhase?: unknown }).executionPhase;
  if (phase === undefined) return "both";
  if (!isExecutionPhase(phase)) {
    throw new TypeError("execution phase must be transaction, state, or both");
  }
  return phase;
}

function appliesToExecutionPhase(family: ClassifiedRuleFamily, requested: ExecutionPhase): boolean {
  return requested === "both" || family.phase === "both" || family.phase === requested;
}

function normalizeRuleEntries(family: ClassifiedRuleFamily, entries: ReturnType<RuleFamily["evaluate"]>): NormalizedRuleEntry[] {
  const list = Array.isArray(entries) ? entries : [entries];
  return list
    .filter(Boolean)
    .map((entry) => {
      if (!(entry as RuleEntry).name || !(entry as RuleEntry).check) {
        throw new TypeError(`rule family "${family.id}" returned an invalid rule entry`);
      }
      return {
        family: family.id,
        name: (entry as RuleEntry).name,
        check: (entry as RuleEntry).check,
      };
    });
}

export function createRuleRegistry<Facts = unknown, Context = Record<string, unknown>>(): RuleRegistry<Facts, Context> {
  const families: ClassifiedRuleFamily[] = [];
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
      const executionPhase = requestedExecutionPhase(context);
      return families.flatMap((family) => {
        if (!appliesToExecutionPhase(family, executionPhase)) return [];
        if (family.applies && !family.applies(facts, context)) return [];
        return normalizeRuleEntries(family, family.evaluate(facts, context));
      });
    },
  };
}
